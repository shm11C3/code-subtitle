import assert from "node:assert/strict";
import test from "node:test";
import type { Clock, PreparedRequest, SubtitleInput } from "../src/contracts.js";
import { MemorySubtitleCache } from "../src/cache.js";

class ManualClock implements Clock {
  current = 0;

  now(): number {
    return this.current;
  }

  setTimeout(): number {
    return 0;
  }

  clearTimeout(): void {
    // Cache expiration is checked when entries are read or written.
  }
}

function createInput(overrides: Partial<SubtitleInput> = {}): SubtitleInput {
  return {
    documentUri: "file:///workspace/example.ts",
    documentVersion: 1,
    editorId: "editor-1",
    workspaceId: "workspace-1",
    range: { start: { line: 1, character: 0 }, end: { line: 1, character: 8 } },
    anchorLine: 1,
    languageId: "typescript",
    outputLanguage: "en",
    selection: "selected",
    before: "before",
    after: "after",
    ...overrides,
  };
}

function createRequest(overrides: Partial<SubtitleInput> = {}, prompt = "prompt"): PreparedRequest {
  const input = createInput(overrides);
  return {
    input,
    model: { vendor: "copilot", id: "test-model", version: "1" },
    prompt,
    alreadyAuthorized: true,
    fit: async () => ({ input, prompt }),
    stream: async () =>
      (async function* (): AsyncIterable<string> {
        yield "unused";
      })(),
  };
}

test("stores and retrieves a completed subtitle", () => {
  const cache = new MemorySubtitleCache(new ManualClock());
  const request = createRequest();

  cache.put(request, "Reuse the result.");

  assert.equal(cache.get(request), "Reuse the result.");
});

test("expires an outside-workspace short-term entry after two minutes", () => {
  const clock = new ManualClock();
  const cache = new MemorySubtitleCache(clock);
  const request = createRequest({ workspaceId: undefined });

  cache.put(request, "Reuse the result.");
  clock.current = 2 * 60 * 1_000;

  assert.equal(cache.get(request), undefined);
});

test("keeps a workspace entry for ten minutes after short-term expiry", () => {
  const clock = new ManualClock();
  const cache = new MemorySubtitleCache(clock);
  const request = createRequest();

  cache.put(request, "Reuse the result.");
  clock.current = 2 * 60 * 1_000;
  assert.equal(cache.get(request), "Reuse the result.");

  clock.current = 10 * 60 * 1_000;
  assert.equal(cache.get(request), undefined);
});

test("does not reuse a result when the prompt changes", () => {
  const cache = new MemorySubtitleCache(new ManualClock());
  const request = createRequest({}, "prompt-a");
  const changed = createRequest({}, "prompt-b");

  cache.put(request, "Result for A.");

  assert.equal(cache.get(changed), undefined);
});

test("does not make document version part of the cache identity", () => {
  const cache = new MemorySubtitleCache(new ManualClock());
  const request = createRequest({ documentVersion: 1 });
  const sameContentAfterVersion = createRequest({ documentVersion: 2 });

  cache.put(request, "Stable result.");

  assert.equal(cache.get(sameContentAfterVersion), "Stable result.");
});

test("reuses a workspace result across editor instances with the same input", () => {
  const cache = new MemorySubtitleCache(new ManualClock());
  const request = createRequest({ editorId: "editor-1" });
  const otherEditor = createRequest({ editorId: "editor-2" });

  cache.put(request, "Shared workspace result.");

  assert.equal(cache.get(otherEditor), "Shared workspace result.");
});

test("keeps the short-term cache scoped to its editor", () => {
  const cache = new MemorySubtitleCache(new ManualClock());
  const request = createRequest({ workspaceId: undefined, editorId: "editor-1" });
  const otherEditor = createRequest({ workspaceId: undefined, editorId: "editor-2" });

  cache.put(request, "Local editor result.");

  assert.equal(cache.get(otherEditor), undefined);
});

test("replaces the only workspace entry without losing the workspace bucket", () => {
  const cache = new MemorySubtitleCache(new ManualClock());
  const first = createRequest({}, "prompt-a");
  const replacement = createRequest({}, "prompt-b");
  const otherEditor = createRequest({ editorId: "editor-2" }, "prompt-b");

  cache.put(first, "First result.");
  cache.put(replacement, "Replacement result.");

  assert.equal(cache.get(otherEditor), "Replacement result.");
});

test("does not store an empty or whitespace-only result", () => {
  const cache = new MemorySubtitleCache(new ManualClock());
  const request = createRequest();

  cache.put(request, "   ");

  assert.equal(cache.get(request), undefined);
});

test("invalidates both cache layers for a document", () => {
  const cache = new MemorySubtitleCache(new ManualClock());
  const request = createRequest();

  cache.put(request, "Document result.");
  cache.invalidateDocument(request.input.documentUri);

  assert.equal(cache.get(request), undefined);
});

test("invalidates the short and workspace entries for a workspace", () => {
  const cache = new MemorySubtitleCache(new ManualClock());
  const request = createRequest({ workspaceId: "workspace-a" });
  const otherWorkspace = createRequest({ workspaceId: "workspace-b" });

  cache.put(request, "Workspace result.");
  cache.put(otherWorkspace, "Other workspace result.");
  cache.invalidateWorkspace("workspace-a");

  assert.equal(cache.get(request), undefined);
  assert.equal(cache.get(otherWorkspace), "Other workspace result.");
});

test("evicts the least recently used entry after one hundred workspace entries", () => {
  const cache = new MemorySubtitleCache(new ManualClock());
  const requests = Array.from({ length: 101 }, (_, index) =>
    createRequest({ selection: `selected-${index}` }, `prompt-${index}`),
  );

  for (const [index, request] of requests.entries()) {
    cache.put(request, `Result ${index}.`);
  }

  assert.equal(cache.get(requests[0]!), undefined);
  assert.equal(cache.get(requests[100]!), "Result 100.");
});

test("refreshes recency when a workspace entry is read", () => {
  const cache = new MemorySubtitleCache(new ManualClock());
  const requests = Array.from({ length: 100 }, (_, index) =>
    createRequest({ selection: `selected-${index}` }, `prompt-${index}`),
  );

  for (const [index, request] of requests.entries()) {
    cache.put(request, `Result ${index}.`);
  }
  assert.equal(cache.get(requests[0]!), "Result 0.");

  const newest = createRequest({ selection: "selected-100" }, "prompt-100");
  cache.put(newest, "Result 100.");

  assert.equal(cache.get(requests[0]!), "Result 0.");
  assert.equal(cache.get(requests[1]!), undefined);
});

test("keeps each workspace within the estimated one MiB response budget", () => {
  const cache = new MemorySubtitleCache(new ManualClock());
  const largeText = "x".repeat(500_000);
  const first = createRequest({ selection: "selected-a" }, "prompt-a");
  const second = createRequest({ selection: "selected-b" }, "prompt-b");

  cache.put(first, largeText);
  cache.put(second, largeText);

  assert.equal(cache.get(first), undefined);
  assert.equal(cache.get(second), largeText);
});

test("keeps all workspaces within the estimated four MiB global budget", () => {
  const cache = new MemorySubtitleCache(new ManualClock());
  const largeText = "x".repeat(500_000);
  const requests = Array.from({ length: 5 }, (_, index) =>
    createRequest(
      { workspaceId: `workspace-${index}`, selection: `selected-${index}` },
      `prompt-${index}`,
    ),
  );

  for (const request of requests) {
    cache.put(request, largeText);
  }

  assert.equal(cache.get(requests[0]!), undefined);
  assert.equal(cache.get(requests[4]!), largeText);
});
