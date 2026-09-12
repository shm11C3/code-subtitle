export interface Position {
  line: number;
  character: number;
}
export interface SelectionRange {
  start: Position;
  end: Position;
}

export interface SubtitleInput {
  documentUri: string;
  documentVersion: number;
  editorId: string;
  workspaceId?: string;
  range: SelectionRange;
  anchorLine: number;
  languageId: string;
  outputLanguage: string;
  selection: string;
  before: string;
  after: string;
  semanticContext?: SemanticContext;
}

export interface SemanticEntry {
  kind: "hover" | "definition" | "typeDefinition";
  symbol: string;
  text: string;
}

export interface SemanticContext {
  entries: SemanticEntry[];
  /** Local freshness metadata; never include these URIs in the model payload. */
  dependencies: { uri: string; version: number }[];
}

export interface SemanticContextProvider {
  collect(input: SubtitleInput, signal: AbortSignal): Promise<SemanticContext>;
}

export interface ModelIdentity {
  vendor: string;
  id: string;
  version: string;
}
export interface FittedRequest {
  /** The input actually submitted, including any bounded semantic evidence. */
  input: SubtitleInput;
  /** The complete prompt that fits the model budget. */
  prompt: string;
}

export interface PreparedRequest {
  /** The bounded, pre-enrichment input; the cache identity is derived from it. */
  input: SubtitleInput;
  model: ModelIdentity;
  /** The prompt built from the pre-enrichment input; key material for the cache. */
  prompt: string;
  alreadyAuthorized: boolean;
  /** Collect optional evidence and fit the prompt to the model budget; runs only on a cache miss. */
  fit(signal: AbortSignal): Promise<FittedRequest>;
  /** Start the model request with the fitted prompt; fits first when `fit` has not run. */
  stream(signal: AbortSignal): Promise<AsyncIterable<string>>;
}

export interface ModelGateway {
  /** Resolve the model and access state only; no evidence collection or token counting. */
  prepare(input: SubtitleInput, signal: AbortSignal): Promise<PreparedRequest>;
}

export type SubtitlePhase = "preparing" | "streaming" | "visible";
export interface SubtitleView {
  show(input: SubtitleInput, text: string, phase: SubtitlePhase): void;
  clear(): void;
  notify(failure: FailureCode): void;
}

export type FailureCode =
  | "selection"
  | "inputTooLarge"
  | "outputInvalid"
  | "outputTooLong"
  | "modelUnavailable"
  | "accessDenied"
  | "blocked"
  | "network"
  | "timeout";
export class SubtitleError extends Error {
  constructor(readonly code: FailureCode) {
    super(code);
  }
}

export interface Clock {
  now(): number;
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface SubtitleCache {
  get(request: PreparedRequest): string | undefined;
  put(request: PreparedRequest, text: string): void;
  clear(): void;
  invalidateDocument(uri: string): void;
  invalidateWorkspace(workspaceId: string): void;
}
