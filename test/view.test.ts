import assert from "node:assert/strict";
import test from "node:test";
import Module from "node:module";
import type { Clock, SubtitleInput } from "../src/contracts.js";
type ViewModule = typeof import("../src/vscode-view.js");

/** Minimal VS Code surface used by the renderer; records toasts and context keys. */
const notifications: string[] = [];
const contexts: boolean[] = [];
const api = {
  window: {
    createTextEditorDecorationType: () => ({ dispose() {} }),
    showWarningMessage: async (message: string) => {
      notifications.push(message);
    },
  },
  commands: {
    executeCommand: async (name: string, _key: string, value: boolean) => {
      if (name === "setContext") contexts.push(value);
    },
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
};

const loader = Module as unknown as { _load: (...args: any[]) => any };
const originalLoad = loader._load;
delete require.cache[require.resolve("../src/vscode-view.js")];
loader._load = function (request: string, ...args: any[]) {
  return request === "vscode" ? api : originalLoad.call(this, request, ...args);
};
let viewModule: ViewModule;
try {
  viewModule = require("../src/vscode-view.js");
} finally {
  loader._load = originalLoad;
}

function createInput(overrides: Partial<SubtitleInput> = {}): SubtitleInput {
  return {
    documentUri: "file:///workspace/example.ts",
    documentVersion: 1,
    editorId: "editor-1",
    range: { start: { line: 0, character: 0 }, end: { line: 0, character: 13 } },
    anchorLine: 0,
    languageId: "typescript",
    outputLanguage: "en",
    selection: "return value;",
    before: "",
    after: "",
    ...overrides,
  };
}

function fixture(options: { editorAvailable?: boolean } = {}) {
  notifications.length = 0;
  contexts.length = 0;
  const timers = new Map<number, () => void>();
  let nextHandle = 0;
  const clock: Pick<Clock, "setTimeout" | "clearTimeout"> = {
    setTimeout: (callback) => {
      timers.set(++nextHandle, callback);
      return nextHandle;
    },
    clearTimeout: (handle) => {
      timers.delete(handle as number);
    },
  };
  let current: { text: string; color: string } | undefined;
  const editor = {
    document: {
      lineCount: 2,
      lineAt: (line: number) => ({ range: { end: { line, character: 13 } } }),
    },
    setDecorations: (_type: unknown, decorations: any[]) => {
      const first = decorations[0];
      current = first
        ? { text: first.renderOptions.after.contentText, color: first.renderOptions.after.color.id }
        : undefined;
    },
  };
  const view = new viewModule.VscodeSubtitleView(
    () => (options.editorAvailable === false ? undefined : (editor as any)),
    clock,
  );
  return {
    view,
    notifications,
    contexts,
    get decoration() {
      return current;
    },
    pendingTimers: () => timers.size,
    fireTimers: () => {
      const pending = Array.from(timers.values());
      timers.clear();
      for (const callback of pending) callback();
    },
  };
}

test("actionable failures render beside the code in the warning color", () => {
  const app = fixture();
  app.view.notify("inputTooLarge", createInput());

  assert.deepEqual(app.decoration, {
    text: "↳ The selection is too large. Narrow it and try again.",
    color: "editorWarning.foreground",
  });
  assert.deepEqual(app.notifications, []);
  assert.equal(app.contexts.at(-1), true);
});

test("failures that need action outside the editor keep the notification", () => {
  const app = fixture();
  app.view.notify("modelUnavailable", createInput());

  assert.equal(app.decoration, undefined);
  assert.deepEqual(app.notifications, ["No language model is available for Code Subtitle."]);
  assert.equal(app.contexts.at(-1), false);
  assert.equal(app.pendingTimers(), 0);
});

test("failures without a request or editor fall back to the notification", () => {
  const app = fixture();
  app.view.notify("selection");
  assert.equal(app.decoration, undefined);
  assert.equal(app.notifications.length, 1);

  const closed = fixture({ editorAvailable: false });
  closed.view.notify("timeout", createInput());
  assert.equal(closed.decoration, undefined);
  assert.equal(closed.notifications.length, 1);
});

test("an inline failure clears itself after the short display time", () => {
  const app = fixture();
  app.view.notify("timeout", createInput());
  assert.equal(app.pendingTimers(), 1);

  app.fireTimers();
  assert.equal(app.decoration, undefined);
  assert.equal(app.contexts.at(-1), false);
});

test("a new subtitle replaces an inline failure and cancels its timer", () => {
  const app = fixture();
  app.view.notify("network", createInput());
  app.view.show(createInput(), "", "preparing");
  assert.equal(app.pendingTimers(), 0);

  app.fireTimers();
  assert.equal(app.decoration?.text, "↳ Generating…");
  assert.equal(app.contexts.at(-1), true);
});

test("clearing the view cancels a pending failure timer", () => {
  const app = fixture();
  app.view.notify("outputInvalid", createInput());
  app.view.clear();
  assert.equal(app.pendingTimers(), 0);
  assert.equal(app.decoration, undefined);
});

test("preparing and streaming share a neutral color and only failures use the warning color", () => {
  const app = fixture();
  app.view.show(createInput(), "", "preparing");
  assert.deepEqual(app.decoration, { text: "↳ Generating…", color: "editorCodeLens.foreground" });
  app.view.show(createInput(), "Partial", "streaming");
  assert.deepEqual(app.decoration, { text: "↳ Partial …", color: "editorCodeLens.foreground" });
  app.view.show(createInput(), "Complete.", "visible");
  assert.deepEqual(app.decoration, { text: "↳ Complete.", color: "editorHint.foreground" });
});
