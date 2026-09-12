import * as vscode from "vscode";
import { createInput, fitInput, type InputSnapshot } from "./policy.js";
import { SubtitleError, type SelectionRange, type SubtitleInput } from "./contracts.js";
import { MemorySubtitleCache } from "./cache.js";
import { SubtitleSession } from "./session.js";
import {
  VscodeModelGateway,
  type ModelChoiceStore,
  type VscodeModelGatewayOptions,
} from "./vscode-model.js";
import { VscodeSubtitleView } from "./vscode-view.js";
import { VscodeSemanticContextProvider } from "./vscode-semantic.js";

const DISCLOSURE_KEY = "codeSubtitle.semanticContextDisclosureShown";
const AUTO_MODEL_KEY = "codeSubtitle.autoModelId";

interface ActiveRequest {
  readonly input: SubtitleInput;
  readonly editor: vscode.TextEditor;
  /** The editor selection when the command ran; it may be an empty cursor widened to a line. */
  readonly selection: SelectionRange;
  readonly modelSetting: string;
  readonly outputLanguage: string;
  readonly semanticContext: boolean;
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

  const semanticEnabled = (): boolean =>
    vscode.workspace.getConfiguration("codeSubtitle").get<boolean>("semanticContext", true);
  const semanticProvider = new VscodeSemanticContextProvider(vscode);

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
  const choiceStore: ModelChoiceStore = {
    get: () => context.globalState.get<string>(AUTO_MODEL_KEY),
    set: (id) => context.globalState.update(AUTO_MODEL_KEY, id),
  };
  const gateway = new VscodeModelGateway({
    runtime,
    access: context.languageModelAccessInformation,
    picker: {
      showQuickPick: (items, options, token) => vscode.window.showQuickPick(items, options, token),
    },
    choiceStore,
    fitInput: async (input, countTokens, maxTokens, signal) => {
      const enriched = semanticEnabled()
        ? { ...input, semanticContext: await semanticProvider.collect(input, signal) }
        : input;
      return fitInput(enriched, countTokens, maxTokens, signal);
    },
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
      !sameEditorSelection(editor, active.selection) ||
      outputLanguage(editor.document) !== active.outputLanguage ||
      semanticEnabled() !== active.semanticContext ||
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
    // Inline failure guidance outlives the session's request, so clear the view directly.
    view.clear();
  };

  const invalidateSource = (uri: vscode.Uri): void => {
    const documentUri = uri.toString();
    session.invalidateDocument(documentUri);
    const workspaceId = semanticEnabled()
      ? vscode.workspace.getWorkspaceFolder(uri)?.uri.toString()
      : undefined;
    if (workspaceId) session.invalidateWorkspace(workspaceId);
    if (
      activeRequest?.input.documentUri === documentUri ||
      (workspaceId !== undefined && activeRequest?.input.workspaceId === workspaceId)
    ) {
      activeRequest = undefined;
      view.clear();
    }
  };

  const show = async (): Promise<void> => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      dismissActive();
      view.notify("selection");
      return;
    }

    const id = editorId(editor);
    const selections = editor.selections.map(toSelectionRange);
    const snapshot: InputSnapshot = {
      text: editor.document.getText(),
      selections: targetRanges(editor.document, selections),
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
      selection: selections[0] ?? input.range,
      modelSetting: currentModelSetting,
      outputLanguage: snapshot.outputLanguage,
      semanticContext: semanticEnabled(),
    };
    showFirstUseDisclosure(context);
    await session.show(input);
  };

  const chooseModel = async (): Promise<void> => {
    let chosen: string | undefined;
    try {
      chosen = await gateway.chooseModel(new AbortController().signal);
    } catch (error: unknown) {
      view.notify(error instanceof SubtitleError ? error.code : "modelUnavailable");
      return;
    }
    if (chosen === undefined) {
      return;
    }
    // Results from the previous model are no longer reused, as with a model setting change.
    activeRequest = undefined;
    session.clearCache();
    if (modelSetting() !== "auto") {
      void vscode.window.showInformationMessage(
        "Code Subtitle remembered the model, but the codeSubtitle.model setting takes precedence until it is set to auto.",
      );
    }
  };

  const commands = [
    vscode.commands.registerCommand("codeSubtitle.show", show),
    vscode.commands.registerCommand("codeSubtitle.dismiss", dismissActive),
    vscode.commands.registerCommand("codeSubtitle.clearCache", () => {
      activeRequest = undefined;
      session.clearCache();
    }),
    vscode.commands.registerCommand("codeSubtitle.chooseModel", chooseModel),
  ];
  context.subscriptions.push(...commands);

  const sourceWatcher = vscode.workspace.createFileSystemWatcher("**/*");
  const invalidateDiskSource = (uri: vscode.Uri): void => {
    if (semanticEnabled()) invalidateSource(uri);
  };
  context.subscriptions.push(
    sourceWatcher,
    sourceWatcher.onDidChange(invalidateDiskSource),
    sourceWatcher.onDidCreate(invalidateDiskSource),
    sourceWatcher.onDidDelete(invalidateDiskSource),
  );

  context.subscriptions.push(
    vscode.window.onDidChangeTextEditorSelection((event) => {
      if (
        activeRequest &&
        event.textEditor === activeRequest.editor &&
        !sameEditorSelection(event.textEditor, activeRequest.selection)
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
      invalidateSource(event.document.uri);
    }),
    vscode.workspace.onDidCloseTextDocument((document) => {
      const uri = document.uri.toString();
      invalidateSource(document.uri);
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
        !event.affectsConfiguration("codeSubtitle.model") &&
        !event.affectsConfiguration("codeSubtitle.semanticContext") &&
        !semanticEnabled()
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
    "Code Subtitle sends the selection, nearby lines, and optional language-service type/docs and same-workspace definition excerpts to VS Code's model. Disable semantic context in Code Subtitle settings to send only the selection and nearby lines.",
  );
}

/** An empty cursor targets its whole line; anything else is submitted as selected. */
function targetRanges(document: vscode.TextDocument, selections: SelectionRange[]): SelectionRange[] {
  const only = selections[0];
  if (selections.length !== 1 || only === undefined || !isEmptyRange(only)) {
    return selections;
  }
  const line = only.start.line;
  return [
    {
      start: { line, character: 0 },
      end: { line, character: document.lineAt(line).text.length },
    },
  ];
}

function isEmptyRange(range: SelectionRange): boolean {
  return range.start.line === range.end.line && range.start.character === range.end.character;
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
