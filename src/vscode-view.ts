import * as vscode from "vscode";
import type { FailureCode, SubtitleInput, SubtitlePhase, SubtitleView } from "./contracts.js";

export type SubtitleEditorLookup = (input: SubtitleInput) => vscode.TextEditor | undefined;

/** Renders one ephemeral subtitle without changing the document. */
export class VscodeSubtitleView implements SubtitleView {
  private readonly decorationType: vscode.TextEditorDecorationType;
  private currentEditor: vscode.TextEditor | undefined;
  private disposed = false;

  constructor(private readonly lookup: SubtitleEditorLookup) {
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

    const editor = this.lookup(input);
    if (!editor) {
      this.clear();
      return;
    }

    if (this.currentEditor && this.currentEditor !== editor) {
      this.currentEditor.setDecorations(this.decorationType, []);
    }

    const anchor = this.anchor(editor, input.anchorLine);
    if (!anchor) {
      this.clear();
      return;
    }

    const displayText = phaseText(text, phase);
    const color = phaseColor(phase);
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
  }

  clear(): void {
    if (this.currentEditor) {
      this.currentEditor.setDecorations(this.decorationType, []);
      this.currentEditor = undefined;
    }
    if (!this.disposed) {
      void vscode.commands.executeCommand("setContext", "codeSubtitle.active", false);
    }
  }

  notify(failure: FailureCode): void {
    this.clear();
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

function phaseColor(phase: SubtitlePhase): vscode.ThemeColor {
  if (phase === "preparing") {
    return new vscode.ThemeColor("editorWarning.foreground");
  }
  if (phase === "streaming") {
    return new vscode.ThemeColor("editorCodeLens.foreground");
  }
  return new vscode.ThemeColor("editorHint.foreground");
}

function failureMessage(failure: FailureCode): string {
  switch (failure) {
    case "selection":
      return "Select one non-empty range to show a subtitle.";
    case "inputTooLarge":
      return "The selection is too large. Narrow it and try again.";
    case "outputInvalid":
      return "The subtitle could not be shown. Try a smaller selection.";
    case "modelUnavailable":
      return "No Copilot model is available for Code Subtitle.";
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
