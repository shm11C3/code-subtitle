# Semantic provider TDD notes

The semantic adapter keeps the VS Code boundary injected. `VscodeSemanticContextProvider` accepts `VscodeSemanticContextRuntime`, which exposes only `commands.executeCommand`, the small workspace surface, `Uri.parse`, and the `Position` and `Range` constructors. The implementation imports VS Code types only, so the node tests do not load an extension host.

The collector uses the standard hover, definition, type-definition, and document-symbol commands. It extracts at most three distinct identifiers from the selection. Identifiers followed by `(` and identifiers after `.` are treated as likely call sites and are visited before other identifiers; remaining identifiers preserve selection order. This is a bounded lookup heuristic, not an AST or call-graph analysis.

Evidence collection has a 600 ms total deadline, a 4,000 UTF-16-unit total budget including symbols, and a 1,500-unit per-entry budget. Provider failures are optional. A cancellation rejects with `AbortError` immediately; a deadline returns evidence collected before the deadline. Late provider, document, and canonical-path results are ignored by the settled operation.

Definition locations are deduplicated, limited to three candidate locations per kind, and stop after one usable entry per kind. The target must use the `file` scheme, resolve to the same VS Code workspace folder as the source, remain lexically beneath that folder, and pass canonical `realpath` containment. Untitled documents, untrusted workspaces, missing workspace folders, and non-file targets produce an empty context without provider requests. The extension orchestrator also skips `collect` when semantic enrichment is disabled. Definitions are resolved one hop only. Tiny provider ranges use an enclosing document symbol when available; otherwise the adapter reads the declaration line. Ranges over 40 lines or definitions over the entry budget use a labeled declaration excerpt, and an oversized declaration line is skipped.

Each resolved local definition contributes its URI and document version to local dependency metadata. The URI is never placed in a `SemanticEntry`. The adapter captures the document version before resolving its text and rechecks it before returning; a changed definition discards the collected entries for that request. Source freshness remains the host's responsibility through the input snapshot and session invalidation.

The focused slice is run with:

```text
node scripts/test-slice.cjs semantic
npm run check
npx oxlint src/vscode-semantic.ts test/semantic.test.ts --deny-warnings
npx oxfmt --check src/vscode-semantic.ts test/semantic.test.ts
```

The tests cover hover payload privacy, identifier prioritization, one-hop definition and type-definition resolution, duplicate and workspace filtering, canonical symlink containment, evidence budgets, untrusted and untitled inputs, optional provider failure, timeout fallback, immediate cancellation, oversized declaration excerpts, and dependency freshness.
