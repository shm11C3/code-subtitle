import assert from "node:assert/strict";
import test from "node:test";
import {
  SubtitleError,
  type Clock,
  type ModelGateway,
  type PreparedRequest,
  type SubtitleCache,
  type SubtitleInput,
  type SubtitlePhase,
  type SubtitleView,
} from "../src/contracts.js";
import { SubtitleSession } from "../src/session.js";

class ManualClock implements Clock {
  private current = 0;
  private nextHandle = 0;
  private readonly timers = new Map<number, { dueAt: number; callback: () => void }>();

  now(): number {
    return this.current;
  }

  setTimeout(callback: () => void, _delayMs: number): number {
    const handle = this.nextHandle++;
    this.timers.set(handle, { dueAt: this.current + _delayMs, callback });
    return handle;
  }

  clearTimeout(handle: unknown): void {
    if (typeof handle === "number") {
      this.timers.delete(handle);
    }
  }

  advanceBy(delayMs: number): void {
    if (delayMs < 0) {
      throw new Error("ManualClock cannot move backwards");
    }
    const target = this.current + delayMs;
    while (true) {
      const next = [...this.timers.entries()]
        .filter(([, timer]) => timer.dueAt <= target)
        .sort((left, right) => left[1].dueAt - right[1].dueAt || left[0] - right[0])[0];
      if (!next) {
        break;
      }
      const [handle, timer] = next;
      this.timers.delete(handle);
      this.current = timer.dueAt;
      timer.callback();
    }
    this.current = target;
  }

  fireAll(): void {
    while (this.timers.size > 0) {
      const nextDueAt = Math.min(...[...this.timers.values()].map((timer) => timer.dueAt));
      this.advanceBy(nextDueAt - this.current);
    }
  }
}

function createInput(overrides: Partial<SubtitleInput> = {}): SubtitleInput {
  return {
    documentUri: "file:///workspace/src/example.ts",
    documentVersion: 1,
    editorId: "editor-1",
    workspaceId: "workspace-1",
    range: {
      start: { line: 2, character: 0 },
      end: { line: 2, character: 18 },
    },
    anchorLine: 2,
    languageId: "typescript",
    outputLanguage: "en",
    selection: "await update();",
    before: "await lock();",
    after: "release();",
    ...overrides,
  };
}

class RecordingView implements SubtitleView {
  readonly shows: Array<{
    input: SubtitleInput;
    text: string;
    phase: SubtitlePhase;
  }> = [];
  clearCount = 0;
  readonly failures: string[] = [];

  show(input: SubtitleInput, text: string, phase: SubtitlePhase): void {
    this.shows.push({ input, text, phase });
  }

  clear(): void {
    this.clearCount += 1;
  }

  notify(failure: Parameters<SubtitleView["notify"]>[0]): void {
    this.failures.push(failure);
  }
}

class MemoryCache implements SubtitleCache {
  readonly entries = new Map<string, string>();
  gets = 0;
  puts = 0;

  get(request: PreparedRequest): string | undefined {
    this.gets += 1;
    return this.entries.get(request.prompt);
  }

  put(request: PreparedRequest, text: string): void {
    this.puts += 1;
    this.entries.set(request.prompt, text);
  }

  clear(): void {
    this.entries.clear();
  }

  invalidateDocument(uri: string): void {
    for (const key of this.entries.keys()) {
      if (key.includes(uri)) {
        this.entries.delete(key);
      }
    }
  }

  invalidateWorkspace(_workspaceId: string): void {
    this.entries.clear();
  }
}

function createGateway(stream: () => Promise<AsyncIterable<string>>): ModelGateway {
  return {
    async prepare(input, _signal) {
      return {
        input,
        model: { vendor: "copilot", id: "test-model", version: "1" },
        prompt: `${input.documentUri}:${input.selection}`,
        alreadyAuthorized: true,
        fit: async () => ({ input, prompt: input.selection }),
        stream,
      };
    },
  };
}

test("shows the first streamed fragment before the model completes", async () => {
  let releaseSecondChunk!: () => void;
  const secondChunk = new Promise<void>((resolve) => {
    releaseSecondChunk = resolve;
  });
  let completed = false;
  const stream = async function* (): AsyncIterable<string> {
    yield "Allows only one update";
    await secondChunk;
    yield " at a time.";
  };
  const view = new RecordingView();
  const clock = new ManualClock();
  const session = new SubtitleSession({
    gateway: createGateway(async () => stream()),
    view,
    cache: new MemoryCache(),
    clock,
    isCurrent: () => true,
  });

  const running = session.show(createInput()).then(() => {
    completed = true;
  });

  for (
    let attempt = 0;
    attempt < 50 && !view.shows.some((show) => show.text.length > 0);
    attempt += 1
  ) {
    await Promise.resolve();
  }

  const firstFragment = view.shows.find((show) => show.text.length > 0);
  assert.equal(firstFragment?.text, "Allows only one update");
  assert.equal(firstFragment?.phase, "streaming");
  assert.equal(completed, false);

  releaseSecondChunk();
  await running;
  assert.equal(view.shows.at(-1)?.text, "Allows only one update at a time.");
  assert.equal(view.shows.at(-1)?.phase, "visible");
});

test("batches later fragments until the 50ms flush boundary", async () => {
  let releaseSecondChunk!: () => void;
  const secondChunk = new Promise<void>((resolve) => {
    releaseSecondChunk = resolve;
  });
  let releaseCompletion!: () => void;
  const completion = new Promise<void>((resolve) => {
    releaseCompletion = resolve;
  });
  const stream = async function* (): AsyncIterable<string> {
    yield "First fragment";
    await secondChunk;
    yield " and the rest";
    await completion;
  };
  const view = new RecordingView();
  const clock = new ManualClock();
  const session = new SubtitleSession({
    gateway: createGateway(async () => stream()),
    view,
    cache: new MemoryCache(),
    clock,
    isCurrent: () => true,
  });

  const pending = session.show(createInput());
  for (
    let attempt = 0;
    attempt < 50 && !view.shows.some((show) => show.text === "First fragment");
    attempt += 1
  ) {
    await Promise.resolve();
  }
  releaseSecondChunk();
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await Promise.resolve();
  }

  clock.advanceBy(49);
  assert.equal(view.shows.at(-1)?.text, "First fragment");
  clock.advanceBy(1);
  assert.equal(view.shows.at(-1)?.text, "First fragment and the rest");
  assert.equal(view.shows.at(-1)?.phase, "streaming");

  releaseCompletion();
  await pending;
  assert.equal(view.shows.at(-1)?.text, "First fragment and the rest");
  assert.equal(view.shows.at(-1)?.phase, "visible");
});

test("cancellation settles an uncooperative request without clearing the replacement", async () => {
  let startA!: () => void;
  const startedA = new Promise<void>((resolve) => {
    startA = resolve;
  });
  const neverCompletes = new Promise<AsyncIterable<string>>(() => undefined);
  const view = new RecordingView();
  const clock = new ManualClock();
  const gateway: ModelGateway = {
    async prepare(input) {
      return {
        input,
        model: { vendor: "copilot", id: "test-model", version: "1" },
        prompt: input.selection,
        alreadyAuthorized: true,
        fit: async () => ({ input, prompt: input.selection }),
        stream: async () => {
          if (input.selection === "request A") {
            startA();
            return neverCompletes;
          }
          return (async function* (): AsyncIterable<string> {
            yield "Explanation for B.";
          })();
        },
      };
    },
  };
  const session = new SubtitleSession({
    gateway,
    view,
    cache: new MemoryCache(),
    clock,
    isCurrent: () => true,
  });

  const pendingA = session.show(createInput({ selection: "request A" }));
  await startedA;
  const pendingB = session.show(createInput({ selection: "request B" }));

  await Promise.all([pendingA, pendingB]);
  assert.equal(view.shows.at(-1)?.text, "Explanation for B.");
  assert.equal(view.shows.at(-1)?.phase, "visible");
  assert.deepEqual(view.failures, []);
});

test("late chunks and failures from a cancelled request cannot affect a newer request", async () => {
  let releaseA!: () => void;
  const delayedA = new Promise<void>((resolve) => {
    releaseA = resolve;
  });
  const view = new RecordingView();
  const clock = new ManualClock();
  const gateway: ModelGateway = {
    async prepare(input) {
      return {
        input,
        model: { vendor: "copilot", id: "test-model", version: "1" },
        prompt: input.selection,
        alreadyAuthorized: true,
        fit: async () => ({ input, prompt: input.selection }),
        stream: async () => {
          if (input.selection === "request A") {
            return (async function* (): AsyncIterable<string> {
              yield "A initial";
              await delayedA;
              yield "A late";
              throw new Error("late provider failure");
            })();
          }
          return (async function* (): AsyncIterable<string> {
            yield "B complete";
          })();
        },
      };
    },
  };
  const session = new SubtitleSession({
    gateway,
    view,
    cache: new MemoryCache(),
    clock,
    isCurrent: () => true,
  });

  const pendingA = session.show(createInput({ selection: "request A" }));
  for (
    let attempt = 0;
    attempt < 50 && !view.shows.some((show) => show.text === "A initial");
    attempt += 1
  ) {
    await Promise.resolve();
  }
  assert.equal(
    view.shows.some((show) => show.text === "A initial"),
    true,
  );

  const pendingB = session.show(createInput({ selection: "request B" }));
  await pendingB;
  releaseA();
  await pendingA;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await Promise.resolve();
  }

  assert.equal(
    view.shows.some((show) => show.text === "A late"),
    false,
  );
  assert.equal(view.shows.at(-1)?.text, "B complete");
  assert.deepEqual(view.failures, []);
});

test("completed results are reused without generation and expire from the view", async () => {
  let streamCalls = 0;
  const view = new RecordingView();
  const cache = new MemoryCache();
  const clock = new ManualClock();
  const gateway: ModelGateway = {
    async prepare(input) {
      return {
        input,
        model: { vendor: "copilot", id: "test-model", version: "1" },
        prompt: `${input.documentUri}:${input.selection}`,
        alreadyAuthorized: true,
        fit: async () => ({ input, prompt: input.selection }),
        stream: async () => {
          streamCalls += 1;
          return (async function* (): AsyncIterable<string> {
            yield "Reusable explanation.";
          })();
        },
      };
    },
  };
  const session = new SubtitleSession({
    gateway,
    view,
    cache,
    clock,
    isCurrent: () => true,
  });
  const input = createInput();

  await session.show(input);
  assert.equal(streamCalls, 1);
  assert.equal(cache.puts, 1);

  await session.show(input);
  assert.equal(streamCalls, 1);
  assert.equal(cache.gets, 2);
  assert.equal(view.shows.at(-1)?.text, "Reusable explanation.");
  assert.equal(view.shows.at(-1)?.phase, "visible");

  const clearCountAfterRender = view.clearCount;
  clock.advanceBy(9_999);
  assert.equal(view.clearCount, clearCountAfterRender);
  clock.advanceBy(1);
  assert.equal(view.clearCount, clearCountAfterRender + 1);
});

test("a cache hit renders the completed text without fitting or streaming", async () => {
  let fitCalls = 0;
  let streamCalls = 0;
  const view = new RecordingView();
  const cache = new MemoryCache();
  const gateway: ModelGateway = {
    async prepare(input) {
      const prompt = `${input.documentUri}:${input.selection}`;
      return {
        input,
        model: { vendor: "copilot", id: "test-model", version: "1" },
        prompt,
        alreadyAuthorized: true,
        fit: async () => {
          fitCalls += 1;
          return { input, prompt };
        },
        stream: async () => {
          streamCalls += 1;
          return (async function* (): AsyncIterable<string> {
            yield "Reusable explanation.";
          })();
        },
      };
    },
  };
  const session = new SubtitleSession({
    gateway,
    view,
    cache,
    clock: new ManualClock(),
    isCurrent: () => true,
  });
  const input = createInput();

  await session.show(input);
  assert.equal(fitCalls, 1);
  assert.equal(streamCalls, 1);

  const showsBeforeHit = view.shows.length;
  await session.show(input);
  assert.equal(fitCalls, 1);
  assert.equal(streamCalls, 1);
  assert.equal(cache.gets, 2);
  assert.deepEqual(
    view.shows.slice(showsBeforeHit).map((show) => show.phase),
    ["preparing", "visible"],
  );
  assert.equal(view.shows.at(-1)?.text, "Reusable explanation.");
});

test(
  "fitting is outside the generation deadline and aborts quietly",
  { timeout: 2_000 },
  async () => {
    let fitStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      fitStarted = resolve;
    });
    let streamCalls = 0;
    const view = new RecordingView();
    const clock = new ManualClock();
    const session = new SubtitleSession({
      gateway: {
        async prepare(input) {
          return {
            input,
            model: { vendor: "copilot", id: "test-model", version: "1" },
            prompt: input.selection,
            alreadyAuthorized: true,
            fit: async (signal) => {
              fitStarted();
              await new Promise<void>((_, reject) => {
                signal.addEventListener("abort", () => {
                  const error = new Error("aborted");
                  error.name = "AbortError";
                  reject(error);
                });
              });
              return { input, prompt: input.selection };
            },
            stream: async () => {
              streamCalls += 1;
              return (async function* (): AsyncIterable<string> {
                yield "unused";
              })();
            },
          };
        },
      },
      view,
      cache: new MemoryCache(),
      clock,
      isCurrent: () => true,
    });

    const pending = session.show(createInput());
    await started;
    clock.advanceBy(10_000);
    assert.deepEqual(view.failures, []);

    session.dismiss();
    await pending;
    assert.equal(streamCalls, 0);
    assert.deepEqual(view.failures, []);
    assert.equal(view.clearCount > 0, true);
  },
);

test("an oversized prompt reported during fitting notifies inputTooLarge", async () => {
  const view = new RecordingView();
  const cache = new MemoryCache();
  const session = new SubtitleSession({
    gateway: {
      async prepare(input) {
        return {
          input,
          model: { vendor: "copilot", id: "test-model", version: "1" },
          prompt: input.selection,
          alreadyAuthorized: true,
          fit: async () => {
            throw new SubtitleError("inputTooLarge");
          },
          stream: async () => {
            throw new Error("stream must not start");
          },
        };
      },
    },
    view,
    cache,
    clock: new ManualClock(),
    isCurrent: () => true,
  });

  await session.show(createInput());
  assert.deepEqual(view.failures, ["inputTooLarge"]);
  assert.equal(cache.puts, 0);
});

test("Japanese output above the concise target streams and is cached without truncation", async () => {
  const text =
    "要求ごとの識別子で応答を照合することで、先に開始した処理の結果が後から到着しても、現在表示している新しい結果を上書きしないようにしているため、キャンセルが通信先まで伝わらない場合にも表示の整合性を維持できます。";
  const length = Array.from(
    new Intl.Segmenter("ja", { granularity: "grapheme" }).segment(text),
  ).length;
  assert.ok(length > 100 && length <= 200);
  const view = new RecordingView();
  const cache = new MemoryCache();
  const session = new SubtitleSession({
    gateway: createGateway(async () =>
      (async function* (): AsyncIterable<string> {
        yield text.slice(0, 101);
        yield text.slice(101);
      })(),
    ),
    view,
    cache,
    clock: new ManualClock(),
    isCurrent: () => true,
  });

  await session.show(createInput({ outputLanguage: "ja" }));
  assert.deepEqual(view.failures, []);
  assert.ok(
    view.shows.some((show) => show.phase === "streaming" && show.text === text.slice(0, 101)),
  );
  assert.equal(view.shows.at(-1)?.text, text);
  assert.equal(view.shows.at(-1)?.phase, "visible");
  assert.deepEqual([...cache.entries.values()], [text]);
});

test("output beyond the display limit is reported as too long and never cached", async () => {
  const view = new RecordingView();
  const cache = new MemoryCache();
  const session = new SubtitleSession({
    gateway: createGateway(async () =>
      (async function* (): AsyncIterable<string> {
        yield "a".repeat(401);
      })(),
    ),
    view,
    cache,
    clock: new ManualClock(),
    isCurrent: () => true,
  });

  await session.show(createInput());
  assert.deepEqual(view.failures, ["outputTooLong"]);
  assert.equal(cache.puts, 0);
  assert.equal(
    view.shows.some((show) => show.phase === "visible"),
    false,
  );
  assert.equal(view.clearCount > 0, true);
});

test("validates raw streamed lines before display normalization", async () => {
  const view = new RecordingView();
  const session = new SubtitleSession({
    gateway: createGateway(async () =>
      (async function* (): AsyncIterable<string> {
        yield "Explains the guard.\n- omits the condition";
      })(),
    ),
    view,
    cache: new MemoryCache(),
    clock: new ManualClock(),
    isCurrent: () => true,
  });

  await session.show(createInput());
  assert.deepEqual(view.failures, ["outputInvalid"]);
  assert.equal(
    view.shows.some((show) => show.phase === "visible"),
    false,
  );
});

test("authorized requests time out without caching partial work", async () => {
  let streamStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    streamStarted = resolve;
  });
  const neverCompletes = new Promise<AsyncIterable<string>>(() => undefined);
  const view = new RecordingView();
  const cache = new MemoryCache();
  const clock = new ManualClock();
  const session = new SubtitleSession({
    gateway: {
      async prepare(input) {
        return {
          input,
          model: { vendor: "copilot", id: "test-model", version: "1" },
          prompt: input.selection,
          alreadyAuthorized: true,
          fit: async () => ({ input, prompt: input.selection }),
          stream: async () => {
            streamStarted();
            return neverCompletes;
          },
        };
      },
    },
    view,
    cache,
    clock,
    isCurrent: () => true,
  });

  const pending = session.show(createInput());
  await started;
  clock.advanceBy(9_999);
  assert.deepEqual(view.failures, []);
  clock.advanceBy(1);
  await pending;

  assert.deepEqual(view.failures, ["timeout"]);
  assert.equal(cache.puts, 0);
  assert.equal(view.clearCount > 0, true);
});

test("unconsented requests start the generation timeout after the response handle resolves", async () => {
  let streamCalled!: () => void;
  const called = new Promise<void>((resolve) => {
    streamCalled = resolve;
  });
  let resolveStream!: (stream: AsyncIterable<string>) => void;
  const streamReady = new Promise<AsyncIterable<string>>((resolve) => {
    resolveStream = resolve;
  });
  const neverYields = (async function* (): AsyncIterable<string> {
    yield* [];
    await new Promise<void>(() => undefined);
  })();
  const view = new RecordingView();
  const clock = new ManualClock();
  const session = new SubtitleSession({
    gateway: {
      async prepare(input) {
        return {
          input,
          model: { vendor: "copilot", id: "test-model", version: "1" },
          prompt: input.selection,
          alreadyAuthorized: false,
          fit: async () => ({ input, prompt: input.selection }),
          stream: async () => {
            streamCalled();
            return streamReady;
          },
        };
      },
    },
    view,
    cache: new MemoryCache(),
    clock,
    isCurrent: () => true,
  });

  const pending = session.show(createInput());
  await called;
  clock.advanceBy(10_000);
  assert.deepEqual(view.failures, []);

  resolveStream(neverYields);
  for (let attempt = 0; attempt < 10; attempt += 1) {
    await Promise.resolve();
  }
  clock.advanceBy(9_999);
  assert.deepEqual(view.failures, []);
  clock.advanceBy(1);
  await pending;
  assert.deepEqual(view.failures, ["timeout"]);
});

test("document invalidation cancels the active subtitle without retrying", async () => {
  let streamStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    streamStarted = resolve;
  });
  const neverCompletes = new Promise<AsyncIterable<string>>(() => undefined);
  const view = new RecordingView();
  const input = createInput();
  const session = new SubtitleSession({
    gateway: {
      async prepare(request) {
        return {
          input: request,
          model: { vendor: "copilot", id: "test-model", version: "1" },
          prompt: request.selection,
          alreadyAuthorized: true,
          fit: async () => ({ input: request, prompt: request.selection }),
          stream: async () => {
            streamStarted();
            return neverCompletes;
          },
        };
      },
    },
    view,
    cache: new MemoryCache(),
    clock: new ManualClock(),
    isCurrent: () => true,
  });

  const pending = session.show(input);
  await started;
  session.invalidateDocument(input.documentUri);
  await pending;

  assert.equal(view.clearCount > 0, true);
  assert.deepEqual(view.failures, []);
});

test("provider aborts are treated as quiet cancellation", async () => {
  const view = new RecordingView();
  const session = new SubtitleSession({
    gateway: {
      async prepare(input) {
        return {
          input,
          model: { vendor: "copilot", id: "test-model", version: "1" },
          prompt: input.selection,
          alreadyAuthorized: true,
          fit: async () => ({ input, prompt: input.selection }),
          stream: async () => {
            const error = new Error("user closed the model picker");
            error.name = "AbortError";
            throw error;
          },
        };
      },
    },
    view,
    cache: new MemoryCache(),
    clock: new ManualClock(),
    isCurrent: () => true,
  });

  await session.show(createInput());
  assert.deepEqual(view.failures, []);
  assert.equal(view.clearCount > 0, true);
});

test("repeating the same active request does not start a second stream", async () => {
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  let streamCalls = 0;
  const view = new RecordingView();
  const session = new SubtitleSession({
    gateway: {
      async prepare(input) {
        return {
          input,
          model: { vendor: "copilot", id: "test-model", version: "1" },
          prompt: input.selection,
          alreadyAuthorized: true,
          fit: async () => ({ input, prompt: input.selection }),
          stream: async () => {
            streamCalls += 1;
            return (async function* (): AsyncIterable<string> {
              yield "One request only";
              await blocked;
              yield ".";
            })();
          },
        };
      },
    },
    view,
    cache: new MemoryCache(),
    clock: new ManualClock(),
    isCurrent: () => true,
  });
  const input = createInput();

  const first = session.show(input);
  const second = session.show(input);
  release();
  await Promise.all([first, second]);

  assert.equal(streamCalls, 1);
  assert.equal(view.shows.at(-1)?.text, "One request only.");
});

test("clearing the cache also cancels active work before it can be saved", async () => {
  let streamStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    streamStarted = resolve;
  });
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const view = new RecordingView();
  const cache = new MemoryCache();
  const session = new SubtitleSession({
    gateway: {
      async prepare(input) {
        return {
          input,
          model: { vendor: "copilot", id: "test-model", version: "1" },
          prompt: `${input.documentUri}:${input.selection}`,
          alreadyAuthorized: true,
          fit: async () => ({ input, prompt: input.selection }),
          stream: async () => {
            streamStarted();
            return (async function* (): AsyncIterable<string> {
              yield "Partial explanation";
              await blocked;
              yield ".";
            })();
          },
        };
      },
    },
    view,
    cache,
    clock: new ManualClock(),
    isCurrent: () => true,
  });

  const pending = session.show(createInput());
  await started;
  session.clearCache();
  release();
  await pending;

  assert.equal(cache.entries.size, 0);
  assert.equal(view.clearCount > 0, true);
  assert.deepEqual(view.failures, []);
});

test("disposing the session cancels work and rejects later commands quietly", async () => {
  let streamStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    streamStarted = resolve;
  });
  const neverCompletes = new Promise<AsyncIterable<string>>(() => undefined);
  let prepareCalls = 0;
  const view = new RecordingView();
  const cache = new MemoryCache();
  const session = new SubtitleSession({
    gateway: {
      async prepare(input) {
        prepareCalls += 1;
        return {
          input,
          model: { vendor: "copilot", id: "test-model", version: "1" },
          prompt: input.selection,
          alreadyAuthorized: true,
          fit: async () => ({ input, prompt: input.selection }),
          stream: async () => {
            streamStarted();
            return neverCompletes;
          },
        };
      },
    },
    view,
    cache,
    clock: new ManualClock(),
    isCurrent: () => true,
  });
  const input = createInput();

  const pending = session.show(input);
  await started;
  session.dispose();
  await pending;
  await session.show(input);

  assert.equal(prepareCalls, 1);
  assert.equal(cache.entries.size, 0);
  assert.deepEqual(view.failures, []);
  assert.equal(view.clearCount > 0, true);
});
