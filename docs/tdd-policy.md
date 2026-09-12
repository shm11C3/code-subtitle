# Input and Output Policy TDD Notes

This document records the vertical RED → GREEN cycles for the deterministic policy module. Tests exercise exported functions and do not call a live model. Run the focused slice with:

```sh
node scripts/test-slice.cjs policy
```

## Cycle 1: normalize display whitespace

RED: The first test specified that leading and trailing whitespace, line breaks, and tabs become ordinary display spacing without changing the words. The test initially failed because `src/policy.ts` did not exist.

GREEN: `normalizeOutput` now collapses display whitespace and trims the result without truncating it.

## Cycle 2: language-specific output limits

RED: The next test required Japanese language tags to target 100 graphemes and other language tags to target 200 graphemes, while allowing a 200-grapheme Japanese hard limit and a 400-grapheme hard limit for other languages.

GREEN: `outputTarget` recognizes `ja` and `ja-*` tags and retains the shorter 100/200 prompt targets; `outputLimit` applies the inclusive 200/400 hard caps for all other tags, including `auto`.

## Cycle 3: grapheme counting

RED: The next test used an emoji modifier sequence and a combining-mark sequence. Counting UTF-16 units or code points would overcount both visible characters.

GREEN: `graphemeLength` uses the host's `Intl.Segmenter` with grapheme granularity.

## Cycle 4: completed-output validation

RED: Tests required short plain text to pass and empty, unsafe-control, over-limit, code-fence, Markdown-list, heading, blockquote, and link output to fail. Inline backticks and emphasis had to remain valid literal text, and over-limit output had to be rejected instead of truncated.

GREEN: `validateOutput` checks the raw text for unsafe controls and unsupported block or link forms, then applies normalized whitespace and the language-specific hard grapheme limit. Inline backticks and emphasis markers remain unchanged as literal text, and identifiers containing underscores remain valid plain text.

## Cycle 5: construct one bounded selection input

RED: The next test required one selection to produce the exact selected text, the previous-line anchor, and adjacent context. Additional tests required multiple selections and whitespace-only selections to fail as `selection` errors.

GREEN: `createInput` validates one ordered range, extracts the source text without rewriting it, and returns a `SubtitleInput` snapshot with the selected range and context.

## Cycle 6: selection size and anchor boundaries

RED: Tests covered the 80-line and 8,000 UTF-16 code-unit limits, and a range ending at character zero on the next line. The latter must anchor to the previous selected line and keep the next line as context.

GREEN: Oversized input raises `inputTooLarge`; the anchor uses the actual last selected line when the end position is at the next line start.

## Cycle 7: adjacent context bounds

RED: The next test required no more than five complete lines on either side and required the nearest lines to be retained. Context must be reduced by whole lines so the combined context stays within 2,000 UTF-16 code units.

GREEN: `createInput` keeps bounded adjacent lines and removes farthest lines first when the context budget is exceeded. The selected text is never split or reduced to satisfy the context budget.

## Cycle 8: prompt data boundary

RED: The prompt test required Why and comment-translation instructions, explicit treatment of source instructions as untrusted data, and a JSON data object containing only `languageId`, `outputLanguage`, `selection`, `before`, and `after`. Document, editor, and workspace identifiers must not enter the prompt.

GREEN: `buildPrompt` combines fixed policy instructions with only the permitted JSON fields.

## Cycle 9: token-driven context fitting

RED: The next test supplied a controlled token counter that rejected the initial prompt. It required context lines to be removed until the prompt fit while the selected text and range remained unchanged.

GREEN: `fitInput` rechecks the prompt after removing farthest context lines. If the selection itself cannot fit, it raises `inputTooLarge`; an aborted signal stops fitting with `AbortError`.

The policy tests are deterministic and do not establish model translation quality, actual prompt-token parity with a provider, or display readability. Those remain separate integration and manual checks.

## Output revision: experienced readers

RED: The prompt-boundary test failed because the request did not identify experienced engineers reading OSS or reviewing code, or specify a grounded insight with limits on unsupported review claims.

GREEN: The prompt now connects one visible mechanism to a responsibility, invariant, failure boundary, or tradeoff, with calibration examples and instructions against line-by-line narration or assumed behavior of unseen helpers. The policy version is now `2`; the model data fields remain unchanged.

RED: A separate test failed because the prompt did not communicate the validator's display limit for Japanese and other language tags.

GREEN: Prompt construction now uses `outputLimit` to state the same limit that output validation enforces, while retaining decisive conditions and caveats. This does not guarantee that a model obeys the limit or produces a useful insight. Live semantic acceptance is tracked separately in [Output quality](output-quality.md).

## Relaxed output policy cycles

RED: Boundary tests required output at exactly 200 Japanese graphemes and 400 non-Japanese graphemes to pass, the next grapheme to fail, and a 104-grapheme Japanese prose subtitle to pass. A short subtitle containing `` `requestId` `` or `**cached**` also had to pass without marker stripping, while fenced code, lists, headings, block quotes, links, empty text, and control characters remained invalid.

GREEN: `validateOutput` enforces the inclusive hard caps with grapheme counting and allows inline backticks and emphasis as literal text. `buildPrompt` asks for about `outputTarget` graphemes, communicates the `outputLimit` hard cap, and keeps the one-sentence requirement. `POLICY_VERSION` is `4` so cached responses use the revised output contract.

## CJK output limit cycle

RED: A new test required `zh`, `zh-*`, `ko`, and `ko-*` tags to share the Japanese 100-grapheme target and 200-grapheme hard limit while `zu`, `kok`, `jav`, and `auto` kept 200/400. It failed because only `ja` matched the dense-script pattern.

GREEN: `outputTarget` and `outputLimit` use one `ja|zh|ko` language pattern. The prompt's limit instruction follows automatically. This is a character-density extrapolation; native-reader validation for Chinese and Korean has not been performed.

## Token-count bound cycle

RED: Tests required `needsTokenCount` to return false when the prompt's UTF-8 byte length is at most the token budget, `fitInput` to never call the counter for a prompt that fits by that bound, and every later counter call during reduction to happen only while the byte bound is still exceeded. They failed because the helper did not exist and `fitInput` always counted at least once.

GREEN: `needsTokenCount` compares `Buffer.byteLength` with `maxTokens`; `fitInput` checks it before the first and each subsequent count. The assumption that every byte-level BPE token covers at least one byte is stated in the code and in design §2. Provider-side counting behavior is unchanged when the bound is exceeded.

## Language-aware calibration examples cycle

RED: A test required `rust`, `go`, and `python` inputs to receive dedicated calibration examples, every other `languageId` (including `constructor` and `__proto__`) to receive the TypeScript/JavaScript set, one generic `return normalize(input)` example to appear in all sets, exactly three example pairs per prompt, the data JSON keys to stay unchanged, and `POLICY_VERSION` to be `5`. It failed because all prompts used the single TypeScript set under version `4`.

GREEN: `buildPrompt` looks up examples in a `Map` keyed by `languageId` with the generic example appended. The new snippets are synthetic and distinct from the live evaluation cases so that evaluation is not contaminated. This changes prompt construction only; whether the examples improve generated subtitles is a live-harness question.

## Cache TDD cycles

The cache tests use a controllable clock and fake prepared requests. They never persist data to disk or call a model.

### Cycle 1: store and retrieve a completed result

RED: The first test required a completed subtitle to be returned for the same prepared request. The test initially failed because `src/cache.ts` did not exist.

GREEN: `MemorySubtitleCache` stores a non-empty result and retrieves it through the `SubtitleCache` interface.

### Cycle 2: separate short-term and workspace expiry

RED: Tests required a document outside a workspace to expire after two minutes, while a workspace result remains available through ten minutes after saving.

GREEN: The cache checks the short-term and workspace deadlines independently when entries are read or written.

### Cycle 3: key identity and scope

RED: Tests required prompt changes to miss, workspace results to be reusable across editor instances, and outside-workspace short-term results to remain editor-scoped.

GREEN: The cache hashes the policy version, actual prompt, range, document URI, workspace, language, and model identity. The editor identity is included in the short-term key and omitted from the workspace key.

### Cycle 4: replacement and invalidation

RED: Tests covered replacing the only workspace entry, invalidating a document, invalidating a workspace, and rejecting empty results.

GREEN: Replacement preserves the workspace bucket, invalidation removes both relevant layers, and blank strings never enter either layer.

### Cycle 5: workspace LRU and memory bounds

RED: Tests required the oldest entry to leave a folder after 100 entries, a read to refresh recency, and the one MiB per-folder and four MiB global estimated response budgets to evict older entries.

GREEN: Workspace entries track recency and estimated UTF-16 response and metadata size. Per-folder and global eviction run when new entries are added; only compact metadata is retained alongside the completed text.

The cache tests establish deterministic lifecycle, identity, and capacity behavior. They do not establish the provider's storage, billing, or model-side retention policy.

## Semantic context policy cycles

RED: The semantic-context boundary test required provider evidence to reach the model as an array of only `kind`, `symbol`, and `text`. Local dependency URIs, versions, and arbitrary provider fields had to remain outside the prompt.

GREEN: `buildPrompt` projects each entry through that explicit whitelist and omits `semanticContext` when no usable entries remain. The prompt describes semantic results as optional, untrusted excerpts rather than complete implementations or proof of author intent, and keeps comment-only translation faithful.

RED: The bounded-sanitization test supplied invalid kinds, duplicate entries, oversized symbols and excerpts, extra fields, and more entries than the policy allows. It required valid evidence to stay ordered while staying within nine entries, 1,500 UTF-16 units per entry, and 4,000 aggregate units counting symbols.

GREEN: Policy sanitization filters malformed entries, removes duplicates, drops entries with missing fields or oversized UTF-16 content, and applies the per-entry and aggregate limits before serialization. `POLICY_VERSION` is `3` so cached responses use the revised prompt contract.

RED: The prompt-fitting test required token pressure to remove optional semantic evidence as whole entries before touching adjacent source context, while preserving the selection and ensuring the fitted input describes the entries actually submitted.

GREEN: `fitInput` sanitizes the input once, drops the lowest-priority evidence entry first, then falls back to the existing farthest-context reduction. Dependency metadata may remain on the fitted local input but is never serialized into the model payload.
