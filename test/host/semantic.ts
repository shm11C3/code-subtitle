import assert from "node:assert/strict";
import * as vscode from "vscode";
import { VscodeSemanticContextProvider } from "../../src/vscode-semantic.js";
import type { SubtitleInput } from "../../src/contracts.js";

const FIXTURE_FILE = "semantic-fixture.ts";
const POLL_INTERVAL_MS = 250;
const POLL_TIMEOUT_MS = 15_000;
const PROVIDER_QUERY_TIMEOUT_MS = 2_000;

const SOURCE = [
  "interface Widget {",
  "  id: string;",
  "}",
  "",
  "function buildWidget(id: string): Widget {",
  "  return { id };",
  "}",
  "",
  'const widget = buildWidget("alpha");',
  "widget.id;",
  "",
].join("\n");

const CROSS_FILE_SOURCE = [
  'import { normalizeValue } from "./semantic-dependency";',
  "",
  'const normalized = normalizeValue(" ALPHA ");',
  "normalized;",
  "",
].join("\n");

const DEPENDENCY_SOURCE = [
  "export function normalizeValue(value: string): string {",
  "  return value.trim().toLowerCase();",
  "}",
  "",
].join("\n");

interface Target {
  readonly uri: vscode.Uri;
  readonly range: vscode.Range;
}

interface ProviderResults {
  readonly hover: unknown;
  readonly definitions: readonly Target[];
  readonly typeDefinitions: readonly Target[];
}

/** Exercises VS Code's real TypeScript providers without making a model request. */
export async function runSemanticSmoke(): Promise<void> {
  const mode = process.env.CODE_SUBTITLE_SEMANTIC_HOST || "builtin";
  assert.ok(mode === "builtin" || mode === "native", `Unknown semantic host mode: ${mode}`);

  const extension = findLanguageExtension(mode);
  assert.ok(extension, `The ${mode} TypeScript extension is available.`);
  const activation = await extension.activate();
  if (mode === "native") {
    assert.ok(extension.isActive, "The TypeScript 7 native-preview extension is active.");
    assert.ok(
      isNativePreviewApi(activation),
      "The TypeScript 7 native-preview activation exposes its language-server API.",
    );
  }

  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  assert.ok(workspaceFolder, "The semantic smoke runs inside a workspace folder.");
  assert.equal(
    workspaceFolder.uri.scheme,
    "file",
    "The semantic fixture uses a local file workspace.",
  );

  if (mode === "native") {
    await waitForNativeSelection();
  }

  const fixtureUri = vscode.Uri.joinPath(workspaceFolder.uri, FIXTURE_FILE);
  await vscode.workspace.fs.writeFile(fixtureUri, Buffer.from(SOURCE, "utf8"));
  const document = await vscode.workspace.openTextDocument(fixtureUri);
  const editor = await vscode.window.showTextDocument(document, {
    preserveFocus: true,
    preview: false,
  });
  const before = {
    text: document.getText(),
    version: document.version,
    dirty: document.isDirty,
    selection: editor.selection,
  };

  const functionOffset = SOURCE.indexOf("function buildWidget");
  const declarationOffset = SOURCE.indexOf("const widget");
  const definitionOffset = SOURCE.indexOf(
    "buildWidget(",
    functionOffset + "function buildWidget".length,
  );
  const variableOffset = SOURCE.indexOf("widget", declarationOffset + "const widget".length);
  assert.ok(functionOffset >= 0, "The synthetic declaration exists.");
  assert.ok(declarationOffset >= 0, "The synthetic variable declaration exists.");
  assert.ok(definitionOffset >= 0, "The synthetic call site exists.");
  assert.ok(variableOffset >= 0, "The synthetic variable use exists.");
  const definitionLine = document.positionAt(functionOffset).line;
  const typeLine = document.positionAt(SOURCE.indexOf("interface Widget")).line;

  const results = await waitForProviderResults(
    document,
    document.positionAt(definitionOffset),
    document.positionAt(variableOffset),
    definitionLine,
    typeLine,
  );
  const hover = hoverText(results.hover);
  assert.ok(hover.length > 0, "Hover returns typed text.");
  assert.match(hover, /buildWidget|Widget/, "Hover identifies the synthetic symbol.");
  assert.match(hover, /string|Widget/, "Hover includes useful type information.");

  const definition = results.definitions.find(
    (target) =>
      target.uri.toString() === document.uri.toString() &&
      target.range.start.line === definitionLine,
  );
  assert.ok(definition, "Definition resolves to the synthetic declaration in the workspace.");

  const typeDefinition = results.typeDefinitions.find(
    (target) =>
      target.uri.toString() === document.uri.toString() && target.range.start.line === typeLine,
  );
  assert.ok(
    typeDefinition,
    "Type definition resolves to the synthetic interface in the workspace.",
  );

  const semanticContext = await new VscodeSemanticContextProvider(vscode).collect(
    createSemanticInput(document, workspaceFolder),
    new AbortController().signal,
  );
  assert.ok(
    semanticContext.entries.some(
      (entry) =>
        entry.kind === "hover" &&
        entry.symbol === "buildWidget" &&
        /buildWidget|Widget/.test(entry.text) &&
        /string|Widget/.test(entry.text),
    ),
    "The semantic adapter includes typed hover evidence for the call site.",
  );
  assert.ok(
    semanticContext.entries.some(
      (entry) =>
        entry.kind === "definition" &&
        entry.symbol === "buildWidget" &&
        entry.text.includes("return { id }"),
    ),
    "The semantic adapter includes the local function definition body.",
  );

  assert.equal(document.getText(), before.text, "Provider queries do not mutate source text.");
  assert.equal(
    document.version,
    before.version,
    "Provider queries do not change document version.",
  );
  assert.equal(
    document.isDirty,
    before.dirty,
    "Provider queries do not dirty the source document.",
  );
  assert.deepEqual(editor.selection, before.selection, "Provider queries do not change selection.");
  await runCrossFileSemanticSmoke(workspaceFolder);
  console.log(
    `Code Subtitle semantic host smoke (${mode}): passed (Hover, Definition, TypeDefinition; no model requests).`,
  );
}

function findLanguageExtension(mode: "builtin" | "native"): vscode.Extension<unknown> | undefined {
  const expectedName = mode === "native" ? "native-preview" : "typescript-language-features";
  const expectedPublisher = mode === "native" ? "typescriptteam" : "vscode";
  return vscode.extensions.all.find((extension) => {
    const packageJson = extension.packageJSON as { name?: unknown; publisher?: unknown };
    return (
      packageJson.name === expectedName &&
      String(packageJson.publisher).toLowerCase() === expectedPublisher
    );
  });
}

async function waitForNativeSelection(): Promise<void> {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  let lastValue: unknown;
  while (Date.now() < deadline) {
    lastValue = vscode.workspace.getConfiguration("js/ts").get("experimental.useTsgo");
    if (lastValue === true) {
      return;
    }
    await delay(POLL_INTERVAL_MS);
  }
  throw new Error(
    `TypeScript 7 native-preview did not select tsgo in the isolated profile (value: ${String(lastValue)}).`,
  );
}

function isNativePreviewApi(value: unknown): value is { onLanguageServerInitialized: unknown } {
  return (
    typeof value === "object" &&
    value !== null &&
    "onLanguageServerInitialized" in value &&
    typeof value.onLanguageServerInitialized === "function"
  );
}

function createSemanticInput(
  document: vscode.TextDocument,
  workspaceFolder: vscode.WorkspaceFolder,
  startLine = 8,
  endLine = 9,
): SubtitleInput {
  const range = new vscode.Range(
    new vscode.Position(startLine, 0),
    new vscode.Position(endLine, document.lineAt(endLine).text.length),
  );
  return {
    documentUri: document.uri.toString(),
    documentVersion: document.version,
    editorId: "semantic-host-smoke",
    workspaceId: workspaceFolder.uri.toString(),
    range: {
      start: { line: range.start.line, character: range.start.character },
      end: { line: range.end.line, character: range.end.character },
    },
    anchorLine: startLine,
    languageId: document.languageId,
    outputLanguage: "en",
    selection: document.getText(range),
    before: "",
    after: "",
  };
}

async function runCrossFileSemanticSmoke(workspaceFolder: vscode.WorkspaceFolder): Promise<void> {
  const sourceUri = vscode.Uri.joinPath(workspaceFolder.uri, "semantic-cross-file.ts");
  const dependencyUri = vscode.Uri.joinPath(workspaceFolder.uri, "semantic-dependency.ts");
  await vscode.workspace.fs.writeFile(sourceUri, Buffer.from(CROSS_FILE_SOURCE, "utf8"));
  await vscode.workspace.fs.writeFile(dependencyUri, Buffer.from(DEPENDENCY_SOURCE, "utf8"));

  const [sourceDocument, dependencyDocument] = await Promise.all([
    vscode.workspace.openTextDocument(sourceUri),
    vscode.workspace.openTextDocument(dependencyUri),
  ]);
  const editor = await vscode.window.showTextDocument(sourceDocument, {
    preserveFocus: true,
    preview: false,
  });
  const sourceBefore = {
    text: sourceDocument.getText(),
    version: sourceDocument.version,
    dirty: sourceDocument.isDirty,
    selection: editor.selection,
  };
  const dependencyBefore = {
    text: dependencyDocument.getText(),
    version: dependencyDocument.version,
    dirty: dependencyDocument.isDirty,
  };

  const callOffset = CROSS_FILE_SOURCE.indexOf("normalizeValue(");
  const helperOffset = DEPENDENCY_SOURCE.indexOf("export function normalizeValue");
  assert.ok(callOffset >= 0, "The cross-file helper call exists.");
  assert.ok(helperOffset >= 0, "The cross-file helper declaration exists.");
  const helperLine = dependencyDocument.positionAt(helperOffset).line;
  const definition = await waitForDefinitionTarget(
    sourceDocument,
    sourceDocument.positionAt(callOffset),
    dependencyUri,
    helperLine,
  );
  assert.equal(
    definition.uri.toString(),
    dependencyUri.toString(),
    "Cross-file Definition resolves to the helper document.",
  );

  const semanticContext = await new VscodeSemanticContextProvider(vscode).collect(
    createSemanticInput(sourceDocument, workspaceFolder, 2, 3),
    new AbortController().signal,
  );
  assert.ok(
    semanticContext.entries.some(
      (entry) =>
        entry.kind === "definition" &&
        entry.symbol === "normalizeValue" &&
        entry.text.includes("return value.trim().toLowerCase();"),
    ),
    "The semantic adapter includes the imported helper body.",
  );
  assert.ok(
    semanticContext.dependencies.some(
      (dependency) =>
        dependency.uri === dependencyUri.toString() &&
        dependency.version === dependencyDocument.version,
    ),
    "The semantic adapter tracks the imported helper dependency.",
  );

  assert.equal(sourceDocument.getText(), sourceBefore.text);
  assert.equal(sourceDocument.version, sourceBefore.version);
  assert.equal(sourceDocument.isDirty, sourceBefore.dirty);
  assert.deepEqual(editor.selection, sourceBefore.selection);
  assert.equal(dependencyDocument.getText(), dependencyBefore.text);
  assert.equal(dependencyDocument.version, dependencyBefore.version);
  assert.equal(dependencyDocument.isDirty, dependencyBefore.dirty);
  console.log("Code Subtitle cross-file semantic smoke: passed (no model requests).");
}

async function waitForProviderResults(
  document: vscode.TextDocument,
  callPosition: vscode.Position,
  variablePosition: vscode.Position,
  definitionLine: number,
  typeLine: number,
): Promise<ProviderResults> {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const [hover, definitions, typeDefinitions] = await Promise.all([
        executeProviderWithTimeout("vscode.executeHoverProvider", document.uri, callPosition),
        executeProviderWithTimeout("vscode.executeDefinitionProvider", document.uri, callPosition),
        executeProviderWithTimeout(
          "vscode.executeTypeDefinitionProvider",
          document.uri,
          variablePosition,
        ),
      ]);
      const results = {
        hover,
        definitions: providerTargets(definitions),
        typeDefinitions: providerTargets(typeDefinitions),
      };
      if (
        hoverText(results.hover).length > 0 &&
        results.definitions.some(
          (target) =>
            target.uri.toString() === document.uri.toString() &&
            target.range.start.line === definitionLine,
        ) &&
        results.typeDefinitions.some(
          (target) =>
            target.uri.toString() === document.uri.toString() &&
            target.range.start.line === typeLine,
        )
      ) {
        return results;
      }
    } catch (error: unknown) {
      lastError = error;
    }
    await delay(POLL_INTERVAL_MS);
  }
  throw new Error(
    `TypeScript providers did not return useful results before timeout: ${String(lastError)}`,
  );
}

async function waitForDefinitionTarget(
  document: vscode.TextDocument,
  position: vscode.Position,
  expectedUri: vscode.Uri,
  expectedLine: number,
): Promise<Target> {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const definitions = await executeProviderWithTimeout(
        "vscode.executeDefinitionProvider",
        document.uri,
        position,
      );
      const target = providerTargets(definitions).find(
        (candidate) =>
          candidate.uri.toString() === expectedUri.toString() &&
          candidate.range.start.line === expectedLine,
      );
      if (target) {
        return target;
      }
    } catch (error: unknown) {
      lastError = error;
    }
    await delay(POLL_INTERVAL_MS);
  }
  throw new Error(`Cross-file Definition did not resolve before timeout: ${String(lastError)}`);
}

function providerTargets(value: unknown): readonly Target[] {
  const values = Array.isArray(value) ? value : value === undefined ? [] : [value];
  return values.flatMap((item) => {
    const target = providerTarget(item);
    return target ? [target] : [];
  });
}

function providerTarget(value: unknown): Target | undefined {
  if (value instanceof vscode.Location) {
    return { uri: value.uri, range: value.range };
  }
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const uri = asUri(record.uri ?? record.targetUri);
  const range = asRange(record.range ?? record.targetSelectionRange ?? record.targetRange);
  return uri && range ? { uri, range } : undefined;
}

function asUri(value: unknown): vscode.Uri | undefined {
  return value instanceof vscode.Uri ? value : undefined;
}

function asRange(value: unknown): vscode.Range | undefined {
  if (value instanceof vscode.Range) {
    return value;
  }
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const start = asPosition(record.start);
  const end = asPosition(record.end);
  return start && end ? new vscode.Range(start, end) : undefined;
}

function asPosition(value: unknown): vscode.Position | undefined {
  if (value instanceof vscode.Position) {
    return value;
  }
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  return typeof record.line === "number" && typeof record.character === "number"
    ? new vscode.Position(record.line, record.character)
    : undefined;
}

function hoverText(value: unknown): string {
  const hover = Array.isArray(value) ? value[0] : value;
  if (!hover || typeof hover !== "object") {
    return "";
  }
  const contents = (hover as { contents?: unknown }).contents;
  const values = Array.isArray(contents) ? contents : contents === undefined ? [] : [contents];
  return values.map(markedStringText).join("\n").trim();
}

function markedStringText(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (typeof record.value === "string") {
      return record.value;
    }
  }
  return "";
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function executeProviderWithTimeout(
  command: string,
  uri: vscode.Uri,
  position: vscode.Position,
): Promise<unknown> {
  let timer: unknown;
  try {
    return await Promise.race([
      vscode.commands.executeCommand(command, uri, position),
      new Promise<undefined>((resolve) => {
        timer = setTimeout(resolve, PROVIDER_QUERY_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timer !== undefined) {
      globalThis.clearTimeout(timer as unknown as number);
    }
  }
}
