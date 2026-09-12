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
export interface PreparedRequest {
  input: SubtitleInput;
  model: ModelIdentity;
  prompt: string;
  alreadyAuthorized: boolean;
  stream(signal: AbortSignal): Promise<AsyncIterable<string>>;
}

export interface ModelGateway {
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
