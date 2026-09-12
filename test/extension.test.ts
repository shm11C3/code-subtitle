import assert from "node:assert/strict";
import test from "node:test";
import Module from "node:module";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
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
function fixture(
  options: {
    semanticContext?: boolean;
    response?: string;
    timingLog?: boolean;
    text?: string;
  } = {},
) {
  const sourceText = options.text ?? "return value;";
  const directory = options.semanticContext
    ? mkdtempSync(join(tmpdir(), "subtitle-integration-"))
    : undefined;
  const rootUri = directory ? pathToFileURL(directory).toString() : "file:///fixture";
  const uri = (value: string) => ({
    scheme: new URL(value).protocol.slice(0, -1),
    path: new URL(value).pathname,
    authority: new URL(value).host,
    fsPath: fileURLToPath(value),
    toString: () => value,
  });
  if (directory) writeFileSync(join(directory, "example.ts"), "return value;");
  let semanticEnabled = options.semanticContext ?? false;
  const prompts: string[] = [];
  const providerCalls: string[] = [];
  const selectionChanged = event<any>();
  const editorChanged = event<any>();
  const visibleChanged = event<any>();
  const documentChanged = event<any>();
  const documentClosed = event<any>();
  const foldersChanged = event<any>();
  const settingsChanged = event<any>();
  const modelsChanged = event<void>();
  const accessChanged = event<void>();
  const fileChanged = event<any>();
  const commands = new Map<string, (...args: any[]) => any>();
  const notifications: string[] = [];
  const displays: string[] = [];
  const channels: string[] = [];
  const timingLines: string[] = [];
  let currentText = "";
  let sends = 0;
  let granted = false;
  let holdStream: (() => Promise<void>) | undefined;
  const document = {
    uri: uri(`${rootUri}/example.ts`),
    version: 1,
    languageId: "typescript",
    lineCount: 1,
    getText: () => sourceText,
    lineAt: () => ({ text: sourceText, range: { end: { line: 0, character: sourceText.length } } }),
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
    sendRequest: async (messages: { content: string }[]) => {
      prompts.push(messages[0]!.content);
      sends++;
      if (!granted) {
        granted = true;
        accessChanged.fire();
      }
      return {
        text: (async function* () {
          if (holdStream) await holdStream();
          yield options.response ?? "Returns the current value.";
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
      executeCommand: async (name: string, ...args: any[]) => {
        if (name.startsWith("vscode.execute")) {
          providerCalls.push(name);
          return name === "vscode.executeHoverProvider"
            ? [{ contents: [{ value: "const value: 42" }] }]
            : [];
        }
        return commands.get(name)?.(...args);
      },
    },
    window: {
      activeTextEditor: editor,
      createTextEditorDecorationType: () => ({ dispose() {} }),
      createOutputChannel: (name: string) => {
        channels.push(name);
        return { appendLine: (line: string) => timingLines.push(line), dispose() {} };
      },
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
      getConfiguration: () => ({
        get: (name: string) =>
          name === "semanticContext"
            ? semanticEnabled
            : name === "timingLog"
              ? (options.timingLog ?? false)
              : name === "model"
                ? "test-model"
                : "en",
      }),
      isTrusted: true,
      openTextDocument: async () => document,
      getWorkspaceFolder: () => ({ uri: uri(rootUri) }),
      createFileSystemWatcher: () => ({
        onDidChange: fileChanged.subscribe,
        onDidCreate: fileChanged.subscribe,
        onDidDelete: fileChanged.subscribe,
        dispose() {},
      }),
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
    Position: class {
      constructor(
        readonly line: number,
        readonly character: number,
      ) {}
    },
    Uri: { parse: uri },
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
    channels,
    timingLines,
    selectionChanged,
    visibleChanged,
    documentChanged,
    foldersChanged,
    rootUri,
    providerCalls,
    prompts,
    fileChanged,
    settingsChanged,
    setSemanticContext: (value: boolean) => {
      semanticEnabled = value;
    },
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
      if (directory) rmSync(directory, { recursive: true, force: true });
    },
  };
}

test("unsupported output offers a retry beside the code without blaming the selection size", async () => {
  const app = fixture({ response: "# Unexpected heading" });
  try {
    await app.command("show");
    assert.equal(app.text, "↳ The model returned an empty or unsupported subtitle. Try again.");
    assert.deepEqual(app.notifications, []);
  } finally {
    app.dispose();
  }
});

test("oversized output explains the display limit beside the code", async () => {
  const app = fixture({ response: "a".repeat(401) });
  try {
    await app.command("show");
    assert.equal(app.text, "↳ The generated subtitle is too long. Try a smaller selection.");
    assert.deepEqual(app.notifications, []);
  } finally {
    app.dispose();
  }
});

test("Esc clears an inline failure even though no request is active", async () => {
  const app = fixture({ response: "a".repeat(401) });
  try {
    await app.command("show");
    assert.notEqual(app.text, "");
    await app.command("dismiss");
    assert.equal(app.text, "");
  } finally {
    app.dispose();
  }
});

test("editing the document clears an inline failure", async () => {
  const app = fixture({ response: "a".repeat(401) });
  try {
    await app.command("show");
    assert.notEqual(app.text, "");
    app.document.version++;
    app.documentChanged.fire({ document: app.document });
    assert.equal(app.text, "");
  } finally {
    app.dispose();
  }
});

test("a missing editor still reports the selection failure as a notification", async () => {
  const app = fixture();
  try {
    app.api.window.activeTextEditor = undefined;
    await app.command("show");
    assert.equal(app.text, "");
    assert.equal(app.notifications.length, 1);
  } finally {
    app.dispose();
  }
});

test("an explicit command includes provider evidence in the model request", async () => {
  const app = fixture({ semanticContext: true });
  try {
    await app.command("show");
    assert.equal(app.sends, 1);
    assert.ok(app.providerCalls.includes("vscode.executeHoverProvider"));
    const prompt = app.prompts[0]!;
    const data = JSON.parse(prompt.slice(prompt.lastIndexOf("\n") + 1));
    assert.ok(
      data.semanticContext.some((entry: { text: string }) =>
        entry.text.includes("const value: 42"),
      ),
    );
    assert.ok(!prompt.includes(app.rootUri));
  } finally {
    app.dispose();
  }
});

test("a repeated command reuses the result without provider or model requests", async () => {
  const app = fixture({ semanticContext: true });
  try {
    await app.command("show");
    assert.equal(app.sends, 1);
    const providerCallsAfterFirst = app.providerCalls.length;
    assert.ok(providerCallsAfterFirst > 0);
    await app.command("show");
    assert.equal(app.sends, 1);
    assert.equal(app.providerCalls.length, providerCallsAfterFirst);
    assert.equal(app.text, "↳ Returns the current value.");
  } finally {
    app.dispose();
  }
});

test("workspace dependency edits invalidate semantic results before reuse", async () => {
  const app = fixture({ semanticContext: true });
  try {
    await app.command("show");
    await app.command("show");
    assert.equal(app.sends, 1);
    app.documentChanged.fire({
      document: { uri: app.api.Uri.parse(`${app.rootUri}/dependency.ts`) },
    });
    assert.equal(app.text, "");
    await app.command("show");
    assert.equal(app.sends, 2);
  } finally {
    app.dispose();
  }
});

test("filesystem dependency changes clear semantic results", async () => {
  const app = fixture({ semanticContext: true });
  try {
    await app.command("show");
    app.fileChanged.fire(app.api.Uri.parse(`${app.rootUri}/dependency.ts`));
    assert.equal(app.text, "");
    await app.command("show");
    assert.equal(app.sends, 2);
  } finally {
    app.dispose();
  }
});

test("disabling semantic context clears enriched results and stops provider requests", async () => {
  const app = fixture({ semanticContext: true });
  try {
    await app.command("show");
    const before = app.providerCalls.length;
    app.setSemanticContext(false);
    app.settingsChanged.fire({
      affectsConfiguration: (name: string) => name === "codeSubtitle.semanticContext",
    });
    assert.equal(app.text, "");
    await app.command("show");
    assert.equal(app.sends, 2);
    assert.equal(app.providerCalls.length, before);
    const prompt = app.prompts.at(-1)!;
    const data = JSON.parse(prompt.slice(prompt.lastIndexOf("\n") + 1));
    assert.equal(data.semanticContext, undefined);
  } finally {
    app.dispose();
  }
});

test("language-provider configuration changes invalidate semantic results", async () => {
  const app = fixture({ semanticContext: true });
  try {
    await app.command("show");
    app.settingsChanged.fire({ affectsConfiguration: (name: string) => name === "rust-analyzer" });
    assert.equal(app.text, "");
    await app.command("show");
    assert.equal(app.sends, 2);
  } finally {
    app.dispose();
  }
});

test(
  "a dependency edit while a provider is pending prevents model submission",
  { timeout: 2_000 },
  async () => {
    const app = fixture({ semanticContext: true });
    let enter!: () => void;
    let release!: () => void;
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const execute = app.api.commands.executeCommand;
    app.api.commands.executeCommand = async (name: string, ...args: unknown[]) => {
      if (name === "vscode.executeHoverProvider") {
        enter();
        await held;
      }
      return execute(name, ...args);
    };
    try {
      const running = app.command("show");
      await entered;
      app.documentChanged.fire({
        document: { uri: app.api.Uri.parse(`${app.rootUri}/dependency.ts`) },
      });
      await running;
      assert.equal(app.sends, 0);
      assert.equal(app.text, "");
      release();
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(app.sends, 0);
      assert.deepEqual(app.notifications, []);
    } finally {
      release();
      app.dispose();
    }
  },
);

test("the timing log stays off by default and creates no output channel", async () => {
  const app = fixture();
  try {
    await app.command("show");
    assert.equal(app.text, "↳ Returns the current value.");
    assert.deepEqual(app.channels, []);
    assert.deepEqual(app.timingLines, []);
  } finally {
    app.dispose();
  }
});

test("the timing log records phase timings without any content", async () => {
  const app = fixture({ timingLog: true });
  try {
    await app.command("show");
    assert.deepEqual(app.channels, ["Code Subtitle Timing"]);
    assert.deepEqual(
      app.timingLines.map((line) => line.replace(/\+\d+ms$/u, "+Nms")),
      [
        "request=1 commandStart +Nms",
        "request=1 prepared +Nms",
        "request=1 requestStart +Nms",
        "request=1 firstFragment +Nms",
        "request=1 streamEnd +Nms",
        "request=1 visible +Nms",
      ],
    );
    assert.doesNotMatch(
      app.timingLines.join("\n"),
      /return value|example\.ts|Returns the current|fixture/u,
    );
  } finally {
    app.dispose();
  }
});

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

test("an empty selection targets the whole current line", async () => {
  const app = fixture();
  try {
    app.editor.selections = [{ start: { line: 0, character: 5 }, end: { line: 0, character: 5 } }];
    await app.command("show");
    assert.equal(app.sends, 1);
    const prompt = app.prompts[0]!;
    const data = JSON.parse(prompt.slice(prompt.lastIndexOf("\n") + 1));
    assert.equal(data.selection, "return value;");
    assert.equal(app.text, "↳ Returns the current value.");
    assert.deepEqual(app.notifications, []);
  } finally {
    app.dispose();
  }
});

test("a current-line subtitle stays while the cursor does not move and clears when it does", async () => {
  const app = fixture();
  try {
    app.editor.selections = [{ start: { line: 0, character: 5 }, end: { line: 0, character: 5 } }];
    await app.command("show");
    app.selectionChanged.fire({ textEditor: app.editor });
    assert.equal(app.text, "↳ Returns the current value.");
    app.editor.selections = [{ start: { line: 0, character: 7 }, end: { line: 0, character: 7 } }];
    app.selectionChanged.fire({ textEditor: app.editor });
    assert.equal(app.text, "");
  } finally {
    app.dispose();
  }
});

test("a whitespace-only current line reports the selection failure without a request", async () => {
  const app = fixture({ text: "    " });
  try {
    app.editor.selections = [{ start: { line: 0, character: 2 }, end: { line: 0, character: 2 } }];
    await app.command("show");
    assert.equal(app.sends, 0);
    assert.equal(app.text, "");
    assert.equal(app.notifications.length, 1);
  } finally {
    app.dispose();
  }
});

test("scrolling the anchor line out of view keeps the subtitle", async () => {
  const app = fixture();
  try {
    app.editor.visibleRanges = [{ start: { line: 40 }, end: { line: 80 } }];
    await app.command("show");
    assert.equal(app.text, "↳ Returns the current value.");
    app.visibleChanged.fire({ textEditor: app.editor });
    assert.equal(app.text, "↳ Returns the current value.");
  } finally {
    app.dispose();
  }
});
