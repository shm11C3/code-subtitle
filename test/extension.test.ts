import assert from "node:assert/strict";
import test from "node:test";
import Module from "node:module";
type ActivatedExtension = typeof import("../src/extension.js");

function event<T>() {
  const listeners = new Set<(value: T) => void>();
  return {
    subscribe: (listener: (value: T) => void) => {
      listeners.add(listener);
      return { dispose: () => listeners.delete(listener) };
    },
    fire: (value: T) => {
      for (const listener of listeners) listener(value);
    },
  };
}

/** A VS Code boundary fixture; session, policy, cache, gateway, and view remain real. */
function fixture() {
  const selectionChanged = event<any>();
  const editorChanged = event<any>();
  const visibleChanged = event<any>();
  const documentChanged = event<any>();
  const documentClosed = event<any>();
  const foldersChanged = event<any>();
  const settingsChanged = event<any>();
  const modelsChanged = event<void>();
  const accessChanged = event<void>();
  const commands = new Map<string, (...args: any[]) => any>();
  const notifications: string[] = [];
  const displays: string[] = [];
  let currentText = "";
  let sends = 0;
  let granted = false;
  let holdStream: (() => Promise<void>) | undefined;
  const document = {
    uri: { toString: () => "file:///fixture/example.ts" },
    version: 1,
    languageId: "typescript",
    lineCount: 1,
    getText: () => "return value;",
    lineAt: () => ({ text: "return value;", range: { end: { line: 0, character: 13 } } }),
  };
  const editor = {
    document,
    selections: [{ start: { line: 0, character: 0 }, end: { line: 0, character: 13 } }],
    visibleRanges: [{ start: { line: 0 }, end: { line: 1 } }],
    setDecorations: (_type: unknown, options: any[]) => {
      currentText = options[0]?.renderOptions.after.contentText ?? "";
      displays.push(currentText);
    },
  };
  const model = {
    id: "test-model",
    name: "Test model",
    vendor: "copilot",
    version: "1",
    maxInputTokens: 10000,
    countTokens: async () => 100,
    sendRequest: async () => {
      sends++;
      if (!granted) {
        granted = true;
        accessChanged.fire();
      }
      return {
        text: (async function* () {
          if (holdStream) await holdStream();
          yield "Returns the current value.";
        })(),
      };
    },
  };
  const api: any = {
    env: { language: "en" },
    commands: {
      registerCommand: (name: string, callback: (...args: any[]) => any) => {
        commands.set(name, callback);
        return { dispose: () => commands.delete(name) };
      },
      executeCommand: async (name: string, ...args: any[]) => commands.get(name)?.(...args),
    },
    window: {
      activeTextEditor: editor,
      createTextEditorDecorationType: () => ({ dispose() {} }),
      showWarningMessage: async (message: string) => {
        notifications.push(message);
      },
      showInformationMessage: async () => undefined,
      showQuickPick: async (items: any[]) => items[0],
      onDidChangeTextEditorSelection: selectionChanged.subscribe,
      onDidChangeActiveTextEditor: editorChanged.subscribe,
      onDidChangeTextEditorVisibleRanges: visibleChanged.subscribe,
    },
    workspace: {
      getConfiguration: () => ({ get: (name: string) => (name === "model" ? "test-model" : "en") }),
      getWorkspaceFolder: () => ({ uri: { toString: () => "file:///fixture" } }),
      onDidChangeTextDocument: documentChanged.subscribe,
      onDidCloseTextDocument: documentClosed.subscribe,
      onDidChangeConfiguration: settingsChanged.subscribe,
      onDidChangeWorkspaceFolders: foldersChanged.subscribe,
    },
    lm: { selectChatModels: async () => [model], onDidChangeChatModels: modelsChanged.subscribe },
    LanguageModelChatMessage: { User: (content: string) => ({ role: 1, content }) },
    CancellationTokenSource: class {
      token = { isCancellationRequested: false };
      cancel() {
        this.token.isCancellationRequested = true;
      }
      dispose() {}
    },
    Range: class {
      constructor(
        readonly start: unknown,
        readonly end: unknown,
      ) {}
    },
    ThemeColor: class {
      constructor(readonly id: string) {}
    },
    DecorationRangeBehavior: { ClosedClosed: 0 },
    Disposable: class {
      constructor(readonly dispose: () => void) {}
    },
  };
  const context: any = {
    subscriptions: [],
    globalState: { get: () => false, update: async () => undefined },
    languageModelAccessInformation: {
      canSendRequest: () => (granted ? true : undefined),
      onDidChange: accessChanged.subscribe,
    },
  };
  const loader = Module as unknown as { _load: (...args: any[]) => any };
  const original = loader._load;
  for (const name of ["../src/extension.js", "../src/vscode-view.js"])
    delete require.cache[require.resolve(name)];
  loader._load = function (request: string, ...args: any[]) {
    return request === "vscode" ? api : original.call(this, request, ...args);
  };
  let extension: ActivatedExtension;
  try {
    extension = require("../src/extension.js");
  } finally {
    loader._load = original;
  }
  extension.activate(context);
  return {
    editor,
    document,
    api,
    notifications,
    displays,
    selectionChanged,
    documentChanged,
    foldersChanged,
    get text() {
      return currentText;
    },
    get sends() {
      return sends;
    },
    hold: (wait: () => Promise<void>) => {
      holdStream = wait;
    },
    command: async (name: string) => {
      await commands.get("codeSubtitle." + name)?.();
    },
    dispose: () => {
      extension.deactivate();
      for (const item of context.subscriptions) item.dispose();
    },
  };
}

test("granting first-use model consent still displays the requested subtitle", async () => {
  const app = fixture();
  try {
    await app.command("show");
    assert.equal(app.sends, 1);
    assert.equal(app.text, "↳ Returns the current value.");
    assert.deepEqual(app.notifications, []);
  } finally {
    app.dispose();
  }
});

test("changing selection clears a pending subtitle without sending the new selection", async () => {
  const app = fixture();
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  app.hold(() => held);
  try {
    const running = app.command("show");
    for (let turn = 0; app.sends === 0 && turn < 30; turn++) await Promise.resolve();
    assert.equal(app.sends, 1);
    app.editor.selections = [{ start: { line: 0, character: 0 }, end: { line: 0, character: 6 } }];
    app.selectionChanged.fire({ textEditor: app.editor });
    assert.equal(app.text, "");
    release();
    await running;
    assert.equal(app.text, "");
    assert.equal(app.sends, 1);
    assert.deepEqual(app.notifications, []);
  } finally {
    release();
    app.dispose();
  }
});

test("document edits invalidate a completed cached subtitle through the extension event", async () => {
  const app = fixture();
  try {
    await app.command("show");
    await app.command("show");
    assert.equal(app.sends, 1);
    app.document.version++;
    app.documentChanged.fire({ document: app.document });
    assert.equal(app.text, "");
    await app.command("show");
    assert.equal(app.sends, 2);
  } finally {
    app.dispose();
  }
});

test("removing a workspace folder invalidates its completed subtitle", async () => {
  const app = fixture();
  try {
    await app.command("show");
    app.foldersChanged.fire({
      removed: [{ uri: { toString: () => "file:///fixture" } }],
      added: [],
    });
    assert.equal(app.text, "");
    await app.command("show");
    assert.equal(app.sends, 2);
  } finally {
    app.dispose();
  }
});
