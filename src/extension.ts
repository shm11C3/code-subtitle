import * as vscode from "vscode";
import { createInput, fitInput, type InputSnapshot } from "./policy.js";
import { SubtitleError, type SelectionRange, type SubtitleInput } from "./contracts.js";
import { MemorySubtitleCache } from "./cache.js";
import { SubtitleSession } from "./session.js";
import { VscodeModelGateway, type VscodeModelGatewayOptions } from "./vscode-model.js";
import { VscodeSubtitleView } from "./vscode-view.js";

const DISCLOSURE_KEY = "codeSubtitle.firstUseDisclosureShown";

interface ActiveRequest {
  readonly input: SubtitleInput;
  readonly editor: vscode.TextEditor;
  readonly modelSetting: string;
  readonly outputLanguage: string;
}

interface ExtensionRuntime {
  readonly session: SubtitleSession;
  readonly gateway: VscodeModelGateway;
  readonly view: VscodeSubtitleView;
  dispose(): void;
}

let activeRuntime: ExtensionRuntime | undefined;

export function activate(context: vscode.ExtensionContext): void {
  activeRuntime?.dispose();

  const editorIds = new WeakMap<vscode.TextEditor, string>();
  const editorsById = new Map<string, vscode.TextEditor>();
  let nextEditorId = 0;
  let activeRequest: ActiveRequest | undefined;

  const editorId = (editor: vscode.TextEditor): string => {
    const existing = editorIds.get(editor);
    if (existing) {
      return existing;
    }
    const created = `editor-${++nextEditorId}`;
    editorIds.set(editor, created);
    editorsById.set(created, editor);
    return created;
  };

  const outputLanguage = (document: vscode.TextDocument): string => {
    const configured = vscode.workspace
      .getConfiguration("codeSubtitle", document.uri)
      .get<string>("outputLanguage", "auto");
    return configured === "auto" || configured.trim().length === 0
      ? vscode.env.language
      : configured;
  };

  const modelSetting = (): string => {
    const configured = vscode.workspace
      .getConfiguration("codeSubtitle")
      .get<string>("model", "auto");
    return configured.trim().length === 0 ? "auto" : configured.trim();
  };

  const lookupEditor = (input: SubtitleInput): vscode.TextEditor | undefined => {
    const editor = editorsById.get(input.editorId);
    if (!editor || editor.document.uri.toString() !== input.documentUri) {
      return undefined;
    }
    return editor;
  };

  const runtime: VscodeModelGatewayOptions["runtime"] = {
    selectChatModels: (selector) => vscode.lm.selectChatModels(selector),
    userMessage: (content) => vscode.LanguageModelChatMessage.User(content),
    createCancellationTokenSource: () => new vscode.CancellationTokenSource(),
  };
  const gateway = new VscodeModelGateway({
    runtime,
    access: context.languageModelAccessInformation,
    picker: {
      showQuickPick: (items, options, token) => vscode.window.showQuickPick(items, options, token),
    },
    fitInput,
    modelSetting: modelSetting(),
  });
  const view = new VscodeSubtitleView(lookupEditor);
  const cache = new MemorySubtitleCache();

  const isCurrent = (input: SubtitleInput): boolean => {
    const active = activeRequest;
    if (
      !active ||
      !sameInput(active.input, input) ||
      active.editor !== vscode.window.activeTextEditor
    ) {
      return false;
    }

    const editor = active.editor;
    if (
      editor.document.uri.toString() !== input.documentUri ||
      editor.document.version !== input.documentVersion ||
      !sameEditorSelection(editor, input.range) ||
      outputLanguage(editor.document) !== active.outputLanguage ||
      modelSetting() !== active.modelSetting
    ) {
      return false;
    }
    return isVisible(editor, input.anchorLine);
  };

  const session = new SubtitleSession({ gateway, view, cache, isCurrent });

  const dismissActive = (): void => {
    activeRequest = undefined;
    session.dismiss();
  };

  const show = async (): Promise<void> => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      dismissActive();
      view.notify("selection");
      return;
    }

    const id = editorId(editor);
    const snapshot: InputSnapshot = {
      text: editor.document.getText(),
      selections: editor.selections.map(toSelectionRange),
      documentUri: editor.document.uri.toString(),
      documentVersion: editor.document.version,
      editorId: id,
      workspaceId: vscode.workspace.getWorkspaceFolder(editor.document.uri)?.uri.toString(),
      languageId: editor.document.languageId,
      outputLanguage: outputLanguage(editor.document),
    };

    let input: SubtitleInput;
    try {
      input = createInput(snapshot);
    } catch (error: unknown) {
      dismissActive();
      view.notify(error instanceof SubtitleError ? error.code : "selection");
      return;
    }

    const currentModelSetting = modelSetting();
    gateway.setModelSetting(currentModelSetting);
    activeRequest = {
      input,
      editor,
      modelSetting: currentModelSetting,
      outputLanguage: snapshot.outputLanguage,
    };
    showFirstUseDisclosure(context);
    await session.show(input);
  };

  const commands = [
    vscode.commands.registerCommand("codeSubtitle.show", show),
    vscode.commands.registerCommand("codeSubtitle.dismiss", dismissActive),
    vscode.commands.registerCommand("codeSubtitle.clearCache", () => {
      activeRequest = undefined;
      session.clearCache();
    }),
  ];
  context.subscriptions.push(...commands);

  context.subscriptions.push(
    vscode.window.onDidChangeTextEditorSelection((event) => {
      if (
        activeRequest &&
        event.textEditor === activeRequest.editor &&
        !sameEditorSelection(event.textEditor, activeRequest.input.range)
      ) {
        dismissActive();
      }
    }),
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      if (activeRequest && editor !== activeRequest.editor) {
        dismissActive();
      }
    }),
    vscode.window.onDidChangeTextEditorVisibleRanges((event) => {
      if (
        activeRequest &&
        event.textEditor === activeRequest.editor &&
        !isVisible(event.textEditor, activeRequest.input.anchorLine)
      ) {
        dismissActive();
      }
    }),
    vscode.workspace.onDidChangeTextDocument((event) => {
      const uri = event.document.uri.toString();
      session.invalidateDocument(uri);
      if (activeRequest?.input.documentUri === uri) {
        activeRequest = undefined;
      }
    }),
    vscode.workspace.onDidCloseTextDocument((document) => {
      const uri = document.uri.toString();
      session.invalidateDocument(uri);
      if (activeRequest?.input.documentUri === uri) {
        activeRequest = undefined;
      }
      for (const [id, editor] of editorsById) {
        if (editor.document.uri.toString() === uri) {
          editorsById.delete(id);
        }
      }
    }),
    vscode.workspace.onDidChangeWorkspaceFolders((event) => {
      for (const folder of event.removed) {
        const workspaceId = folder.uri.toString();
        session.invalidateWorkspace(workspaceId);
        if (activeRequest?.input.workspaceId === workspaceId) {
          activeRequest = undefined;
        }
      }
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (
        !event.affectsConfiguration("codeSubtitle.outputLanguage") &&
        !event.affectsConfiguration("codeSubtitle.model")
      ) {
        return;
      }
      gateway.setModelSetting(modelSetting());
      activeRequest = undefined;
      session.clearCache();
    }),
    vscode.lm.onDidChangeChatModels(() => {
      gateway.invalidate();
      activeRequest = undefined;
      session.clearCache();
    }),
  );

  const extensionRuntime: ExtensionRuntime = {
    session,
    gateway,
    view,
    dispose: () => {
      activeRequest = undefined;
      session.dispose();
      gateway.dispose();
      view.dispose();
      for (const [id] of editorsById) {
        editorsById.delete(id);
      }
    },
  };
  activeRuntime = extensionRuntime;
  context.subscriptions.push(new vscode.Disposable(() => extensionRuntime.dispose()));
}

export function deactivate(): void {
  activeRuntime?.dispose();
  activeRuntime = undefined;
}

function showFirstUseDisclosure(context: vscode.ExtensionContext): void {
  if (context.globalState.get<boolean>(DISCLOSURE_KEY, false)) {
    return;
  }
  void context.globalState.update(DISCLOSURE_KEY, true);
  void vscode.window.showInformationMessage(
    "Code Subtitle sends the selection and up to 5 lines before and after it to VS Code's model.",
  );
}

function toSelectionRange(selection: vscode.Selection): SelectionRange {
  return {
    start: { line: selection.start.line, character: selection.start.character },
    end: { line: selection.end.line, character: selection.end.character },
  };
}

function sameEditorSelection(editor: vscode.TextEditor, range: SubtitleInput["range"]): boolean {
  return (
    editor.selections.length === 1 && sameRange(toSelectionRange(editor.selections[0]!), range)
  );
}

function sameInput(left: SubtitleInput, right: SubtitleInput): boolean {
  return (
    left.documentUri === right.documentUri &&
    left.documentVersion === right.documentVersion &&
    left.editorId === right.editorId &&
    left.workspaceId === right.workspaceId &&
    sameRange(left.range, right.range) &&
    left.anchorLine === right.anchorLine &&
    left.languageId === right.languageId &&
    left.outputLanguage === right.outputLanguage &&
    left.selection === right.selection &&
    left.before === right.before &&
    left.after === right.after
  );
}

function sameRange(left: SelectionRange, right: SelectionRange): boolean {
  return (
    left.start.line === right.start.line &&
    left.start.character === right.start.character &&
    left.end.line === right.end.line &&
    left.end.character === right.end.character
  );
}

function isVisible(editor: vscode.TextEditor, anchorLine: number): boolean {
  return editor.visibleRanges.some(
    (range) => range.start.line <= anchorLine && anchorLine <= range.end.line,
  );
}
