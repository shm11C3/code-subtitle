# Input and Output Policy TDD Notes

This document records the vertical RED → GREEN cycles for the deterministic policy module. Tests exercise exported functions and do not call a live model. Run the focused slice with:

```sh
node scripts/test-slice.cjs policy
```

## Cycle 1: normalize display whitespace

RED: The first test specified that leading and trailing whitespace, line breaks, and tabs become ordinary display spacing without changing the words. The test initially failed because `src/policy.ts` did not exist.

GREEN: `normalizeOutput` now collapses display whitespace and trims the result without truncating it.

## Cycle 2: language-specific output limits

RED: The next test required Japanese language tags to use a 100-grapheme limit and other language tags to use a 200-grapheme limit.

GREEN: `outputLimit` recognizes `ja` and `ja-*` tags and uses the non-Japanese limit for other tags, including `auto`.

## Cycle 3: grapheme counting

RED: The next test used an emoji modifier sequence and a combining-mark sequence. Counting UTF-16 units or code points would overcount both visible characters.

GREEN: `graphemeLength` uses the host's `Intl.Segmenter` with grapheme granularity.

## Cycle 4: completed-output validation

RED: Tests required short plain text to pass and empty, unsafe-control, over-limit, code-fence, Markdown-list, heading, blockquote, emphasis, inline-code, and link output to fail. The validator must reject over-limit text instead of truncating it.

GREEN: `validateOutput` checks the raw text for unsafe controls and unsupported Markdown forms, then applies normalized whitespace and the language-specific grapheme limit. Identifiers containing underscores remain valid plain text.

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
