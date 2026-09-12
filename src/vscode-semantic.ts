import type * as vscode from "vscode";
import { realpath } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type {
  SemanticContext,
  SemanticContextProvider,
  SemanticEntry,
  SubtitleInput,
} from "./contracts.js";

const COLLECTION_DEADLINE_MS = 600;
const MAX_IDENTIFIERS = 3;
const MAX_LOCATIONS_PER_KIND = 3;
const MAX_EVIDENCE_UNITS = 4_000;
const MAX_ENTRY_UNITS = 1_500;
const MAX_DEFINITION_LINES = 40;
const MAX_DECLARATION_LINE_UNITS = 1_500;

const HOVER_COMMAND = "vscode.executeHoverProvider";
const DEFINITION_COMMAND = "vscode.executeDefinitionProvider";
const TYPE_DEFINITION_COMMAND = "vscode.executeTypeDefinitionProvider";
const DOCUMENT_SYMBOL_COMMAND = "vscode.executeDocumentSymbolProvider";

/**
 * The small VS Code surface used by the semantic adapter. Keeping this at the
 * boundary makes the provider deterministic in node tests and avoids loading
 * the extension-host `vscode` module at import time.
 */
export interface VscodeSemanticContextRuntime {
  readonly commands: Pick<typeof vscode.commands, "executeCommand">;
  readonly workspace: Pick<
    typeof vscode.workspace,
    "openTextDocument" | "getWorkspaceFolder" | "isTrusted"
  >;
  readonly Uri: Pick<typeof vscode.Uri, "parse">;
  readonly Position: typeof vscode.Position;
  readonly Range: typeof vscode.Range;
}

interface Candidate {
  readonly symbol: string;
  readonly position: vscode.Position;
  readonly callSite: boolean;
  readonly order: number;
}

interface Scope {
  readonly sourceUri: vscode.Uri;
  readonly folder: vscode.WorkspaceFolder;
}

interface Operation {
  readonly deadline: number;
  closed: boolean;
  readonly canonicalPaths: Map<string, Promise<string | undefined>>;
}

interface DependencyDocument {
  readonly uri: vscode.Uri;
  readonly document: vscode.TextDocument;
  readonly version: number;
}

interface ResolvedLocation {
  readonly uri: vscode.Uri;
  readonly range: vscode.Range;
  readonly selectionRange?: vscode.Range;
}

interface SymbolLike {
  readonly range?: vscode.Range;
  readonly selectionRange?: vscode.Range;
  readonly children?: readonly SymbolLike[];
  readonly location?: { readonly uri?: vscode.Uri; readonly range?: vscode.Range };
}

interface CollectedCandidate {
  readonly entries: SemanticEntry[];
  readonly dependencies: DependencyDocument[];
}

/**
 * Collects a deliberately small amount of local semantic evidence for one
 * subtitle request. Provider text is evidence only; it is never interpreted
 * as an instruction by this adapter.
 */
export class VscodeSemanticContextProvider implements SemanticContextProvider {
  constructor(private readonly runtime: VscodeSemanticContextRuntime) {}

  async collect(input: SubtitleInput, signal: AbortSignal): Promise<SemanticContext> {
    throwIfAborted(signal);

    const scope = this.resolveScope(input);
    if (!scope) {
      return { entries: [], dependencies: [] };
    }

    const operation: Operation = {
      deadline: Date.now() + COLLECTION_DEADLINE_MS,
      closed: false,
      canonicalPaths: new Map(),
    };
    const sourceDependency = {
      uri: input.documentUri,
      version: input.documentVersion,
    };
    const dependencies = new Map<string, DependencyDocument>();
    const dependencyVersions = new Map<string, number>();
    const dependencyUris = new Map<string, vscode.Uri>();
    dependencyVersions.set(sourceDependency.uri, sourceDependency.version);

    const candidates = selectCandidates(input, this.runtime);
    const entries: SemanticEntry[] = [];
    const seenEntries = new Set<string>();
    const seenLocations = new Set<string>();
    const documentCache = new Map<string, Promise<vscode.TextDocument | undefined>>();
    const symbolCache = new Map<string, Promise<readonly SymbolLike[] | undefined>>();

    try {
      for (const candidate of candidates) {
        if (!isActive(operation, signal)) {
          break;
        }

        const collected = await this.collectCandidate(
          candidate,
          scope,
          operation,
          signal,
          documentCache,
          symbolCache,
          seenLocations,
        );
        if (collected === undefined) {
          continue;
        }

        for (const entry of collected.entries) {
          const bounded = boundEntry(entry, MAX_ENTRY_UNITS);
          if (bounded === undefined) {
            continue;
          }
          const key = `${bounded.kind}\u0000${bounded.symbol}\u0000${bounded.text}`;
          if (seenEntries.has(key)) {
            continue;
          }
          const used = entries.reduce(
            (total, current) => total + current.symbol.length + current.text.length,
            0,
          );
          if (used + bounded.symbol.length + bounded.text.length > MAX_EVIDENCE_UNITS) {
            break;
          }
          seenEntries.add(key);
          entries.push(bounded);
        }

        for (const dependency of collected.dependencies) {
          const uri = dependency.uri.toString();
          if (!dependencies.has(uri)) {
            dependencies.set(uri, dependency);
            dependencyUris.set(uri, dependency.uri);
            dependencyVersions.set(uri, dependency.version);
          }
        }
      }

      throwIfAborted(signal);
      const fresh = await this.recheckDependencies(
        input,
        operation,
        signal,
        dependencies,
        dependencyVersions,
        dependencyUris,
        documentCache,
      );
      if (!fresh) {
        return { entries: [], dependencies: [sourceDependency] };
      }

      return {
        entries,
        dependencies: [
          sourceDependency,
          ...[...dependencyVersions.entries()]
            .filter(([uri]) => uri !== sourceDependency.uri)
            .map(([uri, version]) => ({ uri, version })),
        ],
      };
    } finally {
      operation.closed = true;
    }
  }

  private resolveScope(input: SubtitleInput): Scope | undefined {
    if (!this.runtime.workspace.isTrusted) {
      return undefined;
    }

    let sourceUri: vscode.Uri;
    try {
      sourceUri = this.runtime.Uri.parse(input.documentUri) as vscode.Uri;
    } catch {
      return undefined;
    }
    if (uriScheme(sourceUri) !== "file") {
      return undefined;
    }

    try {
      const folder = this.runtime.workspace.getWorkspaceFolder(sourceUri);
      if (!folder || uriScheme(folder.uri) !== "file") {
        return undefined;
      }
      if (!isUriWithinFolder(sourceUri, folder.uri)) {
        return undefined;
      }
      return { sourceUri, folder };
    } catch {
      return undefined;
    }
  }

  private async collectCandidate(
    candidate: Candidate,
    scope: Scope,
    operation: Operation,
    signal: AbortSignal,
    documentCache: Map<string, Promise<vscode.TextDocument | undefined>>,
    symbolCache: Map<string, Promise<readonly SymbolLike[] | undefined>>,
    seenLocations: Set<string>,
  ): Promise<CollectedCandidate | undefined> {
    if (!isActive(operation, signal)) {
      return undefined;
    }

    const entries: SemanticEntry[] = [];
    const dependencies: DependencyDocument[] = [];

    const hover = await this.executeProvider<unknown>(
      HOVER_COMMAND,
      [scope.sourceUri, candidate.position],
      operation,
      signal,
    );
    if (!isActive(operation, signal)) {
      throwIfAborted(signal);
      return { entries, dependencies };
    }
    const hoverText = collectHoverText(hover);
    if (hoverText.length > 0) {
      entries.push({ kind: "hover", symbol: candidate.symbol, text: hoverText });
    }

    const definitions = await this.executeProvider<unknown>(
      DEFINITION_COMMAND,
      [scope.sourceUri, candidate.position],
      operation,
      signal,
    );
    if (!isActive(operation, signal)) {
      throwIfAborted(signal);
      return { entries, dependencies };
    }
    const definition = await this.resolveDefinitions(
      "definition",
      definitions,
      candidate.symbol,
      scope,
      operation,
      signal,
      documentCache,
      symbolCache,
      seenLocations,
    );
    entries.push(...definition.entries);
    dependencies.push(...definition.dependencies);

    const typeDefinitions = await this.executeProvider<unknown>(
      TYPE_DEFINITION_COMMAND,
      [scope.sourceUri, candidate.position],
      operation,
      signal,
    );
    if (!isActive(operation, signal)) {
      throwIfAborted(signal);
      return { entries, dependencies };
    }
    const typeDefinition = await this.resolveDefinitions(
      "typeDefinition",
      typeDefinitions,
      candidate.symbol,
      scope,
      operation,
      signal,
      documentCache,
      symbolCache,
      seenLocations,
    );
    entries.push(...typeDefinition.entries);
    dependencies.push(...typeDefinition.dependencies);

    return { entries, dependencies };
  }

  private async resolveDefinitions(
    kind: "definition" | "typeDefinition",
    raw: unknown,
    symbol: string,
    scope: Scope,
    operation: Operation,
    signal: AbortSignal,
    documentCache: Map<string, Promise<vscode.TextDocument | undefined>>,
    symbolCache: Map<string, Promise<readonly SymbolLike[] | undefined>>,
    seenLocations: Set<string>,
  ): Promise<CollectedCandidate> {
    const entries: SemanticEntry[] = [];
    const dependencies: DependencyDocument[] = [];
    const locations = normalizeLocations(raw);

    for (const location of locations.slice(0, MAX_LOCATIONS_PER_KIND)) {
      if (!isActive(operation, signal)) {
        break;
      }
      if (
        !(await isLocationInScope(location.uri, scope, operation, signal, this.runtime.workspace))
      ) {
        continue;
      }
      const locationKey = `${kind}\u0000${location.uri.toString()}\u0000${rangeKey(location.range)}`;
      if (seenLocations.has(locationKey)) {
        continue;
      }
      seenLocations.add(locationKey);

      const document = await this.openDocument(location.uri, operation, signal, documentCache);
      if (!isActive(operation, signal)) {
        throwIfAborted(signal);
        break;
      }
      if (!document) {
        continue;
      }
      const version = document.version;

      const resolved = await this.resolveDefinitionText(
        location,
        document,
        operation,
        signal,
        symbolCache,
      );
      if (!isActive(operation, signal)) {
        throwIfAborted(signal);
        break;
      }
      if (!resolved || resolved.text.length === 0) {
        continue;
      }

      entries.push({
        kind,
        symbol,
        text: resolved.text,
      });
      dependencies.push({ uri: location.uri, document, version });
      // One usable definition per kind is enough for a bounded subtitle
      // request; overloads and duplicate providers do not justify more file
      // reads in this path.
      break;
    }

    return { entries, dependencies };
  }

  private async resolveDefinitionText(
    location: ResolvedLocation,
    document: vscode.TextDocument,
    operation: Operation,
    signal: AbortSignal,
    symbolCache: Map<string, Promise<readonly SymbolLike[] | undefined>>,
  ): Promise<{ text: string } | undefined> {
    if (!isActive(operation, signal)) {
      return undefined;
    }

    const targetSpan = lineSpan(location.range);
    let range = location.range;
    let declarationExcerpt = false;
    if (targetSpan <= 1) {
      const symbols = await this.documentSymbols(location.uri, operation, signal, symbolCache);
      if (!isActive(operation, signal)) {
        throwIfAborted(signal);
        return undefined;
      }
      const enclosing = findEnclosingSymbol(symbols, location.range);
      if (enclosing?.range) {
        if (lineSpan(enclosing.range) <= MAX_DEFINITION_LINES) {
          range = enclosing.range;
        } else {
          range = declarationLineRange(document, location.selectionRange ?? location.range);
          declarationExcerpt = true;
        }
      } else {
        try {
          range = document.lineAt(location.range.start.line).range;
        } catch {
          range = location.selectionRange ?? location.range;
        }
      }
    } else if (targetSpan > MAX_DEFINITION_LINES) {
      range = declarationLineRange(document, location.selectionRange ?? location.range);
      declarationExcerpt = true;
    }

    let text = readDocumentRange(document, range);
    if (text.length === 0 && range !== location.range) {
      text = readDocumentRange(document, location.range);
    }
    if (text.length === 0) {
      return undefined;
    }
    if (text.length > MAX_ENTRY_UNITS && !declarationExcerpt) {
      range = declarationLineRange(document, location.selectionRange ?? range);
      text = readDocumentRange(document, range);
      declarationExcerpt = true;
    }
    if (declarationExcerpt) {
      const declaration = readDeclarationLine(document, range.start.line);
      if (declaration.length === 0) {
        return undefined;
      }
      text = `[declaration excerpt; implementation omitted]\n${declaration}`;
    }
    if (text.length > MAX_ENTRY_UNITS) {
      return undefined;
    }
    return { text };
  }

  private async documentSymbols(
    uri: vscode.Uri,
    operation: Operation,
    signal: AbortSignal,
    symbolCache: Map<string, Promise<readonly SymbolLike[] | undefined>>,
  ): Promise<readonly SymbolLike[] | undefined> {
    const key = uri.toString();
    const existing = symbolCache.get(key);
    if (existing) {
      return existing;
    }
    const pending = this.executeProvider<unknown>(
      DOCUMENT_SYMBOL_COMMAND,
      [uri],
      operation,
      signal,
    ).then((raw) => normalizeSymbols(raw));
    symbolCache.set(key, pending);
    return pending;
  }

  private async openDocument(
    uri: vscode.Uri,
    operation: Operation,
    signal: AbortSignal,
    documentCache: Map<string, Promise<vscode.TextDocument | undefined>>,
  ): Promise<vscode.TextDocument | undefined> {
    const key = uri.toString();
    const existing = documentCache.get(key);
    if (existing) {
      return existing;
    }
    const pending = this.executeProvider<vscode.TextDocument>(
      "__openTextDocument",
      [],
      operation,
      signal,
      () => this.runtime.workspace.openTextDocument(uri),
    );
    documentCache.set(key, pending);
    return pending;
  }

  private async executeProvider<T>(
    command: string,
    args: unknown[],
    operation: Operation,
    signal: AbortSignal,
    task?: () => Thenable<T>,
  ): Promise<T | undefined> {
    if (!isActive(operation, signal)) {
      throwIfAborted(signal);
      return undefined;
    }
    return bounded<T>(
      operation,
      signal,
      task ?? (() => this.runtime.commands.executeCommand<T>(command, ...args)),
    );
  }

  private async recheckDependencies(
    input: SubtitleInput,
    operation: Operation,
    signal: AbortSignal,
    dependencies: Map<string, DependencyDocument>,
    dependencyVersions: Map<string, number>,
    dependencyUris: Map<string, vscode.Uri>,
    documentCache: Map<string, Promise<vscode.TextDocument | undefined>>,
  ): Promise<boolean> {
    for (const [uri, dependency] of dependencies) {
      if (!isActive(operation, signal)) {
        throwIfAborted(signal);
        return true;
      }
      if (dependency.document.version !== dependency.version) {
        return false;
      }
      const targetUri = dependencyUris.get(uri);
      if (!targetUri) {
        continue;
      }
      const current = await this.openDocument(targetUri, operation, signal, documentCache);
      if (!isActive(operation, signal)) {
        throwIfAborted(signal);
        return true;
      }
      if (current && current.version !== dependencyVersions.get(uri)) {
        return false;
      }
    }
    // The source document is represented by the immutable request snapshot;
    // the host invalidates that snapshot when the source changes.
    return input.documentVersion >= 0;
  }
}

function selectCandidates(
  input: SubtitleInput,
  runtime: VscodeSemanticContextRuntime,
): Candidate[] {
  const candidates: Candidate[] = [];
  const bySymbol = new Map<string, Candidate>();
  const identifier = /[$A-Z_a-z][$\w]*/gu;
  let match: RegExpExecArray | null;
  let order = 0;
  while ((match = identifier.exec(input.selection)) !== null) {
    const symbol = match[0];
    if (isKeyword(symbol)) {
      continue;
    }
    const after = input.selection.slice(match.index + symbol.length);
    const before = input.selection.slice(0, match.index);
    const callSite = /^\s*\(/u.test(after);
    const member = /\.\s*$/u.test(before);
    const existing = bySymbol.get(symbol);
    const position = new runtime.Position(
      input.range.start.line + countNewlines(input.selection.slice(0, match.index)),
      characterAtOffset(input, match.index),
    ) as vscode.Position;
    const next: Candidate = { symbol, position, callSite: callSite || member, order };
    order += 1;
    if (!existing || (next.callSite && !existing.callSite)) {
      bySymbol.set(symbol, next);
    }
  }
  candidates.push(...bySymbol.values());
  candidates.sort((left, right) => {
    if (left.callSite !== right.callSite) {
      return left.callSite ? -1 : 1;
    }
    return left.order - right.order;
  });
  return candidates.slice(0, MAX_IDENTIFIERS);
}

function characterAtOffset(input: SubtitleInput, offset: number): number {
  const prefix = input.selection.slice(0, offset);
  const lineBreak = Math.max(prefix.lastIndexOf("\n"), prefix.lastIndexOf("\r"));
  return lineBreak < 0
    ? input.range.start.character + prefix.length
    : prefix.length - lineBreak - 1;
}

function countNewlines(value: string): number {
  return (value.match(/\r\n|\r|\n/gu) ?? []).length;
}

function isKeyword(symbol: string): boolean {
  return new Set([
    "as",
    "async",
    "await",
    "break",
    "case",
    "catch",
    "class",
    "const",
    "continue",
    "debugger",
    "default",
    "delete",
    "do",
    "else",
    "export",
    "extends",
    "finally",
    "for",
    "from",
    "function",
    "if",
    "implements",
    "import",
    "in",
    "instanceof",
    "interface",
    "let",
    "new",
    "of",
    "package",
    "private",
    "protected",
    "public",
    "return",
    "static",
    "super",
    "switch",
    "throw",
    "try",
    "type",
    "typeof",
    "var",
    "void",
    "while",
    "with",
    "yield",
  ]).has(symbol);
}

function collectHoverText(raw: unknown): string {
  const hovers = Array.isArray(raw) ? raw : raw === undefined || raw === null ? [] : [raw];
  const parts: string[] = [];
  for (const hover of hovers) {
    if (!isObject(hover)) {
      continue;
    }
    const contents = hover.contents;
    const values = Array.isArray(contents) ? contents : contents === undefined ? [] : [contents];
    for (const content of values) {
      const text = markedText(content);
      if (text.length > 0 && !parts.includes(text)) {
        parts.push(text);
      }
    }
  }
  return parts.join("\n");
}

function markedText(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (!isObject(value)) {
    return "";
  }
  if (typeof value.value === "string") {
    return value.value;
  }
  const stringifier = Reflect.get(value, "toString");
  if (typeof stringifier === "function" && stringifier !== Object.prototype.toString) {
    try {
      const result = Reflect.apply(stringifier, value, []);
      return typeof result === "string" ? result : "";
    } catch {
      return "";
    }
  }
  return "";
}

function normalizeLocations(raw: unknown): ResolvedLocation[] {
  const values = Array.isArray(raw) ? raw : raw === undefined || raw === null ? [] : [raw];
  const locations: ResolvedLocation[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    if (!isObject(value)) {
      continue;
    }
    const uri = isObject(value.uri) ? (value.uri as unknown as vscode.Uri) : undefined;
    const range = isRange(value.range) ? (value.range as vscode.Range) : undefined;
    const targetUri = isObject(value.targetUri)
      ? (value.targetUri as unknown as vscode.Uri)
      : undefined;
    const targetRange = isRange(value.targetRange)
      ? (value.targetRange as vscode.Range)
      : undefined;
    const resolvedUri = uri ?? targetUri;
    const resolvedRange = range ?? targetRange;
    if (!resolvedUri || !resolvedRange) {
      continue;
    }
    const selectionRange = isRange(value.targetSelectionRange)
      ? (value.targetSelectionRange as vscode.Range)
      : undefined;
    const key = `${resolvedUri.toString()}\u0000${rangeKey(resolvedRange)}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    locations.push({ uri: resolvedUri, range: resolvedRange, selectionRange });
  }
  return locations;
}

function normalizeSymbols(raw: unknown): readonly SymbolLike[] | undefined {
  if (!Array.isArray(raw)) {
    return undefined;
  }
  return raw.filter((value): value is SymbolLike => isObject(value));
}

function findEnclosingSymbol(
  symbols: readonly SymbolLike[] | undefined,
  target: vscode.Range,
): SymbolLike | undefined {
  if (!symbols) {
    return undefined;
  }
  let best: SymbolLike | undefined;
  for (const symbol of symbols) {
    const range = symbol.range ?? symbol.location?.range;
    if (!range || !containsRange(range, target)) {
      continue;
    }
    const bestRange = best?.range ?? best?.location?.range;
    if (!best || (bestRange && lineSpan(range) <= lineSpan(bestRange))) {
      best = symbol;
    }
    const child = findEnclosingSymbol(symbol.children, target);
    if (child) {
      best = child;
    }
  }
  return best;
}

function containsRange(outer: vscode.Range, inner: vscode.Range): boolean {
  return (
    comparePositions(outer.start, inner.start) <= 0 && comparePositions(outer.end, inner.end) >= 0
  );
}

function comparePositions(left: vscode.Position, right: vscode.Position): number {
  if (left.line !== right.line) {
    return left.line - right.line;
  }
  return left.character - right.character;
}

function readDocumentRange(document: vscode.TextDocument, range: vscode.Range): string {
  try {
    return document.getText(range).trim();
  } catch {
    return "";
  }
}

function readDeclarationLine(document: vscode.TextDocument, line: number): string {
  try {
    const text = document.lineAt(line).text.trim();
    return text.length > MAX_DECLARATION_LINE_UNITS ? "" : text;
  } catch {
    return "";
  }
}

function declarationLineRange(document: vscode.TextDocument, fallback: vscode.Range): vscode.Range {
  try {
    return document.lineAt(fallback.start.line).range;
  } catch {
    return fallback;
  }
}

function boundEntry(entry: SemanticEntry, budget: number): SemanticEntry | undefined {
  if (entry.kind !== "hover" && entry.text.length + entry.symbol.length > budget) {
    return undefined;
  }
  const symbol = takeUnits(entry.symbol, Math.min(entry.symbol.length, budget));
  const remaining = budget - symbol.length;
  if (symbol.length === 0 || remaining <= 0) {
    return undefined;
  }
  const text = takeUnits(entry.text, remaining);
  return text.length === 0 ? undefined : { ...entry, symbol, text };
}

function takeUnits(value: string, units: number): string {
  if (value.length <= units) {
    return value;
  }
  const clipped = value.slice(0, Math.max(0, units));
  const last = clipped.charCodeAt(clipped.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? clipped.slice(0, -1) : clipped;
}

function lineSpan(range: vscode.Range): number {
  return Math.max(1, range.end.line - range.start.line + 1);
}

function rangeKey(range: vscode.Range): string {
  return `${range.start.line}:${range.start.character}-${range.end.line}:${range.end.character}`;
}

function isRange(value: unknown): value is { start: vscode.Position; end: vscode.Position } {
  return (
    isObject(value) &&
    isObject(value.start) &&
    isObject(value.end) &&
    Number.isInteger(value.start.line) &&
    Number.isInteger(value.start.character) &&
    Number.isInteger(value.end.line) &&
    Number.isInteger(value.end.character)
  );
}

async function isLocationInScope(
  uri: vscode.Uri,
  scope: Scope,
  operation: Operation,
  signal: AbortSignal,
  workspace: VscodeSemanticContextRuntime["workspace"],
): Promise<boolean> {
  if (
    uriScheme(uri) !== "file" ||
    uriAuthority(uri) !== uriAuthority(scope.folder.uri) ||
    !isUriWithinFolder(uri, scope.folder.uri)
  ) {
    return false;
  }
  try {
    const targetFolder = workspace.getWorkspaceFolder(uri);
    if (!targetFolder || targetFolder.uri.toString() !== scope.folder.uri.toString()) {
      return false;
    }
  } catch {
    return false;
  }

  const targetPath = uriFilePath(uri);
  const folderPath = uriFilePath(scope.folder.uri);
  if (!targetPath || !folderPath) {
    return false;
  }
  const [canonicalTarget, canonicalFolder] = await Promise.all([
    canonicalPath(targetPath, operation, signal),
    canonicalPath(folderPath, operation, signal),
  ]);
  if (!canonicalTarget || !canonicalFolder) {
    return false;
  }
  return isPathWithin(canonicalTarget, canonicalFolder);
}

async function canonicalPath(
  value: string,
  operation: Operation,
  signal: AbortSignal,
): Promise<string | undefined> {
  const existing = operation.canonicalPaths.get(value);
  if (existing) {
    return existing;
  }
  const pending = bounded(operation, signal, () => realpath(value)).then((resolved) =>
    typeof resolved === "string" ? resolved : undefined,
  );
  operation.canonicalPaths.set(value, pending);
  return pending;
}

function uriFilePath(uri: unknown): string | undefined {
  if (isObject(uri) && typeof uri.fsPath === "string") {
    return uri.fsPath;
  }
  const text = uriString(uri);
  if (!text) {
    return undefined;
  }
  try {
    return fileURLToPath(text);
  } catch {
    return undefined;
  }
}

function isPathWithin(value: string, root: string): boolean {
  const normalizedRoot = normalizePath(root);
  const normalizedValue = normalizePath(value);
  return (
    normalizedValue === normalizedRoot ||
    normalizedValue.startsWith(
      `${normalizedRoot.endsWith("/") ? normalizedRoot : `${normalizedRoot}/`}`,
    )
  );
}

function isUriWithinFolder(uri: vscode.Uri, folder: vscode.Uri): boolean {
  const uriPath = uriPathValue(uri);
  const folderPath = uriPathValue(folder);
  if (uriPath === undefined || folderPath === undefined) {
    return false;
  }
  const normalizedFolder = normalizePath(folderPath);
  const normalizedUri = normalizePath(uriPath);
  return (
    normalizedUri === normalizedFolder ||
    normalizedUri.startsWith(
      `${normalizedFolder.endsWith("/") ? normalizedFolder : `${normalizedFolder}/`}`,
    )
  );
}

function uriScheme(uri: unknown): string | undefined {
  if (isObject(uri) && typeof uri.scheme === "string") {
    return uri.scheme.toLowerCase();
  }
  const text = uriString(uri);
  const separator = text.indexOf(":");
  return separator > 0 ? text.slice(0, separator).toLowerCase() : undefined;
}

function uriAuthority(uri: unknown): string {
  if (isObject(uri) && typeof uri.authority === "string") {
    return uri.authority.toLowerCase();
  }
  return "";
}

function uriPathValue(uri: unknown): string | undefined {
  if (isObject(uri) && typeof uri.path === "string") {
    return uri.path;
  }
  const text = uriString(uri);
  const match = /^[a-z][a-z0-9+.-]*:\/\/[^/]*(\/.*)?$/iu.exec(text);
  return match?.[1] ?? undefined;
}

function normalizePath(value: string): string {
  const normalized = value.replaceAll("\\", "/").replace(/\/+/gu, "/");
  if (normalized.length > 1 && normalized.endsWith("/")) {
    return normalized.slice(0, -1);
  }
  return normalized;
}

function uriString(uri: unknown): string {
  const stringifier = isObject(uri) ? Reflect.get(uri, "toString") : undefined;
  if (typeof stringifier === "function" && stringifier !== Object.prototype.toString) {
    try {
      const result = Reflect.apply(stringifier, uri, []);
      return typeof result === "string" ? result : "";
    } catch {
      return "";
    }
  }
  return "";
}

function isObject(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null;
}

function isActive(operation: Operation, signal: AbortSignal): boolean {
  return !operation.closed && !signal.aborted && Date.now() < operation.deadline;
}

async function bounded<T>(
  operation: Operation,
  signal: AbortSignal,
  task: () => Thenable<T>,
): Promise<T | undefined> {
  if (!isActive(operation, signal)) {
    throwIfAborted(signal);
    return undefined;
  }
  const remaining = Math.max(1, operation.deadline - Date.now());
  return new Promise<T | undefined>((resolve, reject) => {
    let settled = false;
    const timer = globalThis.setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolve(undefined);
    }, remaining);
    const onAbort = (): void => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      reject(abortError());
    };
    const cleanup = (): void => {
      globalThis.clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    Promise.resolve()
      .then(task)
      .then(
        (value) => {
          if (settled) {
            return;
          }
          settled = true;
          cleanup();
          resolve(value);
        },
        () => {
          if (settled) {
            return;
          }
          settled = true;
          cleanup();
          resolve(undefined);
        },
      );
  });
}

function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) {
    return;
  }
  throw abortError();
}

function abortError(): Error {
  const error = new Error("aborted");
  error.name = "AbortError";
  return error;
}
