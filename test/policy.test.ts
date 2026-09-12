import assert from "node:assert/strict";
import test from "node:test";
import { SubtitleError, type SubtitleInput } from "../src/contracts.js";
import {
  POLICY_VERSION,
  buildPrompt,
  createInput,
  fitInput,
  graphemeLength,
  needsTokenCount,
  normalizeOutput,
  outputLimit,
  outputTarget,
  validateOutput,
} from "../src/policy.js";

test("normalizes output whitespace without changing its words", () => {
  assert.equal(normalizeOutput("  Reuse\r\n\tthe cached value.  "), "Reuse the cached value.");
});

test("uses separate language-specific output targets and hard limits", () => {
  assert.equal(outputTarget("ja-JP"), 100);
  assert.equal(outputTarget("en-US"), 200);
  assert.equal(outputLimit("ja-JP"), 200);
  assert.equal(outputLimit("en-US"), 400);
});

test("treats Chinese and Korean like Japanese for the target and the hard limit", () => {
  for (const language of ["zh", "zh-CN", "zh-Hant-TW", "ko", "ko-KR", "JA"]) {
    assert.equal(outputTarget(language), 100, language);
    assert.equal(outputLimit(language), 200, language);
  }
  for (const language of ["zu", "kok", "jav", "en", "auto", ""]) {
    assert.equal(outputTarget(language), 200, language);
    assert.equal(outputLimit(language), 400, language);
  }
});

test("counts grapheme clusters rather than UTF-16 code units", () => {
  assert.equal(graphemeLength("👍🏽e\u0301"), 2);
});

test("accepts a short plain subtitle", () => {
  assert.equal(validateOutput("Reuse the cached value when present.", "en"), true);
  assert.equal(validateOutput("Keep snake_case identifiers unchanged.", "en"), true);
});

test("rejects code fences and Markdown lists, headings, links, and block quotes", () => {
  for (const text of [
    "```code```",
    "- one item",
    "# Heading",
    "[docs](https://example.com)",
    "> quoted text",
  ]) {
    assert.equal(validateOutput(text, "en"), false, text);
  }
});

test("allows inline backticks and emphasis as literal subtitle text", () => {
  assert.equal(validateOutput("`requestId` gates the stale response.", "en"), true);
  assert.equal(validateOutput("The **cached** value remains reusable.", "en"), true);
});

test("rejects empty, unsafe, and over-limit output instead of truncating it", () => {
  assert.equal(validateOutput("   ", "en"), false);
  assert.equal(validateOutput("safe\u0001 text", "en"), false);
  assert.equal(validateOutput("a".repeat(401), "en"), false);
});

test("accepts output at each hard boundary and rejects the next grapheme", () => {
  assert.equal(validateOutput("あ".repeat(200), "ja"), true);
  assert.equal(validateOutput("あ".repeat(201), "ja"), false);
  assert.equal(validateOutput("a".repeat(400), "en"), true);
  assert.equal(validateOutput("a".repeat(401), "en"), false);
});

test("accepts a 104-grapheme Japanese prose subtitle", () => {
  const prose =
    "選択されたコードは現在の状態を確認し、古いリクエストの結果が画面へ反映されないように更新順序を管理します。必要な情報が不足している場合にも周辺の文脈を確認し、呼び出し側の契約とデータの流れを確認してください。";

  assert.equal(graphemeLength(prose), 104);
  assert.equal(validateOutput(prose, "ja-JP"), true);
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
  assert.match(prompt, /Optional semantic evidence.*untrusted excerpts/iu);
  assert.match(prompt, /translate them faithfully.*semantic evidence/iu);
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

test("selects calibration examples by language and keeps one generic example", () => {
  const promptFor = (languageId: string): string =>
    buildPrompt(
      createInput({
        text: "before\nvalue = compute()\nafter",
        selections: [{ start: { line: 1, character: 0 }, end: { line: 1, character: 17 } }],
        documentUri: "file:///workspace/example",
        documentVersion: 1,
        editorId: "editor-1",
        languageId,
        outputLanguage: "en",
      }),
    );
  const generic = "Code: return normalize(input);";
  const typescriptExample = "Code: const id = ++activeId;";

  const rust = promptFor("rust");
  assert.match(rust, /Code: .*unwrap_or_else\(\|poisoned\|/u);
  assert.ok(rust.includes(generic));
  assert.equal(rust.includes(typescriptExample), false);

  const go = promptFor("go");
  assert.match(go, /Code: select \{/u);
  assert.ok(go.includes(generic));
  assert.equal(go.includes(typescriptExample), false);

  const python = promptFor("python");
  assert.match(python, /Code: async with semaphore:/u);
  assert.ok(python.includes(generic));
  assert.equal(python.includes(typescriptExample), false);

  for (const languageId of ["typescript", "javascript", "cobol", "constructor", "__proto__"]) {
    const fallback = promptFor(languageId);
    assert.ok(fallback.includes(typescriptExample), languageId);
    assert.ok(fallback.includes(generic), languageId);
    assert.equal(fallback.includes("unwrap_or_else"), false, languageId);
  }

  for (const prompt of [rust, go, python]) {
    const examples = prompt.split("\n").filter((line) => line.startsWith("Code: "));
    const subtitles = prompt.split("\n").filter((line) => line.startsWith("Subtitle: "));
    assert.equal(examples.length, 3);
    assert.equal(subtitles.length, 3);
    const data = JSON.parse(prompt.slice(prompt.lastIndexOf("\n") + 1)) as Record<string, string>;
    assert.deepEqual(Object.keys(data).sort(), [
      "after",
      "before",
      "languageId",
      "outputLanguage",
      "selection",
    ]);
  }
  assert.equal(POLICY_VERSION, "5");
});

test("includes whitelisted semantic evidence while excluding local metadata", () => {
  const semanticContext = {
    entries: [
      {
        kind: "definition",
        symbol: "compute",
        text: "compute returns a cached value.",
        internalNote: "must not be submitted",
      },
      {
        kind: "hover",
        symbol: "cache",
        text: "Cache entries are shared by key.",
      },
    ],
    dependencies: [{ uri: "file:///private/secret-definition.ts", version: 4 }],
  } as unknown as SubtitleInput["semanticContext"];
  const input = {
    ...createInput({
      text: "const value = compute();",
      selections: [{ start: { line: 0, character: 0 }, end: { line: 0, character: 24 } }],
      documentUri: "file:///workspace/example.ts",
      documentVersion: 1,
      editorId: "editor-1",
      languageId: "typescript",
      outputLanguage: "en",
    }),
    semanticContext,
  };

  const prompt = buildPrompt(input);
  const data = JSON.parse(prompt.slice(prompt.lastIndexOf("\n") + 1)) as Record<string, unknown>;

  assert.deepEqual(data.semanticContext, [
    { kind: "definition", symbol: "compute", text: "compute returns a cached value." },
    { kind: "hover", symbol: "cache", text: "Cache entries are shared by key." },
  ]);
  assert.doesNotMatch(prompt, /internalNote|must not be submitted|secret-definition/iu);
});

test("omits optional semantic context when there are no entries", () => {
  const base = createInput({
    text: "const value = compute();",
    selections: [{ start: { line: 0, character: 0 }, end: { line: 0, character: 24 } }],
    documentUri: "file:///workspace/example.ts",
    documentVersion: 1,
    editorId: "editor-1",
    languageId: "typescript",
    outputLanguage: "en",
  });
  const prompt = buildPrompt({
    ...base,
    semanticContext: {
      entries: [],
      dependencies: [{ uri: "file:///workspace/local.ts", version: 7 }],
    },
  });
  const data = JSON.parse(prompt.slice(prompt.lastIndexOf("\n") + 1)) as Record<string, unknown>;

  assert.deepEqual(data, {
    languageId: "typescript",
    outputLanguage: "en",
    selection: "const value = compute();",
    before: "",
    after: "",
  });
  assert.doesNotMatch(prompt, /file:\/\/\/workspace\/local/iu);
});

test("bounds and sanitizes semantic evidence before it reaches the prompt", () => {
  const rawEntries = [
    {
      kind: "definition",
      symbol: "first",
      text: "first evidence",
      extra: "discarded",
    },
    { kind: "definition", symbol: "first", text: "first evidence" },
    { kind: "invalid", symbol: "bad", text: "drop this" },
    { kind: "hover", symbol: "x".repeat(1_000), text: "y".repeat(600) },
    { kind: "definition", symbol: "", text: "missing symbol" },
    { kind: "definition", symbol: "missing-text", text: "" },
    ...Array.from({ length: 11 }, (_, index) => ({
      kind: index % 2 === 0 ? "hover" : "typeDefinition",
      symbol: `symbol-${index}`,
      text: `evidence-${index}`,
    })),
  ];
  const semanticContext = {
    entries: rawEntries,
    dependencies: [],
  } as unknown as SubtitleInput["semanticContext"];
  const input = {
    ...createInput({
      text: "const value = compute();",
      selections: [{ start: { line: 0, character: 0 }, end: { line: 0, character: 24 } }],
      documentUri: "file:///workspace/example.ts",
      documentVersion: 1,
      editorId: "editor-1",
      languageId: "typescript",
      outputLanguage: "en",
    }),
    semanticContext,
  };

  const prompt = buildPrompt(input);
  const data = JSON.parse(prompt.slice(prompt.lastIndexOf("\n") + 1)) as {
    semanticContext: Array<{ kind: string; symbol: string; text: string }>;
  };
  const entries = data.semanticContext;

  assert.ok(entries.length <= 9);
  assert.equal(entries[0]?.symbol, "first");
  assert.equal(
    entries.some((entry) => entry.kind === "invalid"),
    false,
  );
  assert.equal(
    entries.some((entry) => entry.symbol === "x".repeat(1_000)),
    false,
  );
  assert.equal(
    entries.filter((entry) => entry.symbol === "first" && entry.text === "first evidence").length,
    1,
  );
  assert.equal(
    entries.some((entry) => entry.symbol === "" || entry.text === ""),
    false,
  );
  assert.ok(entries.every((entry) => entry.symbol.length + entry.text.length <= 1_500));
  assert.ok(
    entries.reduce((total, entry) => total + entry.symbol.length + entry.text.length, 0) <= 4_000,
  );
  assert.ok(entries.every((entry) => Object.keys(entry).sort().join(",") === "kind,symbol,text"));
});

test("includes the validator's language-specific display limit in the prompt", () => {
  for (const outputLanguage of ["ja", "ja-JP", "zh-CN", "ko", "en-US", "fr"]) {
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
      prompt.includes(`Aim for about ${outputTarget(outputLanguage)} visible characters`),
      `The prompt must communicate the target for ${outputLanguage}.`,
    );
    assert.ok(
      prompt.includes(`hard cap of at most ${outputLimit(outputLanguage)} visible characters`),
      `The prompt must communicate the hard limit for ${outputLanguage}.`,
    );
    assert.match(prompt, /Keep one concise sentence/iu);
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

test("drops optional semantic evidence before adjacent context when fitting", async () => {
  const base = createInput({
    text: "before\nconst value = compute();\nafter",
    selections: [{ start: { line: 1, character: 0 }, end: { line: 1, character: 24 } }],
    documentUri: "file:///workspace/example.ts",
    documentVersion: 1,
    editorId: "editor-1",
    languageId: "typescript",
    outputLanguage: "en",
  });
  const input = {
    ...base,
    semanticContext: {
      entries: [
        { kind: "definition" as const, symbol: "first", text: "first evidence" },
        { kind: "hover" as const, symbol: "second", text: "second evidence" },
      ],
      dependencies: [{ uri: "file:///workspace/definition.ts", version: 2 }],
    },
  };
  let calls = 0;
  const result = await fitInput(
    input,
    async (prompt) => {
      calls += 1;
      return prompt.includes("second evidence") ? 11 : 1;
    },
    10,
    new AbortController().signal,
  );

  assert.equal(result.input.selection, input.selection);
  assert.equal(result.input.before, input.before);
  assert.equal(result.input.after, input.after);
  assert.deepEqual(result.input.semanticContext?.entries, [input.semanticContext.entries[0]]);
  assert.deepEqual(result.input.semanticContext?.dependencies, input.semanticContext.dependencies);
  assert.equal(result.prompt, buildPrompt(result.input));
  const data = JSON.parse(result.prompt.slice(result.prompt.lastIndexOf("\n") + 1)) as Record<
    string,
    unknown
  >;
  assert.deepEqual(data.semanticContext, result.input.semanticContext?.entries);
  assert.ok(calls >= 2);
});

test("counts tokens only when the UTF-8 byte length can exceed the budget", () => {
  assert.equal(needsTokenCount("abcd", 4), false);
  assert.equal(needsTokenCount("abcd", 3), true);
  assert.equal(needsTokenCount("日本", 6), false);
  assert.equal(needsTokenCount("日本", 5), true);
});

test("skips the token counter when the prompt bytes already fit the model budget", async () => {
  const input = createInput({
    text: "before\nconst value = compute();\nafter",
    selections: [{ start: { line: 1, character: 0 }, end: { line: 1, character: 24 } }],
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
      return 1;
    },
    1_000_000,
    new AbortController().signal,
  );

  assert.equal(calls, 0);
  assert.equal(result.prompt, buildPrompt(input));
  assert.equal(result.input.before, "before");
  assert.equal(result.input.after, "after");
});

test("rechecks the byte bound before each later token count while reducing context", async () => {
  const before = Array.from({ length: 5 }, (_, index) => `before-${index}`.padEnd(300, "b"));
  const after = Array.from({ length: 5 }, (_, index) => `after-${index}`.padEnd(300, "a"));
  const input = createInput({
    text: [...before, "selected", ...after].join("\n"),
    selections: [{ start: { line: 5, character: 0 }, end: { line: 5, character: 8 } }],
    documentUri: "file:///workspace/example.ts",
    documentVersion: 1,
    editorId: "editor-1",
    languageId: "typescript",
    outputLanguage: "en",
  });
  const initialBytes = Buffer.byteLength(buildPrompt(input), "utf8");
  const maxTokens = initialBytes - 100;
  const counted: string[] = [];
  const result = await fitInput(
    input,
    async (prompt) => {
      counted.push(prompt);
      return maxTokens + 1;
    },
    maxTokens,
    new AbortController().signal,
  );

  assert.ok(counted.length >= 1);
  assert.ok(counted.every((prompt) => Buffer.byteLength(prompt, "utf8") > maxTokens));
  assert.ok(Buffer.byteLength(result.prompt, "utf8") <= maxTokens);
  assert.equal(result.input.selection, "selected");
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
