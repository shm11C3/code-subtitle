import {
  displayTtlMs,
  graphemeLength,
  normalizeOutput,
  outputLimit,
  validateOutput,
} from "./policy.js";
import {
  type Clock,
  type FailureCode,
  type ModelGateway,
  type PreparedRequest,
  type SubtitleCache,
  type SubtitleInput,
  type SubtitleObserver,
  type SubtitleTimingEventName,
  type SubtitleView,
  SubtitleError,
} from "./contracts.js";

const STREAM_BATCH_DELAY_MS = 50;
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_RAW_STREAM_UNITS = 16_000;
const CANCELLED = Symbol("cancelled");

type Cancelled = typeof CANCELLED;

interface ActiveRequest {
  readonly id: number;
  readonly input: SubtitleInput;
  readonly controller: AbortController;
  promise: Promise<void>;
  lifecycle: "running" | "visible" | "cancelled" | "expired";
  prepared?: PreparedRequest;
  rawText: string;
  pendingText?: string;
  hasRenderedText: boolean;
  requestTimer?: unknown;
  flushTimer?: unknown;
  expiryTimer?: unknown;
}

export interface SubtitleSessionOptions {
  gateway: ModelGateway;
  view: SubtitleView;
  cache: SubtitleCache;
  clock?: Clock;
  /** Optional content-free phase timing sink; see minimal design §10. */
  observer?: SubtitleObserver;
  isCurrent: (input: SubtitleInput) => boolean;
}

const systemClock: Clock = {
  // Monotonic so that phase deltas are unaffected by wall-clock adjustments.
  now: () => performance.now(),
  setTimeout: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as number),
};

/** Coordinates one ephemeral subtitle request at a time. */
export class SubtitleSession {
  private readonly gateway: ModelGateway;
  private readonly view: SubtitleView;
  private readonly cache: SubtitleCache;
  private readonly clock: Clock;
  private readonly observer?: SubtitleObserver;
  private readonly isCurrent: (input: SubtitleInput) => boolean;
  private active?: ActiveRequest;
  private nextRequestId = 0;
  private disposed = false;

  constructor(options: SubtitleSessionOptions) {
    this.gateway = options.gateway;
    this.view = options.view;
    this.cache = options.cache;
    this.clock = options.clock ?? systemClock;
    this.observer = options.observer;
    this.isCurrent = options.isCurrent;
  }

  show(input: SubtitleInput): Promise<void> {
    if (this.disposed) {
      return Promise.resolve();
    }

    if (input.selection.trim().length === 0) {
      this.cancelActive();
      this.view.clear();
      this.view.notify("selection", input);
      return Promise.resolve();
    }

    if (
      this.active &&
      this.active.lifecycle !== "cancelled" &&
      this.active.lifecycle !== "expired"
    ) {
      if (this.active.lifecycle === "running" && sameInput(this.active.input, input)) {
        return this.active.promise;
      }
      this.cancelActive(this.active);
    }

    const active: ActiveRequest = {
      id: ++this.nextRequestId,
      input,
      controller: new AbortController(),
      promise: Promise.resolve(),
      lifecycle: "running",
      rawText: "",
      hasRenderedText: false,
    };
    this.active = active;
    this.emit(active, "commandStart");
    active.promise = this.run(active);
    return active.promise;
  }

  dismiss(): void {
    this.cancelActive();
  }

  clearCache(): void {
    this.cache.clear();
    this.cancelActive();
  }

  invalidateDocument(uri: string): void {
    this.cache.invalidateDocument(uri);
    if (this.active?.input.documentUri === uri) {
      this.cancelActive(this.active);
    }
  }

  invalidateWorkspace(workspaceId: string): void {
    this.cache.invalidateWorkspace(workspaceId);
    if (this.active?.input.workspaceId === workspaceId) {
      this.cancelActive(this.active);
    }
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.cancelActive();
    this.cache.clear();
  }

  private async run(active: ActiveRequest): Promise<void> {
    try {
      await this.execute(active);
    } catch (error: unknown) {
      if (!this.isLive(active)) {
        return;
      }
      if (isAbortError(error)) {
        this.cancelActive(active);
        return;
      }
      this.fail(active, failureCode(error));
    } finally {
      this.clearRequestTimer(active);
      this.clearFlushTimer(active);
      if (active.lifecycle === "running") {
        this.cancelActive(active);
      }
    }
  }

  private async execute(active: ActiveRequest): Promise<void> {
    if (!this.isLive(active)) {
      return;
    }

    this.view.show(active.input, "", "preparing");

    const preparedResult = await this.waitForCancellation(
      Promise.resolve().then(() => this.gateway.prepare(active.input, active.controller.signal)),
      active,
    );
    if (preparedResult === CANCELLED || !this.isLive(active)) {
      return;
    }
    active.prepared = preparedResult;
    this.emit(active, "prepared");

    const cached = this.cache.get(preparedResult);
    if (cached !== undefined) {
      this.emit(active, "cacheHit");
      if (!this.isValidOutput(cached, active.input.outputLanguage)) {
        this.fail(active, "outputInvalid");
        return;
      }
      const normalized = normalizeOutput(cached);
      active.lifecycle = "visible";
      this.view.show(active.input, normalized, "visible");
      this.emit(active, "visible");
      this.showUntilExpiry(active, normalized);
      return;
    }

    const fitResult = await this.waitForCancellation(
      Promise.resolve().then(() => preparedResult.fit(active.controller.signal)),
      active,
    );
    if (fitResult === CANCELLED || !this.isLive(active)) {
      return;
    }

    this.emit(active, "requestStart");
    const streamPromise = Promise.resolve().then(() =>
      preparedResult.stream(active.controller.signal),
    );
    if (preparedResult.alreadyAuthorized) {
      this.startRequestTimer(active);
    }
    const streamResult = await this.waitForCancellation(streamPromise, active);
    if (streamResult === CANCELLED || !this.isLive(active)) {
      return;
    }
    if (!preparedResult.alreadyAuthorized) {
      this.startRequestTimer(active);
    }

    const consumed = this.consume(active, streamResult);
    const consumeResult = await this.waitForCancellation(consumed, active);
    if (consumeResult === CANCELLED || active.lifecycle !== "visible") {
      return;
    }
  }

  private async consume(
    active: ActiveRequest,
    stream: AsyncIterable<string>,
  ): Promise<void | Cancelled> {
    for await (const chunk of stream) {
      if (!this.isLive(active)) {
        return CANCELLED;
      }
      if (typeof chunk !== "string") {
        this.fail(active, "outputInvalid");
        return CANCELLED;
      }

      active.rawText += chunk;
      if (active.rawText.length > MAX_RAW_STREAM_UNITS) {
        this.fail(active, "outputTooLong");
        return CANCELLED;
      }
      const partial = normalizeOutput(active.rawText);
      if (graphemeLength(partial) > outputLimit(active.input.outputLanguage)) {
        this.fail(active, "outputTooLong");
        return CANCELLED;
      }
      if (partial.length === 0) {
        continue;
      }

      if (!active.hasRenderedText) {
        active.hasRenderedText = true;
        this.emit(active, "firstFragment");
        this.view.show(active.input, partial, "streaming");
      } else {
        active.pendingText = partial;
        this.scheduleFlush(active);
      }
    }

    if (!this.isLive(active)) {
      return CANCELLED;
    }
    this.emit(active, "streamEnd");

    const completeRaw = active.rawText;
    if (!this.isValidOutput(completeRaw, active.input.outputLanguage)) {
      this.fail(active, "outputInvalid");
      return CANCELLED;
    }
    const complete = normalizeOutput(completeRaw);

    this.clearRequestTimer(active);
    this.clearFlushTimer(active);
    active.pendingText = undefined;
    this.view.show(active.input, complete, "visible");
    this.emit(active, "visible");
    active.lifecycle = "visible";
    if (active.prepared) {
      this.cache.put(active.prepared, complete);
    }
    this.showUntilExpiry(active, complete);
  }

  private isValidOutput(text: string, outputLanguage: string): boolean {
    const normalized = normalizeOutput(text);
    return (
      graphemeLength(normalized) <= outputLimit(outputLanguage) &&
      validateOutput(text, outputLanguage)
    );
  }

  private scheduleFlush(active: ActiveRequest): void {
    if (active.flushTimer !== undefined) {
      return;
    }
    active.flushTimer = this.clock.setTimeout(() => {
      active.flushTimer = undefined;
      if (!this.isLive(active) || active.pendingText === undefined) {
        return;
      }
      const text = active.pendingText;
      active.pendingText = undefined;
      this.view.show(active.input, text, "streaming");
    }, STREAM_BATCH_DELAY_MS);
  }

  private showUntilExpiry(active: ActiveRequest, text: string): void {
    this.clearRequestTimer(active);
    this.clearFlushTimer(active);
    active.expiryTimer = this.clock.setTimeout(() => {
      if (!this.isVisible(active)) {
        return;
      }
      active.lifecycle = "expired";
      this.active = undefined;
      this.view.clear();
      this.emit(active, "cleared");
    }, displayTtlMs(text));
  }

  private startRequestTimer(active: ActiveRequest): void {
    this.clearRequestTimer(active);
    active.requestTimer = this.clock.setTimeout(() => {
      if (this.isLive(active)) {
        this.fail(active, "timeout");
      }
    }, REQUEST_TIMEOUT_MS);
  }

  private clearRequestTimer(active: ActiveRequest): void {
    if (active.requestTimer === undefined) {
      return;
    }
    this.clock.clearTimeout(active.requestTimer);
    active.requestTimer = undefined;
  }

  private clearFlushTimer(active: ActiveRequest): void {
    if (active.flushTimer === undefined) {
      return;
    }
    this.clock.clearTimeout(active.flushTimer);
    active.flushTimer = undefined;
  }

  private cancelActive(active = this.active, failed = false): void {
    if (!active || active.lifecycle === "cancelled" || active.lifecycle === "expired") {
      return;
    }
    active.lifecycle = "cancelled";
    if (!failed) {
      this.emit(active, "cancelled");
    }
    active.controller.abort();
    this.clearRequestTimer(active);
    this.clearFlushTimer(active);
    if (active.expiryTimer !== undefined) {
      this.clock.clearTimeout(active.expiryTimer);
      active.expiryTimer = undefined;
    }
    if (this.active === active) {
      this.active = undefined;
      this.view.clear();
      this.emit(active, "cleared");
    }
  }

  private fail(active: ActiveRequest, code: FailureCode): void {
    const isCurrent = this.active === active;
    if (active.lifecycle !== "cancelled" && active.lifecycle !== "expired") {
      this.observer?.observe({ requestId: active.id, at: this.clock.now(), name: "failed", code });
    }
    this.cancelActive(active, true);
    if (isCurrent && !this.disposed) {
      this.view.notify(code, active.input);
    }
  }

  private emit(active: ActiveRequest, name: SubtitleTimingEventName): void {
    this.observer?.observe({ requestId: active.id, at: this.clock.now(), name });
  }

  private isLive(active: ActiveRequest): boolean {
    if (
      this.disposed ||
      this.active !== active ||
      active.lifecycle !== "running" ||
      active.controller.signal.aborted
    ) {
      return false;
    }
    let current = false;
    try {
      current = this.isCurrent(active.input);
    } catch {
      current = false;
    }
    if (!current) {
      this.cancelActive(active);
      return false;
    }
    return true;
  }

  private isVisible(active: ActiveRequest): boolean {
    if (
      this.disposed ||
      this.active !== active ||
      active.lifecycle !== "visible" ||
      active.controller.signal.aborted
    ) {
      return false;
    }
    let current = false;
    try {
      current = this.isCurrent(active.input);
    } catch {
      current = false;
    }
    if (!current) {
      this.cancelActive(active);
      return false;
    }
    return true;
  }

  private waitForCancellation<T>(work: Promise<T>, active: ActiveRequest): Promise<T | Cancelled> {
    if (active.controller.signal.aborted) {
      void work.catch(() => undefined);
      return Promise.resolve(CANCELLED);
    }

    let removeAbortListener = (): void => undefined;
    const cancelled = new Promise<Cancelled>((resolve) => {
      const onAbort = (): void => resolve(CANCELLED);
      active.controller.signal.addEventListener("abort", onAbort, { once: true });
      removeAbortListener = () => active.controller.signal.removeEventListener("abort", onAbort);
    });

    return Promise.race([work, cancelled]).finally(removeAbortListener);
  }
}

function sameInput(left: SubtitleInput, right: SubtitleInput): boolean {
  return (
    left.documentUri === right.documentUri &&
    left.documentVersion === right.documentVersion &&
    left.editorId === right.editorId &&
    left.workspaceId === right.workspaceId &&
    left.range.start.line === right.range.start.line &&
    left.range.start.character === right.range.start.character &&
    left.range.end.line === right.range.end.line &&
    left.range.end.character === right.range.end.character &&
    left.anchorLine === right.anchorLine &&
    left.languageId === right.languageId &&
    left.outputLanguage === right.outputLanguage &&
    left.selection === right.selection &&
    left.before === right.before &&
    left.after === right.after
  );
}

function failureCode(error: unknown): FailureCode {
  if (error instanceof SubtitleError) {
    return error.code;
  }
  return "network";
}

function isAbortError(error: unknown): boolean {
  return (
    typeof error === "object" && error !== null && "name" in error && error.name === "AbortError"
  );
}
