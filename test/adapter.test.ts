import assert from "node:assert/strict";
import test from "node:test";
import type * as vscode from "vscode";
import type { SubtitleInput } from "../src/contracts.js";
import {
  VscodeModelGateway,
  type ModelChoiceStore,
  type ModelPickerItem,
  type VscodeModelGatewayOptions,
} from "../src/vscode-model.js";

function createInput(): SubtitleInput {
  return {
    documentUri: "file:///workspace/example.ts",
    documentVersion: 1,
    editorId: "editor-1",
    workspaceId: "workspace-1",
    range: { start: { line: 0, character: 0 }, end: { line: 0, character: 12 } },
    anchorLine: 0,
    languageId: "typescript",
    outputLanguage: "en",
    selection: "await update();",
    before: "",
    after: "",
  };
}

interface FakeTokenSource {
  readonly source: vscode.CancellationTokenSource;
  readonly cancelled: () => boolean;
  readonly disposed: () => boolean;
}

function createTokenSource(): FakeTokenSource {
  let cancelled = false;
  let disposed = false;
  const token = {
    isCancellationRequested: false,
    onCancellationRequested: (() => ({ dispose: () => undefined })) as unknown,
  } as vscode.CancellationToken;
  const source = {
    token,
    cancel: () => {
      cancelled = true;
      (token as { isCancellationRequested: boolean }).isCancellationRequested = true;
    },
    dispose: () => {
      disposed = true;
    },
  } as unknown as vscode.CancellationTokenSource;
  return { source, cancelled: () => cancelled, disposed: () => disposed };
}

function createModel(
  id: string,
  stream: AsyncIterable<string>,
  seen: { countTokens: vscode.CancellationToken[]; sendRequests: vscode.CancellationToken[] },
  vendor = "copilot",
): vscode.LanguageModelChat {
  return {
    id,
    name: id,
    vendor,
    family: id,
    version: "1",
    maxInputTokens: 1000,
    countTokens: async (
      _text: string | vscode.LanguageModelChatMessage,
      token?: vscode.CancellationToken,
    ) => {
      if (token) seen.countTokens.push(token);
      return 12;
    },
    sendRequest: async (
      _messages: vscode.LanguageModelChatMessage[],
      _options?: vscode.LanguageModelChatRequestOptions,
      token?: vscode.CancellationToken,
    ) => {
      if (token) seen.sendRequests.push(token);
      return { text: stream, stream };
    },
  } as unknown as vscode.LanguageModelChat;
}

function createOptions(
  model: vscode.LanguageModelChat,
  tokenSources: FakeTokenSource[],
  selected?: ModelPickerItem,
  modelSetting = "auto",
  picker: VscodeModelGatewayOptions["picker"] = { showQuickPick: async () => selected },
): VscodeModelGatewayOptions {
  return {
    runtime: {
      selectChatModels: async () => [model],
      userMessage: (content) =>
        ({ content, role: 1, name: undefined }) as unknown as vscode.LanguageModelChatMessage,
      createCancellationTokenSource: () => {
        const source = createTokenSource();
        tokenSources.push(source);
        return source.source;
      },
    },
    access: { canSendRequest: () => true },
    picker,
    fitInput: async (input, countTokens) => {
      await countTokens("Explain the selected code briefly.");
      return { input, prompt: "Explain the selected code briefly." };
    },
    modelSetting,
  };
}

test("configured model IDs resolve exactly and stream through the gateway", async () => {
  const tokenSources: FakeTokenSource[] = [];
  const seen = { countTokens: [], sendRequests: [] } as {
    countTokens: vscode.CancellationToken[];
    sendRequests: vscode.CancellationToken[];
  };
  const model = createModel(
    "exact-model",
    (async function* () {
      yield "first";
      yield " second";
    })(),
    seen,
  );
  let picked = 0;
  const options = createOptions(model, tokenSources, undefined, "exact-model", {
    showQuickPick: async () => {
      picked += 1;
      return undefined;
    },
  });
  const gateway = new VscodeModelGateway(options);

  const prepared = await gateway.prepare(createInput(), new AbortController().signal);
  const stream = await prepared.stream(new AbortController().signal);
  const chunks: string[] = [];
  for await (const chunk of stream) {
    chunks.push(chunk);
  }

  assert.deepEqual(chunks, ["first", " second"]);
  assert.equal(picked, 0);
  assert.equal(prepared.model.id, "exact-model");
  assert.equal(tokenSources.length, 2);
  assert.equal(
    tokenSources.every((source) => source.disposed()),
    true,
  );
});

test("a vendor-qualified model setting selects a non-Copilot provider", async () => {
  const tokenSources: FakeTokenSource[] = [];
  const seen = { countTokens: [], sendRequests: [] } as {
    countTokens: vscode.CancellationToken[];
    sendRequests: vscode.CancellationToken[];
  };
  const model = createModel(
    "exact-model",
    (async function* () {
      yield "ok";
    })(),
    seen,
    "openai",
  );
  const selectors: (vscode.LanguageModelChatSelector | undefined)[] = [];
  const base = createOptions(model, tokenSources, undefined, "openai:exact-model");
  const gateway = new VscodeModelGateway({
    ...base,
    runtime: {
      ...base.runtime,
      selectChatModels: async (selector) => {
        selectors.push(selector);
        return [model];
      },
    },
  });

  const prepared = await gateway.prepare(createInput(), new AbortController().signal);

  assert.deepEqual(selectors, [{ vendor: "openai", id: "exact-model" }]);
  assert.equal(prepared.model.vendor, "openai");
  assert.equal(prepared.model.id, "exact-model");
});

test("auto selection asks once, then reuses the selected model for the session", async () => {
  const tokenSources: FakeTokenSource[] = [];
  const seen = { countTokens: [], sendRequests: [] } as {
    countTokens: vscode.CancellationToken[];
    sendRequests: vscode.CancellationToken[];
  };
  const model = createModel(
    "auto-model",
    (async function* () {
      yield "ok";
    })(),
    seen,
  );
  let picks = 0;
  const options = createOptions(
    model,
    tokenSources,
    {
      label: "auto-model",
      description: "auto-model",
      modelId: "auto-model",
    },
    "auto",
    {
      showQuickPick: async (items) => {
        picks += 1;
        return items[0];
      },
    },
  );
  const gateway = new VscodeModelGateway(options);

  const first = await gateway.prepare(createInput(), new AbortController().signal);
  const second = await gateway.prepare(
    { ...createInput(), selection: "return value;" },
    new AbortController().signal,
  );
  assert.equal(first.model.id, "auto-model");
  assert.equal(second.model.id, "auto-model");
  assert.equal(picks, 1);
});

test("auto selection prefers Copilot when it is available", async () => {
  const copilot = createCatalog(["copilot-model"])[0]!;
  const other = createModel(
    "other-model",
    (async function* () {
      yield "ok";
    })(),
    { countTokens: [], sendRequests: [] },
    "openai",
  );
  const selectors: (vscode.LanguageModelChatSelector | undefined)[] = [];
  let pickedItems: readonly ModelPickerItem[] = [];
  const base = createOptions(copilot, [], undefined, "auto", {
    showQuickPick: async (items) => {
      pickedItems = items;
      return items[0];
    },
  });
  const gateway = new VscodeModelGateway({
    ...base,
    runtime: {
      ...base.runtime,
      selectChatModels: async (selector) => {
        selectors.push(selector);
        return selector?.vendor === "copilot" ? [copilot] : [copilot, other];
      },
    },
  });

  const prepared = await gateway.prepare(createInput(), new AbortController().signal);

  assert.deepEqual(selectors, [{ vendor: "copilot" }]);
  assert.deepEqual(
    pickedItems.map((item) => item.modelKey),
    ["copilot:copilot-model"],
  );
  assert.equal(prepared.model.vendor, "copilot");
});

test("auto selection lists every vendor when Copilot is unavailable", async () => {
  const models = [
    createModel(
      "shared-model",
      (async function* () {
        yield "ok";
      })(),
      { countTokens: [], sendRequests: [] },
      "openai",
    ),
    createModel(
      "shared-model",
      (async function* () {
        yield "ok";
      })(),
      { countTokens: [], sendRequests: [] },
      "ollama",
    ),
  ];
  const selectors: (vscode.LanguageModelChatSelector | undefined)[] = [];
  let pickedItems: readonly ModelPickerItem[] = [];
  const base = createOptions(models[0]!, [], undefined, "auto", {
    showQuickPick: async (items) => {
      pickedItems = items;
      return items[1];
    },
  });
  const gateway = new VscodeModelGateway({
    ...base,
    runtime: {
      ...base.runtime,
      selectChatModels: async (selector) => {
        selectors.push(selector);
        return selector?.vendor === "copilot" ? [] : models;
      },
    },
  });

  const prepared = await gateway.prepare(createInput(), new AbortController().signal);

  assert.deepEqual(selectors, [{ vendor: "copilot" }, undefined]);
  assert.deepEqual(
    pickedItems.map((item) => item.modelKey),
    ["openai:shared-model", "ollama:shared-model"],
  );
  assert.equal(prepared.model.vendor, "ollama");
  assert.equal(prepared.model.id, "shared-model");
});

test("provider failure becomes a typed safe subtitle error", async () => {
  const tokenSources: FakeTokenSource[] = [];
  const model = {
    id: "blocked-model",
    name: "blocked-model",
    vendor: "copilot",
    family: "blocked-model",
    version: "1",
    maxInputTokens: 1000,
    countTokens: async (
      _text: string | vscode.LanguageModelChatMessage,
      _token?: vscode.CancellationToken,
    ) => 12,
    sendRequest: async (
      _messages: vscode.LanguageModelChatMessage[],
      _options?: vscode.LanguageModelChatRequestOptions,
      _token?: vscode.CancellationToken,
    ) => {
      throw Object.assign(new Error("provider payload must not escape"), { code: "Blocked" });
    },
  } as unknown as vscode.LanguageModelChat;
  const gateway = new VscodeModelGateway(
    createOptions(model, tokenSources, undefined, "blocked-model"),
  );
  const prepared = await gateway.prepare(createInput(), new AbortController().signal);

  await assert.rejects(
    () => prepared.stream(new AbortController().signal),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, "blocked");
      assert.equal((error as Error).message, "blocked");
      assert.equal((error as Error).message.includes("provider payload"), false);
      return true;
    },
  );
});

test("aborting token fitting cancels and disposes its VS Code source immediately", async () => {
  const tokenSources: FakeTokenSource[] = [];
  let releaseCount!: () => void;
  const countHold = new Promise<void>((resolve) => {
    releaseCount = resolve;
  });
  const model = {
    id: "slow-model",
    name: "slow-model",
    vendor: "copilot",
    family: "slow-model",
    version: "1",
    maxInputTokens: 1000,
    countTokens: async (
      _text: string | vscode.LanguageModelChatMessage,
      _token?: vscode.CancellationToken,
    ) => {
      await countHold;
      return 12;
    },
    sendRequest: async (
      _messages: vscode.LanguageModelChatMessage[],
      _options?: vscode.LanguageModelChatRequestOptions,
      _token?: vscode.CancellationToken,
    ) => ({
      text: (async function* () {
        yield "unused";
      })(),
      stream: (async function* () {
        yield "unused";
      })(),
    }),
  } as unknown as vscode.LanguageModelChat;
  const base = createOptions(model, tokenSources, undefined, "slow-model");
  const gateway = new VscodeModelGateway(base);
  const controller = new AbortController();
  const pending = gateway.prepare(createInput(), controller.signal);

  for (let attempt = 0; attempt < 20 && tokenSources.length === 0; attempt += 1) {
    await Promise.resolve();
  }
  assert.equal(tokenSources.length, 1);
  controller.abort();
  assert.equal(tokenSources[0]?.cancelled(), true);
  assert.equal(tokenSources[0]?.disposed(), true);
  releaseCount();
  await assert.rejects(pending);
});

test("aborting sendRequest disposes its source before the response handle resolves", async () => {
  const tokenSources: FakeTokenSource[] = [];
  let releaseRequest!: () => void;
  const requestHold = new Promise<void>((resolve) => {
    releaseRequest = resolve;
  });
  const model = {
    id: "request-model",
    name: "request-model",
    vendor: "copilot",
    family: "request-model",
    version: "1",
    maxInputTokens: 1000,
    countTokens: async (
      _text: string | vscode.LanguageModelChatMessage,
      _token?: vscode.CancellationToken,
    ) => 12,
    sendRequest: async (
      _messages: vscode.LanguageModelChatMessage[],
      _options?: vscode.LanguageModelChatRequestOptions,
      _token?: vscode.CancellationToken,
    ) => {
      await requestHold;
      return {
        text: (async function* () {
          yield "unused";
        })(),
        stream: (async function* () {
          yield "unused";
        })(),
      };
    },
  } as unknown as vscode.LanguageModelChat;
  const gateway = new VscodeModelGateway(
    createOptions(model, tokenSources, undefined, "request-model"),
  );
  const prepared = await gateway.prepare(createInput(), new AbortController().signal);
  const controller = new AbortController();
  const pending = prepared.stream(controller.signal);

  for (let attempt = 0; attempt < 20 && tokenSources.length < 2; attempt += 1) {
    await Promise.resolve();
  }
  assert.equal(tokenSources.length, 2);
  controller.abort();
  assert.equal(tokenSources[1]?.cancelled(), true);
  assert.equal(tokenSources[1]?.disposed(), true);
  releaseRequest();
  await assert.rejects(pending);
});

test("a stream model-not-found invalidates the selection before the next prepare", async () => {
  const tokenSources: FakeTokenSource[] = [];
  let catalog: vscode.LanguageModelChat[];
  const missingModel = {
    id: "missing-model",
    name: "missing-model",
    vendor: "copilot",
    family: "missing-model",
    version: "1",
    maxInputTokens: 1000,
    countTokens: async (
      _text: string | vscode.LanguageModelChatMessage,
      _token?: vscode.CancellationToken,
    ) => 12,
    sendRequest: async (
      _messages: vscode.LanguageModelChatMessage[],
      _options?: vscode.LanguageModelChatRequestOptions,
      _token?: vscode.CancellationToken,
    ) => ({
      text: (async function* () {
        yield* [];
        throw Object.assign(new Error("stale provider detail"), { code: "NotFound" });
      })(),
      stream: (async function* () {
        yield "unused";
      })(),
    }),
  } as unknown as vscode.LanguageModelChat;
  const replacementModel = createModel(
    "replacement-model",
    (async function* () {
      yield "ok";
    })(),
    {
      countTokens: [],
      sendRequests: [],
    },
  );
  catalog = [missingModel];
  const base = createOptions(missingModel, tokenSources, undefined, "auto");
  const gateway = new VscodeModelGateway({
    ...base,
    runtime: {
      ...base.runtime,
      selectChatModels: async () => catalog,
    },
    picker: {
      showQuickPick: async (items) => items[0],
    },
  });
  const first = await gateway.prepare(createInput(), new AbortController().signal);
  const stream = await first.stream(new AbortController().signal);
  await assert.rejects(
    async () => {
      for await (const _chunk of stream) {
        // The iterator fails before yielding a chunk.
      }
    },
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, "modelUnavailable");
      assert.equal((error as Error).message, "modelUnavailable");
      return true;
    },
  );

  catalog = [replacementModel];
  const second = await gateway.prepare(createInput(), new AbortController().signal);
  assert.equal(second.model.id, "replacement-model");
});

function createChoiceStore(initial?: string): ModelChoiceStore & { readonly writes: unknown[] } {
  let stored = initial;
  const writes: unknown[] = [];
  return {
    writes,
    get: () => stored,
    set: async (id) => {
      stored = id;
      writes.push(id);
    },
  };
}

function createCatalog(ids: string[]): vscode.LanguageModelChat[] {
  return ids.map((id) =>
    createModel(
      id,
      (async function* () {
        yield "ok";
      })(),
      { countTokens: [], sendRequests: [] },
    ),
  );
}

test("a stored automatic choice is reused across gateways without the picker", async () => {
  const [model] = createCatalog(["remembered-model"]);
  let picks = 0;
  const store = createChoiceStore("remembered-model");
  const gateway = new VscodeModelGateway({
    ...createOptions(model!, [], undefined, "auto", {
      showQuickPick: async () => {
        picks += 1;
        return undefined;
      },
    }),
    choiceStore: store,
  });

  const prepared = await gateway.prepare(createInput(), new AbortController().signal);
  assert.equal(prepared.model.id, "remembered-model");
  assert.equal(picks, 0);
  assert.deepEqual(store.writes, []);
});

test("a stored vendor-qualified automatic choice is reused without the picker", async () => {
  const [model] = createCatalog(["remembered-model"]);
  (model as { vendor: string }).vendor = "openai";
  let picks = 0;
  const store = createChoiceStore("openai:remembered-model");
  const base = createOptions(model!, [], undefined, "auto", {
    showQuickPick: async () => {
      picks += 1;
      return undefined;
    },
  });
  const gateway = new VscodeModelGateway({
    ...base,
    runtime: {
      ...base.runtime,
      selectChatModels: async (selector) => (selector?.vendor === "copilot" ? [] : [model!]),
    },
    choiceStore: store,
  });

  const prepared = await gateway.prepare(createInput(), new AbortController().signal);

  assert.equal(prepared.model.vendor, "openai");
  assert.equal(prepared.model.id, "remembered-model");
  assert.equal(picks, 0);
  assert.deepEqual(store.writes, []);
});

test("a stale stored choice falls back to the picker and is overwritten", async () => {
  const [model] = createCatalog(["current-model"]);
  let picks = 0;
  const store = createChoiceStore("retired-model");
  const gateway = new VscodeModelGateway({
    ...createOptions(model!, [], undefined, "auto", {
      showQuickPick: async (items) => {
        picks += 1;
        return items[0];
      },
    }),
    choiceStore: store,
  });

  const prepared = await gateway.prepare(createInput(), new AbortController().signal);
  assert.equal(prepared.model.id, "current-model");
  assert.equal(picks, 1);
  assert.deepEqual(store.writes, ["copilot:current-model"]);
  assert.equal(store.get(), "copilot:current-model");
});

test("an explicit model setting bypasses the stored automatic choice", async () => {
  const [model] = createCatalog(["exact-model"]);
  let picks = 0;
  const store = createChoiceStore("remembered-model");
  const gateway = new VscodeModelGateway({
    ...createOptions(model!, [], undefined, "exact-model", {
      showQuickPick: async () => {
        picks += 1;
        return undefined;
      },
    }),
    choiceStore: store,
  });

  const prepared = await gateway.prepare(createInput(), new AbortController().signal);
  assert.equal(prepared.model.id, "exact-model");
  assert.equal(picks, 0);
  assert.deepEqual(store.writes, []);
});

test("choosing a model explicitly reopens the picker and updates the stored choice", async () => {
  const catalog = createCatalog(["first-model", "second-model"]);
  let picks = 0;
  const store = createChoiceStore("first-model");
  const base = createOptions(catalog[0]!, [], undefined, "auto", {
    showQuickPick: async (items) => {
      picks += 1;
      return items[1];
    },
  });
  const gateway = new VscodeModelGateway({
    ...base,
    runtime: { ...base.runtime, selectChatModels: async () => catalog },
    choiceStore: store,
  });

  const chosen = await gateway.chooseModel(new AbortController().signal);
  assert.equal(chosen, "second-model");
  assert.equal(picks, 1);
  assert.deepEqual(store.writes, ["copilot:second-model"]);

  const prepared = await gateway.prepare(createInput(), new AbortController().signal);
  assert.equal(prepared.model.id, "second-model");
  assert.equal(picks, 1);
});

test("choosing a model without Copilot stores its vendor-qualified key", async () => {
  const model = createModel(
    "local-model",
    (async function* () {
      yield "ok";
    })(),
    { countTokens: [], sendRequests: [] },
    "ollama",
  );
  const store = createChoiceStore();
  const base = createOptions(model, [], undefined, "auto", {
    showQuickPick: async (items) => items[0],
  });
  const gateway = new VscodeModelGateway({
    ...base,
    runtime: {
      ...base.runtime,
      selectChatModels: async (selector) => (selector?.vendor === "copilot" ? [] : [model]),
    },
    choiceStore: store,
  });

  const chosen = await gateway.chooseModel(new AbortController().signal);

  assert.equal(chosen, "local-model");
  assert.deepEqual(store.writes, ["ollama:local-model"]);
});

test("a model catalog change keeps the stored choice and revalidates it silently", async () => {
  const [model] = createCatalog(["remembered-model"]);
  let picks = 0;
  const store = createChoiceStore("remembered-model");
  const gateway = new VscodeModelGateway({
    ...createOptions(model!, [], undefined, "auto", {
      showQuickPick: async () => {
        picks += 1;
        return undefined;
      },
    }),
    choiceStore: store,
  });

  await gateway.prepare(createInput(), new AbortController().signal);
  gateway.invalidate();
  const again = await gateway.prepare(createInput(), new AbortController().signal);
  assert.equal(again.model.id, "remembered-model");
  assert.equal(picks, 0);
  assert.equal(store.get(), "remembered-model");
});
