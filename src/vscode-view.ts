import * as vscode from "vscode";
import type {
  Clock,
  FailureCode,
  SubtitleInput,
  SubtitlePhase,
  SubtitleView,
} from "./contracts.js";

export type SubtitleEditorLookup = (input: SubtitleInput) => vscode.TextEditor | undefined;
export type SubtitleViewTimers = Pick<Clock, "setTimeout" | "clearTimeout">;

/** Failures the reader can act on without leaving the editor are shown beside the code. */
const INLINE_FAILURES: ReadonlySet<FailureCode> = new Set<FailureCode>([
  "selection",
  "inputTooLarge",
  "outputInvalid",
  "outputTooLong",
  "timeout",
  "network",
]);
const FAILURE_DISPLAY_MS = 5_000;

const systemTimers: SubtitleViewTimers = {
  setTimeout: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as number),
};

/** Renders one ephemeral subtitle without changing the document. */
export class VscodeSubtitleView implements SubtitleView {
  private readonly decorationType: vscode.TextEditorDecorationType;
  private currentEditor: vscode.TextEditor | undefined;
  private failureTimer: unknown;
  private disposed = false;

  constructor(
    private readonly lookup: SubtitleEditorLookup,
    private readonly timers: SubtitleViewTimers = systemTimers,
  ) {
    this.decorationType = vscode.window.createTextEditorDecorationType({
      rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
      after: {
        margin: "0 0 0 1em",
        color: new vscode.ThemeColor("editorCodeLens.foreground"),
      },
    });
  }

  show(input: SubtitleInput, text: string, phase: SubtitlePhase): void {
    if (this.disposed) {
      return;
    }
    this.clearFailureTimer();
    this.render(input, phaseText(text, phase), phaseColor(phase));
  }

  clear(): void {
    this.clearFailureTimer();
    if (this.currentEditor) {
      this.currentEditor.setDecorations(this.decorationType, []);
      this.currentEditor = undefined;
    }
    if (!this.disposed) {
      void vscode.commands.executeCommand("setContext", "codeSubtitle.active", false);
    }
  }

  notify(failure: FailureCode, input?: SubtitleInput): void {
    if (this.disposed) {
      return;
    }
    this.clear();
    if (
      input !== undefined &&
      INLINE_FAILURES.has(failure) &&
      this.render(input, failureMessage(failure), new vscode.ThemeColor("editorWarning.foreground"))
    ) {
      this.failureTimer = this.timers.setTimeout(() => {
        this.failureTimer = undefined;
        this.clear();
      }, FAILURE_DISPLAY_MS);
      return;
    }
    void vscode.window.showWarningMessage(failureMessage(failure));
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.clear();
    this.disposed = true;
    this.decorationType.dispose();
  }

  /** Draw text at the request's anchor line; returns false when no editor or line is available. */
  private render(input: SubtitleInput, displayText: string, color: vscode.ThemeColor): boolean {
    const editor = this.lookup(input);
    if (!editor) {
      this.clear();
      return false;
    }

    if (this.currentEditor && this.currentEditor !== editor) {
      this.currentEditor.setDecorations(this.decorationType, []);
    }

    const anchor = this.anchor(editor, input.anchorLine);
    if (!anchor) {
      this.clear();
      return false;
    }

    const range = new vscode.Range(anchor, anchor);
    editor.setDecorations(this.decorationType, [
      {
        range,
        renderOptions: {
          after: {
            contentText: `↳ ${displayText}`,
            color,
          },
        },
      },
    ]);
    this.currentEditor = editor;
    void vscode.commands.executeCommand("setContext", "codeSubtitle.active", true);
    return true;
  }

  private clearFailureTimer(): void {
    if (this.failureTimer === undefined) {
      return;
    }
    this.timers.clearTimeout(this.failureTimer);
    this.failureTimer = undefined;
  }

  private anchor(editor: vscode.TextEditor, line: number): vscode.Position | undefined {
    if (line < 0 || line >= editor.document.lineCount) {
      return undefined;
    }
    return editor.document.lineAt(line).range.end;
  }
}

function phaseText(text: string, phase: SubtitlePhase): string {
  if (phase === "preparing") {
    return "Generating…";
  }
  if (phase === "streaming") {
    return text.length === 0 ? "Generating…" : `${text} …`;
  }
  return text;
}

/** Progress states share a neutral color; `editorWarning.foreground` is reserved for failures. */
function phaseColor(phase: SubtitlePhase): vscode.ThemeColor {
  if (phase === "visible") {
    return new vscode.ThemeColor("editorHint.foreground");
  }
  return new vscode.ThemeColor("editorCodeLens.foreground");
}

function failureMessage(failure: FailureCode): string {
  switch (failure) {
    case "selection":
      return "Select code, or put the cursor on a non-empty line, to show a subtitle.";
    case "inputTooLarge":
      return "The selection is too large. Narrow it and try again.";
    case "outputInvalid":
      return "The model returned an empty or unsupported subtitle. Try again.";
    case "outputTooLong":
      return "The generated subtitle is too long. Try a smaller selection.";
    case "modelUnavailable":
      return "No language model is available for Code Subtitle.";
    case "accessDenied":
      return "Model access was not granted. Try again after access is allowed.";
    case "blocked":
      return "The model is unavailable or its quota is exhausted.";
    case "timeout":
      return "The subtitle request timed out. Try again.";
    case "network":
      return "The subtitle request failed. Try again.";
    default:
      return "The subtitle request could not be completed.";
  }
}
