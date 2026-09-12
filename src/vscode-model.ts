import type * as vscode from "vscode";
import type {
  FittedRequest,
  ModelGateway,
  ModelIdentity,
  PreparedRequest,
  SubtitleError,
  SubtitleInput,
} from "./contracts.js";
import { SubtitleError as SubtitleErrorClass } from "./contracts.js";
import { buildPrompt } from "./policy.js";

const COPILOT_VENDOR = "copilot";

export interface FitInput {
  (
    input: SubtitleInput,
    countTokens: (text: string) => Promise<number>,
    maxInputTokens: number,
    signal: AbortSignal,
  ): Promise<{ input: SubtitleInput; prompt: string }>;
}

export interface VscodeModelRuntime {
  selectChatModels(
    selector?: vscode.LanguageModelChatSelector,
  ): Thenable<vscode.LanguageModelChat[]>;
  userMessage(content: string): vscode.LanguageModelChatMessage;
  createCancellationTokenSource(): vscode.CancellationTokenSource;
}

export interface VscodeModelAccess {
  canSendRequest(model: vscode.LanguageModelChat): boolean | undefined;
}

export interface ModelPickerItem extends vscode.QuickPickItem {
  readonly modelId: string;
  /** Vendor-qualified identity used to disambiguate models from different providers. */
  readonly modelKey?: string;
  readonly modelVendor?: string;
}

export interface VscodeModelPicker {
  showQuickPick(
    items: readonly ModelPickerItem[],
    options: vscode.QuickPickOptions,
    token?: vscode.CancellationToken,
  ): Thenable<ModelPickerItem | undefined>;
}

/** Remembers the vendor-qualified model chosen for `codeSubtitle.model: "auto"` across sessions. */
export interface ModelChoiceStore {
  get(): string | undefined;
  set(id: string | undefined): PromiseLike<void> | void;
}

export interface VscodeModelGatewayOptions {
  readonly runtime: VscodeModelRuntime;
  readonly access: VscodeModelAccess;
  readonly picker: VscodeModelPicker;
  readonly fitInput: FitInput;
  readonly modelSetting?: string;
  /**
   * Provider-specific request options forwarded as `modelOptions`. Production
   * passes nothing; the live evaluation harness uses this for experiments.
   */
  readonly modelOptions?: Record<string, unknown>;
  readonly choiceStore?: ModelChoiceStore;
}

/** Adapts VS Code Language Model API providers to the core gateway. */
export class VscodeModelGateway implements ModelGateway {
  private modelSetting: string;
  private selectedModel: vscode.LanguageModelChat | undefined;
  private disposed = false;

  constructor(private readonly options: VscodeModelGatewayOptions) {
    this.modelSetting = normalizeModelSetting(options.modelSetting);
  }

  async prepare(input: SubtitleInput, signal: AbortSignal): Promise<PreparedRequest> {
    this.ensureActive();
    throwIfAborted(signal);

    const model = await this.resolveModel(signal);
    throwIfAborted(signal);

    const access = this.options.access.canSendRequest(model);
    if (access === false) {
      throw new SubtitleErrorClass("accessDenied");
    }

    const identity: ModelIdentity = {
      vendor: model.vendor,
      id: model.id,
      version: model.version,
    };
    // Evidence collection and token counting are deferred to `fit`, so a cache
    // hit keyed on the pre-enrichment input pays for neither.
    let fitted: FittedRequest | undefined;
    const fit = async (fitSignal: AbortSignal): Promise<FittedRequest> => {
      if (fitted !== undefined) {
        return fitted;
      }
      throwIfAborted(fitSignal);
      const result = await this.options.fitInput(
        input,
        (text) => this.countTokens(model, text, fitSignal),
        model.maxInputTokens,
        fitSignal,
      );
      throwIfAborted(fitSignal);
      fitted = { input: result.input, prompt: result.prompt };
      return fitted;
    };
    return {
      input,
      model: identity,
      prompt: buildPrompt(input),
      alreadyAuthorized: access === true,
      fit,
      stream: async (streamSignal) => {
        const result = await fit(streamSignal);
        return this.startStream(model, result.prompt, streamSignal);
      },
    };
  }

  setModelSetting(value: string): void {
    const next = normalizeModelSetting(value);
    if (next === this.modelSetting) {
      return;
    }
    this.modelSetting = next;
    this.invalidate();
  }

  invalidate(): void {
    this.selectedModel = undefined;
  }

  /**
   * Re-open the picker regardless of the stored choice and remember the result.
   * Returns the chosen model ID, or undefined when the user dismissed the picker.
   */
  async chooseModel(signal: AbortSignal): Promise<string | undefined> {
    this.ensureActive();
    const models = await this.selectAutoModels(signal);
    if (models.length === 0) {
      throw new SubtitleErrorClass("modelUnavailable");
    }
    const selected = await this.pickModel(models, signal);
    if (selected === undefined) {
      return undefined;
    }
    await this.rememberChoice(modelKey(selected));
    if (this.modelSetting === "auto") {
      this.selectedModel = selected;
    }
    return selected.id;
  }

  dispose(): void {
    this.disposed = true;
    this.invalidate();
  }

  private async resolveModel(signal: AbortSignal): Promise<vscode.LanguageModelChat> {
    if (this.selectedModel) {
      return this.selectedModel;
    }

    let selected: vscode.LanguageModelChat | undefined;
    if (this.modelSetting !== "auto") {
      const configured = parseConfiguredModel(this.modelSetting);
      if (configured === undefined) {
        throw new SubtitleErrorClass("modelUnavailable");
      }
      const models = await this.selectModels(configured, signal);
      selected = models.find(
        (model) => model.vendor === configured.vendor && model.id === configured.id,
      );
      if (!selected) {
        throw new SubtitleErrorClass("modelUnavailable");
      }
    } else {
      const models = await this.selectAutoModels(signal);
      if (models.length === 0) {
        throw new SubtitleErrorClass("modelUnavailable");
      }
      const stored = this.options.choiceStore?.get();
      const storedKey = storedModelKey(stored);
      selected =
        storedKey === undefined ? undefined : models.find((model) => modelKey(model) === storedKey);
      if (!selected) {
        selected = await this.pickModel(models, signal);
        if (!selected) {
          throw abortError();
        }
        await this.rememberChoice(modelKey(selected));
      }
    }

    this.selectedModel = selected;
    return selected;
  }

  private async pickModel(
    models: vscode.LanguageModelChat[],
    signal: AbortSignal,
  ): Promise<vscode.LanguageModelChat | undefined> {
    const items = models.map((model) => ({
      label: model.name || model.id,
      description: modelKey(model),
      modelId: model.id,
      modelKey: modelKey(model),
      modelVendor: model.vendor,
    }));
    const pickerSource = this.options.runtime.createCancellationTokenSource();
    const stopPicker = bridgeAbort(signal, pickerSource);
    let choice: ModelPickerItem | undefined;
    try {
      choice = await this.options.picker.showQuickPick(
        items,
        {
          canPickMany: false,
          placeHolder: "Choose a language model for Code Subtitle",
          ignoreFocusOut: true,
        },
        pickerSource.token,
      );
    } finally {
      stopPicker();
    }
    throwIfAborted(signal);
    if (!choice) {
      return undefined;
    }
    const selected = choice.modelKey
      ? models.find((model) => modelKey(model) === choice.modelKey)
      : models.find(
          (model) =>
            model.id === choice.modelId &&
            (choice.modelVendor === undefined || model.vendor === choice.modelVendor),
        );
    if (!selected) {
      throw new SubtitleErrorClass("modelUnavailable");
    }
    return selected;
  }

  private async rememberChoice(id: string): Promise<void> {
    try {
      await this.options.choiceStore?.set(id);
    } catch {
      // A failed write only means the picker appears again after a restart.
    }
  }

  private async selectAutoModels(signal: AbortSignal): Promise<vscode.LanguageModelChat[]> {
    const copilotModels = await this.selectModels({ vendor: COPILOT_VENDOR }, signal);
    if (copilotModels.length > 0) {
      return copilotModels;
    }
    return this.selectModels(undefined, signal);
  }

  private async selectModels(
    selector: vscode.LanguageModelChatSelector | undefined,
    signal: AbortSignal,
  ): Promise<vscode.LanguageModelChat[]> {
    try {
      const result = await this.options.runtime.selectChatModels(selector);
      throwIfAborted(signal);
      return result;
    } catch (error: unknown) {
      if (isAbortLike(error) || signal.aborted) {
        throw error;
      }
      throw toSubtitleError(error, "modelUnavailable");
    }
  }

  private async countTokens(
    model: vscode.LanguageModelChat,
    text: string,
    signal: AbortSignal,
  ): Promise<number> {
    throwIfAborted(signal);
    const source = this.options.runtime.createCancellationTokenSource();
    const stop = bridgeAbort(signal, source);
    try {
      return await model.countTokens(this.options.runtime.userMessage(text), source.token);
    } catch (error: unknown) {
      const safeError = toSubtitleError(error, "network");
      if (safeError.code === "modelUnavailable") {
        this.invalidate();
      }
      throw safeError;
    } finally {
      stop();
    }
  }

  private async startStream(
    model: vscode.LanguageModelChat,
    prompt: string,
    signal: AbortSignal,
  ): Promise<AsyncIterable<string>> {
    throwIfAborted(signal);
    const source = this.options.runtime.createCancellationTokenSource();
    const stop = bridgeAbort(signal, source);
    try {
      const requestOptions: vscode.LanguageModelChatRequestOptions = {
        justification: "Explain the explicitly selected code with a short subtitle.",
      };
      if (this.options.modelOptions !== undefined) {
        requestOptions.modelOptions = this.options.modelOptions;
      }
      const response = await model.sendRequest(
        [this.options.runtime.userMessage(prompt)],
        requestOptions,
        source.token,
      );
      throwIfAborted(signal);
      return disposeAfterStream(response.text, stop, (error) => {
        const safeError = toSubtitleError(error, "network");
        if (safeError.code === "modelUnavailable") {
          this.invalidate();
        }
        return safeError;
      });
    } catch (error: unknown) {
      stop();
      const safeError = toSubtitleError(error, "network");
      if (safeError.code === "modelUnavailable") {
        this.invalidate();
      }
      throw safeError;
    }
  }

  private ensureActive(): void {
    if (this.disposed) {
      throw new SubtitleErrorClass("modelUnavailable");
    }
  }
}

async function disposeAfterStream(
  sourceStream: AsyncIterable<string>,
  dispose: () => void,
  mapError: (error: unknown) => Error,
): Promise<AsyncIterable<string>> {
  return (async function* (): AsyncGenerator<string> {
    try {
      for await (const chunk of sourceStream) {
        yield chunk;
      }
    } catch (error: unknown) {
      throw mapError(error);
    } finally {
      dispose();
    }
  })();
}

function bridgeAbort(signal: AbortSignal, source: vscode.CancellationTokenSource): () => void {
  let disposed = false;
  const onAbort = (): void => {
    source.cancel();
    dispose();
  };
  const dispose = (): void => {
    if (disposed) {
      return;
    }
    disposed = true;
    signal.removeEventListener("abort", onAbort);
    source.dispose();
  };
  if (signal.aborted) {
    onAbort();
  } else {
    signal.addEventListener("abort", onAbort, { once: true });
  }
  return dispose;
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw abortError();
  }
}

function normalizeModelSetting(value: string | undefined): string {
  return value?.trim() || "auto";
}

function parseConfiguredModel(value: string): vscode.LanguageModelChatSelector | undefined {
  const separator = value.indexOf(":");
  if (separator < 0) {
    return value.length === 0 ? undefined : { vendor: COPILOT_VENDOR, id: value };
  }

  const vendor = value.slice(0, separator).trim();
  const id = value.slice(separator + 1).trim();
  return vendor.length === 0 || id.length === 0 ? undefined : { vendor, id };
}

function modelKey(model: { readonly vendor: string; readonly id: string }): string {
  return `${model.vendor}:${model.id}`;
}

function storedModelKey(value: string | undefined): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  const parsed = parseConfiguredModel(trimmed);
  return parsed?.id === undefined ? undefined : `${parsed.vendor}:${parsed.id}`;
}

function abortError(): Error {
  const error = new Error("aborted");
  error.name = "AbortError";
  return error;
}

function isAbortLike(error: unknown): boolean {
  return (
    typeof error === "object" && error !== null && "name" in error && error.name === "AbortError"
  );
}

function toSubtitleError(error: unknown, fallback: "modelUnavailable" | "network"): SubtitleError {
  if (error instanceof SubtitleErrorClass) {
    return error;
  }
  if (isAbortLike(error)) {
    return new SubtitleErrorClass("network");
  }
  const code =
    typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
  if (code === "NoPermissions") {
    return new SubtitleErrorClass("accessDenied");
  }
  if (code === "Blocked") {
    return new SubtitleErrorClass("blocked");
  }
  if (code === "NotFound") {
    return new SubtitleErrorClass("modelUnavailable");
  }
  return new SubtitleErrorClass(fallback);
}
