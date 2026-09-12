import type * as vscode from "vscode";
import type {
  ModelGateway,
  ModelIdentity,
  PreparedRequest,
  SubtitleError,
  SubtitleInput,
} from "./contracts.js";
import { SubtitleError as SubtitleErrorClass } from "./contracts.js";

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
}

export interface VscodeModelPicker {
  showQuickPick(
    items: readonly ModelPickerItem[],
    options: vscode.QuickPickOptions,
    token?: vscode.CancellationToken,
  ): Thenable<ModelPickerItem | undefined>;
}

/** Remembers the model chosen for `codeSubtitle.model: "auto"` across sessions. */
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
  readonly choiceStore?: ModelChoiceStore;
}

/** Adapts the Copilot-only VS Code Language Model API to the core gateway. */
export class VscodeModelGateway implements ModelGateway {
  private modelSetting: string;
  private selectedModel: vscode.LanguageModelChat | undefined;
  private disposed = false;

  constructor(private readonly options: VscodeModelGatewayOptions) {
    this.modelSetting = options.modelSetting ?? "auto";
  }

  async prepare(input: SubtitleInput, signal: AbortSignal): Promise<PreparedRequest> {
    this.ensureActive();
    throwIfAborted(signal);

    const model = await this.resolveModel(signal);
    throwIfAborted(signal);

    const fitted = await this.options.fitInput(
      input,
      (text) => this.countTokens(model, text, signal),
      model.maxInputTokens,
      signal,
    );
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
    return {
      input: fitted.input,
      model: identity,
      prompt: fitted.prompt,
      alreadyAuthorized: access === true,
      stream: (streamSignal) => this.startStream(model, fitted.prompt, streamSignal),
    };
  }

  setModelSetting(value: string): void {
    const next = value.trim() || "auto";
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
    const models = await this.selectModels({ vendor: "copilot" }, signal);
    if (models.length === 0) {
      throw new SubtitleErrorClass("modelUnavailable");
    }
    const selected = await this.pickModel(models, signal);
    if (selected === undefined) {
      return undefined;
    }
    await this.rememberChoice(selected.id);
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

    const selector: vscode.LanguageModelChatSelector = { vendor: "copilot" };
    if (this.modelSetting !== "auto") {
      selector.id = this.modelSetting;
    }
    const models = await this.selectModels(selector, signal);
    throwIfAborted(signal);
    if (models.length === 0) {
      throw new SubtitleErrorClass("modelUnavailable");
    }

    let selected: vscode.LanguageModelChat | undefined;
    if (this.modelSetting !== "auto") {
      selected = models.find((model) => model.id === this.modelSetting);
      if (!selected) {
        throw new SubtitleErrorClass("modelUnavailable");
      }
    } else {
      const stored = this.options.choiceStore?.get();
      selected = stored === undefined ? undefined : models.find((model) => model.id === stored);
      if (!selected) {
        selected = await this.pickModel(models, signal);
        if (!selected) {
          throw abortError();
        }
        await this.rememberChoice(selected.id);
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
      description: model.id,
      modelId: model.id,
    }));
    const pickerSource = this.options.runtime.createCancellationTokenSource();
    const stopPicker = bridgeAbort(signal, pickerSource);
    let choice: ModelPickerItem | undefined;
    try {
      choice = await this.options.picker.showQuickPick(
        items,
        {
          canPickMany: false,
          placeHolder: "Choose a Copilot model for Code Subtitle",
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
    const selected = models.find((model) => model.id === choice.modelId);
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

  private async selectModels(
    selector: vscode.LanguageModelChatSelector,
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
      const response = await model.sendRequest(
        [this.options.runtime.userMessage(prompt)],
        { justification: "Explain the explicitly selected code with a short subtitle." },
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
