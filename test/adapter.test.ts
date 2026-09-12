import assert from "node:assert/strict";
import test from "node:test";
import type * as vscode from "vscode";
import type { SubtitleInput } from "../src/contracts.js";
import {
  VscodeModelGateway,
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
): vscode.LanguageModelChat {
  return {
    id,
    name: id,
    vendor: "copilot",
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

test("forwards configured modelOptions to sendRequest and omits them by default", async () => {
  const requestOptions: vscode.LanguageModelChatRequestOptions[] = [];
  const createRecordingModel = (): vscode.LanguageModelChat =>
    ({
      id: "options-model",
      name: "options-model",
      vendor: "copilot",
      family: "options-model",
      version: "1",
      maxInputTokens: 1000,
      countTokens: async () => 12,
      sendRequest: async (
        _messages: vscode.LanguageModelChatMessage[],
        options?: vscode.LanguageModelChatRequestOptions,
      ) => {
        requestOptions.push(options ?? {});
        return {
          text: (async function* () {
            yield "ok";
          })(),
        };
      },
    }) as unknown as vscode.LanguageModelChat;

  const plain = new VscodeModelGateway(
    createOptions(createRecordingModel(), [], undefined, "options-model"),
  );
  await (
    await plain.prepare(createInput(), new AbortController().signal)
  ).stream(new AbortController().signal);

  const tuned = new VscodeModelGateway({
    ...createOptions(createRecordingModel(), [], undefined, "options-model"),
    modelOptions: { temperature: 0.2, maxTokens: 120 },
  });
  await (
    await tuned.prepare(createInput(), new AbortController().signal)
  ).stream(new AbortController().signal);

  assert.equal(requestOptions.length, 2);
  assert.equal("modelOptions" in requestOptions[0]!, false);
  assert.equal(typeof requestOptions[0]!.justification, "string");
  assert.deepEqual(requestOptions[1]!.modelOptions, { temperature: 0.2, maxTokens: 120 });
  assert.equal(requestOptions[1]!.justification, requestOptions[0]!.justification);
});

test("prepare resolves the model without counting tokens; fit counts once and stream reuses it", async () => {
  const tokenSources: FakeTokenSource[] = [];
  let countCalls = 0;
  const sentPrompts: string[] = [];
  const model = {
    id: "lazy-model",
    name: "lazy-model",
    vendor: "copilot",
    family: "lazy-model",
    version: "1",
    maxInputTokens: 1000,
    countTokens: async (
      _text: string | vscode.LanguageModelChatMessage,
      _token?: vscode.CancellationToken,
    ) => {
      countCalls += 1;
      return 12;
    },
    sendRequest: async (
      messages: { content: string }[],
      _options?: vscode.LanguageModelChatRequestOptions,
      _token?: vscode.CancellationToken,
    ) => {
      sentPrompts.push(messages[0]!.content);
      return {
        text: (async function* () {
          yield "ok";
        })(),
      };
    },
  } as unknown as vscode.LanguageModelChat;
  let fitCalls = 0;
  const base = createOptions(model, tokenSources, undefined, "lazy-model");
  const gateway = new VscodeModelGateway({
    ...base,
    fitInput: async (input, countTokens) => {
      fitCalls += 1;
      await countTokens("fitted prompt");
      return { input, prompt: "fitted prompt" };
    },
  });
  const signal = new AbortController().signal;

  const prepared = await gateway.prepare(createInput(), signal);
  assert.equal(fitCalls, 0);
  assert.equal(countCalls, 0);
  assert.equal(prepared.model.id, "lazy-model");
  assert.ok(prepared.prompt.includes("await update();"));

  const fitted = await prepared.fit(signal);
  assert.equal(fitCalls, 1);
  assert.equal(countCalls, 1);
  assert.equal(fitted.prompt, "fitted prompt");

  const stream = await prepared.stream(signal);
  for await (const _chunk of stream) {
    // Drain the stream so the request completes.
  }
  assert.equal(fitCalls, 1);
  assert.equal(countCalls, 1);
  assert.deepEqual(sentPrompts, ["fitted prompt"]);
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
  const prepared = await gateway.prepare(createInput(), controller.signal);
  assert.equal(tokenSources.length, 0);
  const pending = prepared.fit(controller.signal);

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
