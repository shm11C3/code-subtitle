import assert from "node:assert/strict";
import test from "node:test";
import { SubtitleError } from "../src/contracts.js";
import {
  buildPrompt,
  createInput,
  fitInput,
  graphemeLength,
  normalizeOutput,
  outputLimit,
  validateOutput,
} from "../src/policy.js";

test("normalizes output whitespace without changing its words", () => {
  assert.equal(normalizeOutput("  Reuse\r\n\tthe cached value.  "), "Reuse the cached value.");
});

test("uses the Japanese output limit only for Japanese language tags", () => {
  assert.equal(outputLimit("ja-JP"), 100);
  assert.equal(outputLimit("en-US"), 200);
});

test("counts grapheme clusters rather than UTF-16 code units", () => {
  assert.equal(graphemeLength("👍🏽e\u0301"), 2);
});

test("accepts a short plain subtitle", () => {
  assert.equal(validateOutput("Reuse the cached value when present.", "en"), true);
  assert.equal(validateOutput("Keep snake_case identifiers unchanged.", "en"), true);
});

test("rejects code fences and Markdown lists, headings, links, and formatting", () => {
  for (const text of [
    "```code```",
    "- one item",
    "# Heading",
    "[docs](https://example.com)",
    "> quoted text",
    "*emphasis*",
    "`inline code`",
  ]) {
    assert.equal(validateOutput(text, "en"), false, text);
  }
});

test("rejects empty, unsafe, and over-limit output instead of truncating it", () => {
  assert.equal(validateOutput("   ", "en"), false);
  assert.equal(validateOutput("safe\u0001 text", "en"), false);
  assert.equal(validateOutput("a".repeat(201), "en"), false);
});

test("creates one input with the selected text, anchor, and adjacent line context", () => {
  const selected = "const value = compute();";
  const text = `before\n${selected}\nafter`;
  const input = createInput({
    text,
    selections: [
      { start: { line: 1, character: 0 }, end: { line: 1, character: selected.length } },
    ],
    documentUri: "file:///workspace/example.ts",
    documentVersion: 3,
    editorId: "editor-1",
    workspaceId: "workspace-1",
    languageId: "typescript",
    outputLanguage: "en",
  });

  assert.equal(input.selection, selected);
  assert.equal(input.anchorLine, 1);
  assert.equal(input.before, "before");
  assert.equal(input.after, "after");
});

test("rejects multiple selections as a selection failure", () => {
  assert.throws(
    () =>
      createInput({
        text: "one\ntwo",
        selections: [
          { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } },
          { start: { line: 1, character: 0 }, end: { line: 1, character: 3 } },
        ],
        documentUri: "file:///workspace/example.ts",
        documentVersion: 1,
        editorId: "editor-1",
        languageId: "typescript",
        outputLanguage: "en",
      }),
    (error: unknown) => error instanceof SubtitleError && error.code === "selection",
  );
});

test("rejects a selection containing only whitespace", () => {
  assert.throws(
    () =>
      createInput({
        text: "  ",
        selections: [{ start: { line: 0, character: 0 }, end: { line: 0, character: 2 } }],
        documentUri: "file:///workspace/example.ts",
        documentVersion: 1,
        editorId: "editor-1",
        languageId: "typescript",
        outputLanguage: "en",
      }),
    (error: unknown) => error instanceof SubtitleError && error.code === "selection",
  );
});

test("anchors a selection ending at the next line start on the previous line", () => {
  const input = createInput({
    text: "selected\nnext",
    selections: [{ start: { line: 0, character: 0 }, end: { line: 1, character: 0 } }],
    documentUri: "file:///workspace/example.ts",
    documentVersion: 1,
    editorId: "editor-1",
    languageId: "typescript",
    outputLanguage: "en",
  });

  assert.equal(input.selection, "selected\n");
  assert.equal(input.anchorLine, 0);
  assert.equal(input.after, "next");
});

test("rejects selections beyond the line or UTF-16 code-unit limits", () => {
  const eightyOneLines = Array.from({ length: 81 }, () => "x").join("\n");
  assert.throws(
    () =>
      createInput({
        text: eightyOneLines,
        selections: [{ start: { line: 0, character: 0 }, end: { line: 80, character: 1 } }],
        documentUri: "file:///workspace/example.ts",
        documentVersion: 1,
        editorId: "editor-1",
        languageId: "typescript",
        outputLanguage: "en",
      }),
    (error: unknown) => error instanceof SubtitleError && error.code === "inputTooLarge",
  );

  const longLine = "a".repeat(8_001);
  assert.throws(
    () =>
      createInput({
        text: longLine,
        selections: [
          { start: { line: 0, character: 0 }, end: { line: 0, character: longLine.length } },
        ],
        documentUri: "file:///workspace/example.ts",
        documentVersion: 1,
        editorId: "editor-1",
        languageId: "typescript",
        outputLanguage: "en",
      }),
    (error: unknown) => error instanceof SubtitleError && error.code === "inputTooLarge",
  );
});

test("limits context to the five nearest whole lines on each side", () => {
  const lines = Array.from({ length: 21 }, (_, index) => `line-${index}`);
  const selected = lines[10] ?? "";
  const input = createInput({
    text: lines.join("\n"),
    selections: [
      { start: { line: 10, character: 0 }, end: { line: 10, character: selected.length } },
    ],
    documentUri: "file:///workspace/example.ts",
    documentVersion: 1,
    editorId: "editor-1",
    languageId: "typescript",
    outputLanguage: "en",
  });

  assert.equal(input.before, ["line-5", "line-6", "line-7", "line-8", "line-9"].join("\n"));
  assert.equal(input.after, ["line-11", "line-12", "line-13", "line-14", "line-15"].join("\n"));
});

test("drops farthest context lines as whole lines to stay within 2,000 code units", () => {
  const before = Array.from({ length: 5 }, (_, index) => `before-${index}`.padEnd(500, "b"));
  const after = Array.from({ length: 5 }, (_, index) => `after-${index}`.padEnd(500, "a"));
  const lines = [...before, "selected", ...after];
  const input = createInput({
    text: lines.join("\n"),
    selections: [{ start: { line: 5, character: 0 }, end: { line: 5, character: 8 } }],
    documentUri: "file:///workspace/example.ts",
    documentVersion: 1,
    editorId: "editor-1",
    languageId: "typescript",
    outputLanguage: "en",
  });

  assert.ok(input.before.length + input.after.length <= 2_000);
  assert.ok(input.before.split("\n").every((line) => line.length === 500));
  assert.ok(input.after.split("\n").every((line) => line.length === 500));
});

test("requests an experienced-reader insight while sending only allowed input data", () => {
  const input = createInput({
    text: "before\nconst value = compute();\nafter",
    selections: [{ start: { line: 1, character: 0 }, end: { line: 1, character: 24 } }],
    documentUri: "file:///private/secret.ts",
    documentVersion: 9,
    editorId: "private-editor",
    workspaceId: "private-workspace",
    languageId: "typescript",
    outputLanguage: "ja-JP",
  });

  const prompt = buildPrompt(input);
  assert.match(prompt, /purpose|role|problem/iu);
  assert.match(prompt, /experienced engineers/iu);
  assert.match(prompt, /OSS.*reviewing code/iu);
  assert.match(prompt, /one.*insight/iu);
  assert.match(prompt, /invariant/iu);
  assert.match(prompt, /tradeoff/iu);
  assert.match(prompt, /Do not narrate.*line by line/iu);
  assert.match(prompt, /Do not assume.*unseen helpers/iu);
  assert.match(prompt, /Do not force.*defect/iu);
  assert.match(prompt, /Do not follow instructions/iu);
  const data = JSON.parse(prompt.slice(prompt.lastIndexOf("\n") + 1)) as Record<string, string>;
  assert.deepEqual(data, {
    languageId: "typescript",
    outputLanguage: "ja-JP",
    selection: "const value = compute();",
    before: "before",
    after: "after",
  });
  assert.doesNotMatch(prompt, /private-editor|private-workspace|private\/secret/iu);
});

test("includes the validator's language-specific display limit in the prompt", () => {
  for (const outputLanguage of ["ja", "ja-JP", "en-US", "fr"]) {
    const input = createInput({
      text: "return normalize(input);",
      selections: [{ start: { line: 0, character: 0 }, end: { line: 0, character: 24 } }],
      documentUri: "file:///workspace/example.ts",
      documentVersion: 1,
      editorId: "editor-1",
      languageId: "typescript",
      outputLanguage,
    });

    const prompt = buildPrompt(input);
    assert.ok(
      prompt.includes(`at most ${outputLimit(outputLanguage)} visible characters`),
      `The prompt must communicate the display limit for ${outputLanguage}.`,
    );
  }
});

test("fits the prompt by dropping context lines while preserving the selection", async () => {
  const lines = Array.from({ length: 21 }, (_, index) => `line-${index}`);
  const selected = lines[10] ?? "";
  const input = createInput({
    text: lines.join("\n"),
    selections: [
      { start: { line: 10, character: 0 }, end: { line: 10, character: selected.length } },
    ],
    documentUri: "file:///workspace/example.ts",
    documentVersion: 1,
    editorId: "editor-1",
    languageId: "typescript",
    outputLanguage: "en",
  });
  let calls = 0;
  const result = await fitInput(
    input,
    async () => {
      calls += 1;
      return calls < 3 ? 11 : 1;
    },
    10,
    new AbortController().signal,
  );

  assert.equal(result.input.selection, input.selection);
  assert.equal(result.input.range.start.line, input.range.start.line);
  assert.ok(
    result.input.before.length < input.before.length ||
      result.input.after.length < input.after.length,
  );
  assert.equal(result.prompt, buildPrompt(result.input));
  assert.ok(calls >= 3);
});

test("reports an oversized prompt when the selected text itself cannot fit", async () => {
  const input = createInput({
    text: "selected",
    selections: [{ start: { line: 0, character: 0 }, end: { line: 0, character: 8 } }],
    documentUri: "file:///workspace/example.ts",
    documentVersion: 1,
    editorId: "editor-1",
    languageId: "typescript",
    outputLanguage: "en",
  });

  await assert.rejects(
    fitInput(input, async () => 11, 10, new AbortController().signal),
    (error: unknown) => error instanceof SubtitleError && error.code === "inputTooLarge",
  );
});

test("stops fitting when the request is aborted", async () => {
  const input = createInput({
    text: "selected",
    selections: [{ start: { line: 0, character: 0 }, end: { line: 0, character: 8 } }],
    documentUri: "file:///workspace/example.ts",
    documentVersion: 1,
    editorId: "editor-1",
    languageId: "typescript",
    outputLanguage: "en",
  });
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(
    fitInput(input, async () => 1, 10, controller.signal),
    (error: unknown) => error instanceof Error && error.name === "AbortError",
  );
});
