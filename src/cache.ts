import { createHash } from "node:crypto";
import { POLICY_VERSION } from "./policy.js";
import type { Clock, PreparedRequest, SubtitleCache, SubtitleInput } from "./contracts.js";

const SHORT_TTL_MS = 2 * 60 * 1_000;
const WORKSPACE_TTL_MS = 10 * 60 * 1_000;
const MAX_WORKSPACE_ITEMS = 100;
const MAX_WORKSPACE_BYTES = 1 * 1024 * 1024;
const MAX_GLOBAL_BYTES = 4 * 1024 * 1024;

const systemClock: Clock = {
  now: () => Date.now(),
  setTimeout: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as number),
};

interface CacheEntry {
  readonly shortKey: string;
  readonly workspaceKey: string;
  readonly text: string;
  readonly documentUri: string;
  readonly editorId: string;
  readonly workspaceId?: string;
  readonly savedAt: number;
  readonly sizeBytes: number;
  lastUsed: number;
}

/** In-memory short-term and workspace-scoped subtitle cache. */
export class MemorySubtitleCache implements SubtitleCache {
  private readonly clock: Clock;
  private shortEntry?: CacheEntry;
  private readonly workspaceEntries = new Map<string, Map<string, CacheEntry>>();
  private readonly workspaceBytes = new Map<string, number>();
  private totalWorkspaceBytes = 0;
  private sequence = 0;

  constructor(clock: Clock = systemClock) {
    this.clock = clock;
  }

  get(request: PreparedRequest): string | undefined {
    this.purgeExpired();
    const shortKey = requestKey(request, true);

    if (this.shortEntry?.shortKey === shortKey) {
      this.touchWorkspaceEntry(this.shortEntry);
      return this.shortEntry.text;
    }

    const workspaceId = request.input.workspaceId;
    if (workspaceId === undefined) {
      return undefined;
    }
    const entries = this.workspaceEntries.get(workspaceId);
    const entry = entries?.get(requestKey(request, false));
    if (entry === undefined) {
      return undefined;
    }
    entry.lastUsed = ++this.sequence;
    return entry.text;
  }

  put(request: PreparedRequest, text: string): void {
    this.purgeExpired();
    if (text.trim().length === 0) {
      return;
    }

    const entry: CacheEntry = {
      shortKey: requestKey(request, true),
      workspaceKey: requestKey(request, false),
      text,
      documentUri: request.input.documentUri,
      editorId: request.input.editorId,
      workspaceId: request.input.workspaceId,
      savedAt: this.clock.now(),
      sizeBytes: estimateSize(text, request.input),
      lastUsed: ++this.sequence,
    };

    this.shortEntry = entry;
    if (request.input.workspaceId !== undefined) {
      this.putWorkspace(request.input.workspaceId, entry);
    }
  }

  clear(): void {
    this.shortEntry = undefined;
    this.workspaceEntries.clear();
    this.workspaceBytes.clear();
    this.totalWorkspaceBytes = 0;
  }

  invalidateDocument(uri: string): void {
    if (this.shortEntry?.documentUri === uri) {
      this.shortEntry = undefined;
    }
    for (const [workspaceId, entries] of this.workspaceEntries) {
      for (const [key, entry] of entries) {
        if (entry.documentUri === uri) {
          this.removeWorkspaceEntry(workspaceId, key);
        }
      }
    }
  }

  invalidateWorkspace(workspaceId: string): void {
    if (this.shortEntry?.workspaceId === workspaceId) {
      this.shortEntry = undefined;
    }
    const entries = this.workspaceEntries.get(workspaceId);
    if (entries === undefined) {
      return;
    }
    const bytes = this.workspaceBytes.get(workspaceId) ?? 0;
    this.totalWorkspaceBytes = Math.max(0, this.totalWorkspaceBytes - bytes);
    this.workspaceEntries.delete(workspaceId);
    this.workspaceBytes.delete(workspaceId);
  }

  private putWorkspace(workspaceId: string, entry: CacheEntry): void {
    if (entry.sizeBytes > MAX_WORKSPACE_BYTES) {
      return;
    }

    let entries = this.ensureWorkspace(workspaceId);

    const previous = entries.get(entry.workspaceKey);
    if (previous !== undefined) {
      this.removeWorkspaceEntry(workspaceId, entry.workspaceKey);
      entries = this.ensureWorkspace(workspaceId);
    }

    while (
      entries.size >= MAX_WORKSPACE_ITEMS ||
      (this.workspaceBytes.get(workspaceId) ?? 0) + entry.sizeBytes > MAX_WORKSPACE_BYTES
    ) {
      const oldest = oldestEntry(entries);
      if (oldest === undefined) {
        break;
      }
      this.removeWorkspaceEntry(workspaceId, oldest.workspaceKey);
      entries = this.ensureWorkspace(workspaceId);
    }

    entries.set(entry.workspaceKey, entry);
    this.addWorkspaceBytes(workspaceId, entry.sizeBytes);
    this.evictGlobalLimit();
  }

  private addWorkspaceBytes(workspaceId: string, bytes: number): void {
    this.workspaceBytes.set(workspaceId, (this.workspaceBytes.get(workspaceId) ?? 0) + bytes);
    this.totalWorkspaceBytes += bytes;
  }

  private removeWorkspaceEntry(workspaceId: string, key: string): void {
    const entries = this.workspaceEntries.get(workspaceId);
    const entry = entries?.get(key);
    if (entries === undefined || entry === undefined) {
      return;
    }
    entries.delete(key);
    const bytes = (this.workspaceBytes.get(workspaceId) ?? 0) - entry.sizeBytes;
    this.workspaceBytes.set(workspaceId, Math.max(0, bytes));
    this.totalWorkspaceBytes = Math.max(0, this.totalWorkspaceBytes - entry.sizeBytes);
    if (entries.size === 0) {
      this.workspaceEntries.delete(workspaceId);
      this.workspaceBytes.delete(workspaceId);
    }
  }

  private evictGlobalLimit(): void {
    while (this.totalWorkspaceBytes > MAX_GLOBAL_BYTES) {
      const oldest = oldestWorkspaceEntry(this.workspaceEntries);
      if (oldest === undefined) {
        return;
      }
      this.removeWorkspaceEntry(oldest.workspaceId, oldest.key);
    }
  }

  private purgeExpired(): void {
    const now = this.clock.now();
    if (this.shortEntry !== undefined && now - this.shortEntry.savedAt >= SHORT_TTL_MS) {
      this.shortEntry = undefined;
    }

    for (const [workspaceId, entries] of this.workspaceEntries) {
      for (const [key, entry] of entries) {
        if (now - entry.savedAt >= WORKSPACE_TTL_MS) {
          this.removeWorkspaceEntry(workspaceId, key);
        }
      }
    }
  }

  private ensureWorkspace(workspaceId: string): Map<string, CacheEntry> {
    const existing = this.workspaceEntries.get(workspaceId);
    if (existing !== undefined) {
      return existing;
    }
    const entries = new Map<string, CacheEntry>();
    this.workspaceEntries.set(workspaceId, entries);
    this.workspaceBytes.set(workspaceId, 0);
    return entries;
  }

  private touchWorkspaceEntry(entry: CacheEntry): void {
    if (entry.workspaceId === undefined) {
      return;
    }
    const workspaceEntry = this.workspaceEntries.get(entry.workspaceId)?.get(entry.workspaceKey);
    if (workspaceEntry !== undefined) {
      workspaceEntry.lastUsed = ++this.sequence;
    }
  }
}

function requestKey(request: PreparedRequest, includeEditorId: boolean): string {
  const input = request.input;
  const identity = {
    policyVersion: POLICY_VERSION,
    prompt: request.prompt,
    documentUri: input.documentUri,
    ...(includeEditorId ? { editorId: input.editorId } : {}),
    workspaceId: input.workspaceId ?? null,
    range: {
      start: { line: input.range.start.line, character: input.range.start.character },
      end: { line: input.range.end.line, character: input.range.end.character },
    },
    anchorLine: input.anchorLine,
    languageId: input.languageId,
    outputLanguage: input.outputLanguage,
    selection: input.selection,
    before: input.before,
    after: input.after,
    model: {
      vendor: request.model.vendor,
      id: request.model.id,
      version: request.model.version,
    },
  };
  return createHash("sha256").update(JSON.stringify(identity)).digest("hex");
}

function estimateSize(text: string, input: SubtitleInput): number {
  const metadata =
    input.documentUri.length + input.editorId.length + (input.workspaceId?.length ?? 0);
  return (text.length + metadata) * 2 + 256;
}

function oldestEntry(entries: Map<string, CacheEntry>): CacheEntry | undefined {
  let oldest: CacheEntry | undefined;
  for (const entry of entries.values()) {
    if (oldest === undefined || entry.lastUsed < oldest.lastUsed) {
      oldest = entry;
    }
  }
  return oldest;
}

function oldestWorkspaceEntry(
  workspaces: Map<string, Map<string, CacheEntry>>,
): { workspaceId: string; key: string } | undefined {
  let oldest: { workspaceId: string; key: string; lastUsed: number } | undefined;
  for (const [workspaceId, entries] of workspaces) {
    for (const entry of entries.values()) {
      if (oldest === undefined || entry.lastUsed < oldest.lastUsed) {
        oldest = { workspaceId, key: entry.workspaceKey, lastUsed: entry.lastUsed };
      }
    }
  }
  return oldest;
}
