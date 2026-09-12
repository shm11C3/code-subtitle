import assert from "node:assert/strict";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import test from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type * as vscode from "vscode";
import type { SubtitleInput } from "../src/contracts.js";
import {
  VscodeSemanticContextProvider,
  type VscodeSemanticContextRuntime,
} from "../src/vscode-semantic.js";

interface FakeUri {
  readonly scheme: string;
  readonly path: string;
  readonly authority: string;
  readonly fsPath?: string;
  toString(): string;
}

class TestUri implements FakeUri {
  readonly scheme: string;
  readonly path: string;
  readonly authority: string;
  readonly fsPath?: string;
  private readonly value: string;

  constructor(value: string) {
    const parsed = new URL(value);
    this.value = value;
    this.scheme = parsed.protocol.slice(0, -1);
    this.path = decodeURIComponent(parsed.pathname);
    this.authority = parsed.host;
    this.fsPath = this.scheme === "file" ? fileURLToPath(value) : undefined;
  }

  toString(): string {
    return this.value;
  }

  static parse(value: string): TestUri {
    return new TestUri(value);
  }
}

class TestPosition {
  constructor(
    readonly line: number,
    readonly character: number,
  ) {}
}

class TestRange {
  constructor(
    readonly start: TestPosition,
    readonly end: TestPosition,
  ) {}
}

interface FakeDocument {
  readonly uri: TestUri;
  readonly version: number;
  getText(range?: TestRange): string;
  lineAt(line: number): { readonly text: string; readonly range: TestRange };
}

function createInput(overrides: Partial<SubtitleInput> = {}): SubtitleInput {
  return {
    documentUri: "file:///workspace/src/example.ts",
    documentVersion: 1,
    editorId: "editor-1",
    workspaceId: "file:///workspace",
    range: { start: { line: 0, character: 0 }, end: { line: 0, character: 14 } },
    anchorLine: 0,
    languageId: "typescript",
    outputLanguage: "en",
    selection: "update(value);",
    before: "",
    after: "",
    ...overrides,
  };
}

function createDocument(uri: TestUri, text: string, version = 1): FakeDocument {
  const lines = text.split(/\r\n|\r|\n/u);
  return {
    uri,
    version,
    getText: (range) => {
      if (!range) {
        return text;
      }
      const selected = lines.slice(range.start.line, range.end.line + 1);
      if (selected.length === 0) {
        return "";
      }
      selected[0] = selected[0]!.slice(range.start.character);
      selected[selected.length - 1] = selected.at(-1)!.slice(0, range.end.character);
      return selected.join("\n");
    },
    lineAt: (line) => {
      const value = lines[line] ?? "";
      return {
        text: value,
        range: new TestRange(new TestPosition(line, 0), new TestPosition(line, value.length)),
      };
    },
  };
}

function createRuntime(
  options: {
    source?: FakeDocument;
    sourceUri?: TestUri;
    rootUri?: TestUri;
    documents?: Map<string, FakeDocument>;
    definitions?: unknown;
    typeDefinitions?: unknown;
    hover?: unknown;
    symbols?: unknown;
    trusted?: boolean;
    onCommand?: (name: string, args: unknown[]) => void;
    onOpenDocument?: (uri: TestUri) => void;
  } = {},
): VscodeSemanticContextRuntime {
  const sourceUri = options.sourceUri ?? TestUri.parse("file:///workspace/src/example.ts");
  const source = options.source ?? createDocument(sourceUri, "update(value);\n", 1);
  const rootUri = options.rootUri ?? TestUri.parse("file:///workspace");
  const root = { uri: rootUri, name: "workspace", index: 0 };
  return {
    commands: {
      executeCommand: async <T>(name: string, ...args: unknown[]) => {
        options.onCommand?.(name, args);
        if (name === "vscode.executeHoverProvider") {
          return options.hover as T;
        }
        if (name === "vscode.executeDefinitionProvider") {
          return options.definitions as T;
        }
        if (name === "vscode.executeTypeDefinitionProvider") {
          return options.typeDefinitions as T;
        }
        if (name === "vscode.executeDocumentSymbolProvider") {
          return options.symbols as T;
        }
        return undefined as T;
      },
    } as Pick<typeof vscode.commands, "executeCommand">,
    workspace: {
      isTrusted: options.trusted ?? true,
      openTextDocument: async (uri: TestUri) => {
        options.onOpenDocument?.(uri);
        const configured = options.documents?.get(uri.toString());
        if (configured) {
          return configured as unknown as vscode.TextDocument;
        }
        if (uri.toString() === source.uri.toString()) {
          return source as unknown as vscode.TextDocument;
        }
        return createDocument(uri, "const resolved = 1;\n", 2) as unknown as vscode.TextDocument;
      },
      getWorkspaceFolder: (uri: TestUri) => {
        if (
          uri.scheme !== "file" ||
          !(uri.path === rootUri.path || uri.path.startsWith(`${rootUri.path}/`))
        ) {
          return undefined;
        }
        return root as unknown as vscode.WorkspaceFolder;
      },
    } as unknown as Pick<
      typeof vscode.workspace,
      "openTextDocument" | "getWorkspaceFolder" | "isTrusted"
    >,
    Uri: { parse: (value: string) => TestUri.parse(value) } as unknown as Pick<
      typeof vscode.Uri,
      "parse"
    >,
    Position: TestPosition as unknown as typeof vscode.Position,
    Range: TestRange as unknown as typeof vscode.Range,
  };
}

for (const scheme of ["git", "pr", "vscode-vfs"]) {
  test(`skips semantic providers for ${scheme}: review URIs`, async () => {
    const commands: string[] = [];
    const provider = new VscodeSemanticContextProvider(
      createRuntime({
        sourceUri: TestUri.parse(`${scheme}://review/example.ts`),
        onCommand: (name) => commands.push(name),
      }),
    );

    const context = await provider.collect(
      createInput({
        documentUri: `${scheme}://review/example.ts`,
        workspaceId: undefined,
      }),
      new AbortController().signal,
    );

    assert.deepEqual(context, { entries: [], dependencies: [] });
    assert.deepEqual(commands, []);
  });
}

test("collects hover evidence without exposing URI metadata", async () => {
  const provider = new VscodeSemanticContextProvider(
    createRuntime({
      hover: [{ contents: ["function update(value): void", "Updates the value."] }],
    }),
  );

  const context = await provider.collect(createInput(), new AbortController().signal);

  assert.deepEqual(context.entries, [
    {
      kind: "hover",
      symbol: "update",
      text: "function update(value): void\nUpdates the value.",
    },
    {
      kind: "hover",
      symbol: "value",
      text: "function update(value): void\nUpdates the value.",
    },
  ]);
  assert.equal(JSON.stringify(context.entries).includes("file:///"), false);
  assert.deepEqual(context.dependencies, [{ uri: "file:///workspace/src/example.ts", version: 1 }]);
});

test("resolves one-hop definitions and type definitions inside the selected workspace", async () => {
  const rootPath = await mkdtemp(join(tmpdir(), "code-subtitle-semantic-"));
  const outsidePath = join(tmpdir(), "code-subtitle-outside.ts");
  try {
    const sourcePath = join(rootPath, "example.ts");
    const definitionPath = join(rootPath, "lib.ts");
    await writeFile(sourcePath, "update(value);\n", "utf8");
    await writeFile(definitionPath, "function update(value) {\n  return value;\n}\n", "utf8");
    await writeFile(outsidePath, "function outside() {}\n", "utf8");

    const sourceUri = TestUri.parse(pathToFileURL(sourcePath).href);
    const definitionUri = TestUri.parse(pathToFileURL(definitionPath).href);
    const outsideUri = TestUri.parse(pathToFileURL(outsidePath).href);
    const definitionDocument = createDocument(
      definitionUri,
      "function update(value) {\n  return value;\n}\n",
      2,
    );
    const targetRange = new TestRange(new TestPosition(0, 9), new TestPosition(0, 15));
    const linkRange = new TestRange(new TestPosition(0, 9), new TestPosition(0, 15));
    const symbolRange = new TestRange(new TestPosition(0, 0), new TestPosition(2, 1));
    const definition = { uri: definitionUri, range: targetRange };
    const duplicateLink = {
      targetUri: definitionUri,
      targetRange: linkRange,
      targetSelectionRange: targetRange,
    };
    const runtime = createRuntime({
      sourceUri,
      rootUri: TestUri.parse(pathToFileURL(rootPath).href),
      source: createDocument(sourceUri, "update(value);\n", 1),
      documents: new Map([[definitionUri.toString(), definitionDocument]]),
      definitions: [definition, duplicateLink, { uri: outsideUri, range: targetRange }],
      typeDefinitions: [definition, definition],
      symbols: [
        {
          name: "update",
          range: symbolRange,
          selectionRange: targetRange,
          children: [],
        },
      ],
    });

    const provider = new VscodeSemanticContextProvider(runtime);
    const context = await provider.collect(
      createInput({
        documentUri: sourceUri.toString(),
        workspaceId: pathToFileURL(rootPath).href,
      }),
      new AbortController().signal,
    );

    assert.deepEqual(context.entries, [
      {
        kind: "definition",
        symbol: "update",
        text: "function update(value) {\n  return value;\n}",
      },
      {
        kind: "typeDefinition",
        symbol: "update",
        text: "function update(value) {\n  return value;\n}",
      },
    ]);
    assert.deepEqual(context.dependencies, [
      { uri: sourceUri.toString(), version: 1 },
      { uri: definitionUri.toString(), version: 2 },
    ]);
  } finally {
    await rm(rootPath, { recursive: true, force: true });
    await rm(outsidePath, { force: true });
  }
});

test("limits semantic lookup to three unique identifiers and prioritizes call sites", async () => {
  const provider = new VscodeSemanticContextProvider(
    createRuntime({ hover: [{ contents: ["symbol"] }] }),
  );
  const context = await provider.collect(
    createInput({
      selection: "first(); second; third(); fourth();",
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 35 } },
    }),
    new AbortController().signal,
  );

  assert.deepEqual(
    context.entries.filter((entry) => entry.kind === "hover").map((entry) => entry.symbol),
    ["first", "third", "fourth"],
  );
});

test("bounds hover evidence per entry and across the complete context", async () => {
  const provider = new VscodeSemanticContextProvider(
    createRuntime({ hover: [{ contents: ["x".repeat(2_000)] }] }),
  );
  const context = await provider.collect(
    createInput({
      selection: "first(); second(); third();",
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 28 } },
    }),
    new AbortController().signal,
  );

  assert.equal(context.entries.length, 2);
  assert.equal(
    context.entries.every((entry) => entry.symbol.length + entry.text.length <= 1_500),
    true,
  );
  assert.equal(
    context.entries.reduce((total, entry) => total + entry.symbol.length + entry.text.length, 0) <=
      4_000,
    true,
  );
});

test("skips semantic providers for untrusted and untitled documents", async () => {
  let untrustedCommands = 0;
  const untrusted = new VscodeSemanticContextProvider(
    createRuntime({ trusted: false, onCommand: () => (untrustedCommands += 1) }),
  );
  const untrustedContext = await untrusted.collect(createInput(), new AbortController().signal);
  assert.deepEqual(untrustedContext, { entries: [], dependencies: [] });
  assert.equal(untrustedCommands, 0);

  let untitledCommands = 0;
  const untitledUri = TestUri.parse("untitled:example.ts");
  const untitled = new VscodeSemanticContextProvider(
    createRuntime({ sourceUri: untitledUri, onCommand: () => (untitledCommands += 1) }),
  );
  const untitledContext = await untitled.collect(
    createInput({ documentUri: untitledUri.toString(), workspaceId: undefined }),
    new AbortController().signal,
  );
  assert.deepEqual(untitledContext, { entries: [], dependencies: [] });
  assert.equal(untitledCommands, 0);
});

test("rejects promptly with AbortError when a provider never settles", async () => {
  const never = new Promise<unknown>(() => undefined);
  const provider = new VscodeSemanticContextProvider(createRuntime({ hover: never }));
  const controller = new AbortController();
  const pending = provider.collect(createInput(), controller.signal);
  await Promise.resolve();
  controller.abort();

  await assert.rejects(pending, (error: unknown) => {
    assert.equal((error as Error).name, "AbortError");
    return true;
  });
});

test("returns the collected fallback when provider work crosses the deadline", async () => {
  const never = new Promise<unknown>(() => undefined);
  const provider = new VscodeSemanticContextProvider(createRuntime({ hover: never }));
  const started = Date.now();
  const context = await provider.collect(createInput(), new AbortController().signal);
  const elapsed = Date.now() - started;

  assert.equal(context.entries.length, 0);
  assert.deepEqual(context.dependencies, [{ uri: "file:///workspace/src/example.ts", version: 1 }]);
  assert.equal(elapsed >= 500 && elapsed < 1_000, true);
});

test("treats optional provider failures as absent evidence", async () => {
  const provider = new VscodeSemanticContextProvider(
    createRuntime({
      hover: [{ contents: ["available"] }],
      definitions: Promise.reject(new Error("definition provider unavailable")),
    }),
  );
  const context = await provider.collect(createInput(), new AbortController().signal);

  assert.deepEqual(
    context.entries.map((entry) => entry.kind),
    ["hover", "hover"],
  );
});

test("drops definition evidence when its document changes during collection", async () => {
  const rootPath = await mkdtemp(join(tmpdir(), "code-subtitle-semantic-fresh-"));
  const sourcePath = join(rootPath, "example.ts");
  const definitionPath = join(rootPath, "lib.ts");
  try {
    await writeFile(sourcePath, "update(value);\n", "utf8");
    await writeFile(definitionPath, "function update(value) {\n  return value;\n}\n", "utf8");
    const sourceUri = TestUri.parse(pathToFileURL(sourcePath).href);
    const definitionUri = TestUri.parse(pathToFileURL(definitionPath).href);
    const definitionDocument = createDocument(
      definitionUri,
      "function update(value) {\n  return value;\n}\n",
      2,
    ) as FakeDocument & { version: number };
    const targetRange = new TestRange(new TestPosition(0, 9), new TestPosition(0, 15));
    const symbolRange = new TestRange(new TestPosition(0, 0), new TestPosition(2, 1));
    let releaseSymbols!: () => void;
    const symbols = new Promise<unknown>((resolve) => {
      releaseSymbols = () =>
        resolve([{ range: symbolRange, selectionRange: targetRange, children: [] }]);
    });
    const runtime = createRuntime({
      sourceUri,
      rootUri: TestUri.parse(pathToFileURL(rootPath).href),
      source: createDocument(sourceUri, "update(value);\n", 1),
      documents: new Map([[definitionUri.toString(), definitionDocument]]),
      definitions: [{ uri: definitionUri, range: targetRange }],
      symbols,
      onCommand: (name) => {
        if (name === "vscode.executeDocumentSymbolProvider") {
          definitionDocument.version = 3;
          releaseSymbols();
        }
      },
    });

    const provider = new VscodeSemanticContextProvider(runtime);
    const context = await provider.collect(
      createInput({
        documentUri: sourceUri.toString(),
        workspaceId: pathToFileURL(rootPath).href,
      }),
      new AbortController().signal,
    );

    assert.deepEqual(context.entries, []);
  } finally {
    await rm(rootPath, { recursive: true, force: true });
  }
});

test("uses a labeled declaration excerpt for oversized definition ranges", async () => {
  const rootPath = await mkdtemp(join(tmpdir(), "code-subtitle-semantic-large-"));
  const sourcePath = join(rootPath, "example.ts");
  const definitionPath = join(rootPath, "lib.ts");
  try {
    const definitionText = [
      "function huge() {",
      ...Array.from({ length: 40 }, () => "  work();"),
      "}",
    ].join("\n");
    await writeFile(sourcePath, "huge();\n", "utf8");
    await writeFile(definitionPath, definitionText, "utf8");
    const sourceUri = TestUri.parse(pathToFileURL(sourcePath).href);
    const definitionUri = TestUri.parse(pathToFileURL(definitionPath).href);
    const runtime = createRuntime({
      sourceUri,
      rootUri: TestUri.parse(pathToFileURL(rootPath).href),
      source: createDocument(sourceUri, "huge();\n", 1),
      documents: new Map([
        [definitionUri.toString(), createDocument(definitionUri, definitionText, 2)],
      ]),
      definitions: [
        {
          uri: definitionUri,
          range: new TestRange(new TestPosition(0, 0), new TestPosition(40, 1)),
        },
      ],
    });

    const provider = new VscodeSemanticContextProvider(runtime);
    const context = await provider.collect(
      createInput({
        documentUri: sourceUri.toString(),
        selection: "huge();",
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 7 } },
        workspaceId: pathToFileURL(rootPath).href,
      }),
      new AbortController().signal,
    );

    assert.deepEqual(context.entries, [
      {
        kind: "definition",
        symbol: "huge",
        text: "[declaration excerpt; implementation omitted]\nfunction huge() {",
      },
    ]);
  } finally {
    await rm(rootPath, { recursive: true, force: true });
  }
});

test("rejects definition symlinks that resolve outside the originating workspace", async () => {
  const rootPath = await mkdtemp(join(tmpdir(), "code-subtitle-semantic-root-"));
  const outsidePath = await mkdtemp(join(tmpdir(), "code-subtitle-semantic-outside-"));
  try {
    const sourcePath = join(rootPath, "example.ts");
    const targetPath = join(outsidePath, "lib.ts");
    const linkPath = join(rootPath, "linked.ts");
    await writeFile(sourcePath, "update();\n", "utf8");
    await writeFile(targetPath, "function update() {}\n", "utf8");
    await symlink(targetPath, linkPath);
    const sourceUri = TestUri.parse(pathToFileURL(sourcePath).href);
    const linkUri = TestUri.parse(pathToFileURL(linkPath).href);
    let openedLink = false;
    const runtime = createRuntime({
      sourceUri,
      rootUri: TestUri.parse(pathToFileURL(rootPath).href),
      source: createDocument(sourceUri, "update();\n", 1),
      definitions: [
        {
          uri: linkUri,
          range: new TestRange(new TestPosition(0, 9), new TestPosition(0, 15)),
        },
      ],
      onOpenDocument: (uri) => {
        if (uri.toString() === linkUri.toString()) {
          openedLink = true;
        }
      },
    });

    const provider = new VscodeSemanticContextProvider(runtime);
    const context = await provider.collect(
      createInput({
        documentUri: sourceUri.toString(),
        selection: "update();",
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 9 } },
        workspaceId: pathToFileURL(rootPath).href,
      }),
      new AbortController().signal,
    );

    assert.deepEqual(context.entries, []);
    assert.equal(openedLink, false);
  } finally {
    await rm(rootPath, { recursive: true, force: true });
    await rm(outsidePath, { recursive: true, force: true });
  }
});
