# Bounded semantic context

Status: implemented and verified on 2026-09-12. This extends the earlier selection-only submission boundary. See [validation](validation.md) for observed results and remaining semantic-quality acceptance.

## Decision

Use VS Code's standard Hover, Definition, and Type Definition provider commands. Both the built-in TypeScript service and the native TypeScript 7 service can supply these features. Do not connect to tsserver or launch a language server directly. Provider availability is optional.

On an explicit subtitle command, collect context for at most three distinct identifiers in the selection, prioritizing call sites. This is a bounded candidate heuristic, not a language-independent AST or complete dependency analysis. Read definitions one hop away only, within the selected file's workspace folder. Do not follow definitions recursively or query references/call graphs. Untitled files, untrusted workspaces, and disabled semantic context use the existing input path.

Use a 600 ms total collection deadline, at most 4,000 UTF-16 code units of evidence, and at most 1,500 units per entry. These are provisional budgets, not measured latency claims. Oversized definitions use a clearly bounded declaration excerpt; never imply the excerpt is a complete implementation. Prefer a provider's definition target range, or an enclosing document symbol where available. Do not read arbitrary external URI schemes or files outside the originating workspace folder.

VS Code execute-provider commands do not expose cancellation tokens. Stop waiting at the deadline or cancellation, discard late results, and do not continue opening files after cancellation. Provider absence, errors, or slow responses must not prevent basic subtitle generation. Do not make a second model request when late context arrives.

## Data and lifecycle

`SemanticContextProvider.collect(input, signal)` returns bounded evidence entries and local document-version dependencies. `SubtitleInput.semanticContext` carries them to prompt construction. Only each entry's kind, symbol, and text enter the model request; dependency URIs stay local. Treat provider text and definition excerpts as untrusted evidence, not instructions or proof of author intent. Hover may include declarations or documentation from installed libraries, while explicit source-file reads stay inside the workspace folder.

Collect before token fitting and cache lookup. Fit the complete prompt; discard optional semantic evidence before reducing adjacent context, and never truncate the selection. Cache identity already includes the actual prompt. Resolve fresh evidence before each lookup; do not cache provider responses separately.

Initially invalidate the semantic cache and active request conservatively when any source in the workspace changes, is created/deleted, or closes, and on any configuration change while semantic context is enabled. This covers dependency edits during preparation/streaming and language-provider settings without maintaining a dependency index or language-specific setting list. A later optimization may narrow invalidation once correctness is established.

Add a user-level `codeSubtitle.semanticContext` switch, enabled by default for this authorized feature. Update first-use disclosure and product documentation to describe the expanded submission scope. Preserve explicit invocation, one temporary subtitle, cancellation, non-mutation, and comment translation.

## TDD and acceptance

Implement vertical failing-first slices for:

1. Provider evidence reaches the prompt without URI metadata; absence preserves the old payload.
2. Provider results are bounded, deduplicated, scoped to the workspace, and resolved only one hop.
3. Provider failures/timeouts fall back; cancellation and late results never send a stale request.
4. Token pressure drops optional evidence first while preserving selected source.
5. Changes to a referenced definition prevent stale reuse and cancel active generation.
6. Disabling enrichment makes no provider requests.

Use injected VS Code boundaries for deterministic tests and actual extension-host provider checks for integration. Verify both built-in TypeScript and the TypeScript 7 extension when available; report unavailable coverage explicitly. No live model request is needed for provider tests. Compare real model output separately with and without definition evidence before claiming semantic improvement.

Sources: [VS Code provider commands](https://code.visualstudio.com/api/references/commands), [TypeScript 7 extension](https://marketplace.visualstudio.com/items?itemName=TypeScriptTeam.native-preview).
