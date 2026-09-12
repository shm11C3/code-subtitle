# Subtitle output quality

This is a small manual regression set for subtitles intended to help experienced engineers read OSS and review code. A useful subtitle captures one grounded engineering insight: a responsibility, invariant, tradeoff, or boundary/failure behavior. It should move code reading forward instead of narrating tokens or syntax.

The examples under “Illustrative desired subtitle” are targets, not observed model outputs. Equivalent wording passes when it preserves the same observable meaning.

## Evaluation boundary

For every case, treat the selected range plus at most five lines immediately before it and five lines immediately after it as the complete input. The evaluator must not use imports, callers, tests, repository conventions, runtime behavior, or project-wide guarantees that are outside that window. If context is missing, the subtitle should stay at the level of behavior established by the selection or state the uncertainty briefly.

Run each case with the stated output language and record `pass` or `reject` with one short reason. A manual run is useful for catching meaning loss and unsupported claims; prompt assembly and output validation unit tests do not measure model quality.

## Reproducible live check

Run the set with the live evaluation harness:

```sh
npm run eval:live
```

It opens a desktop VS Code window with the persistent `.eval-host` profile, writes each case below to its own file in `.eval-host/workspace`, selects the whole snippet, and runs the production input, semantic-context, fitting, and streaming pipeline against a real Copilot model with no cache. Install GitHub Copilot Chat into that profile and sign in once; the run exits with a clear message when no model is available. Set `CODE_SUBTITLE_EVAL_MODEL=<id>` to fix the model, `CODE_SUBTITLE_EVAL_SEMANTIC=0` to disable semantic context, and `CODE_SUBTITLE_EVAL_MODEL_OPTIONS='{"temperature":0.2}'` to try provider options that production never sends. See [Development](development.md) for the profile layout.

The harness prints a Markdown table and writes it to `.eval-host/results/<timestamp>.md` with the model vendor/id/version, output language, returned subtitle, grapheme count, validator result, milliseconds to the first non-empty fragment and to completion, the number of semantic entries, and an empty `verdict` column. A person fills in `pass` or `reject` with one short reason using the criteria below; the harness records outputs and never judges meaning. When repeating a case in the product instead, use **Clear Cache** between repetitions so cached text is not mistaken for a fresh generation result.

## Acceptance criteria

Accept a subtitle only when all of these hold:

- It is one concise plain-text sentence in the requested language and fits the current output limit: 200 grapheme clusters for Japanese, Chinese, and Korean output or 400 for other languages. The prompt still targets 100 and 200 respectively. The Chinese and Korean limits are unvalidated by native readers (principle 5); check them with the live harness before claiming quality for those languages.
- For code selections, it names an observable responsibility, invariant, tradeoff, boundary, or failure behavior that helps an engineer read the next line; a faithful comment translation or bounded unknown-context description may pass without a deeper insight.
- It preserves identifiers when they carry meaning, along with negation, conditions, counts, and caveats.
- It stays within the selected code and bounded context; it does not assert the author's intent, diagnose a bug, or promise a project-wide property without evidence.
- If it includes a review check, it contains at most one concise check tied to material behavior visible in the bounded input; it does not force advice when no check is established.
- For a comment-only selection, it translates the comment faithfully and does not add a new rationale or code explanation.

Reject a subtitle that merely restates method calls or syntax, changes an `OR` condition or failure path, invents a race or security guarantee, calls a locally ambiguous snippet buggy, adds speculative or forced review advice, includes more than one review check, or uses block formatting, links, lists, or alternative answers. Inline backticks and emphasis are accepted as literal text, although plain prose remains the prompt target.

## Manual cases

These cases are mirrored in `test/eval/cases.ts` for the harness; this document stays the human-readable source, and the prompt's calibration examples must never reuse these snippets.

### 1. Cancellation owns the current request

Target language: `en-US`  
Focus: responsibility and cancellation boundary

Selected code:

```ts
activeController?.abort();
activeController = controller;
const result = await fetchSubtitle(input, controller.signal);
if (controller.signal.aborted) {
  return;
}
renderSubtitle(result);
```

Illustrative desired subtitle (not observed output): “The abort-signal check gates publication at the view boundary, so an aborted result cannot reach the view even if fetch ignores the abort.”

Reject a subtitle that only lists the abort and render calls, claims the whole editor is race-free, or says cancellation makes fetch unable to return; those claims miss the publication boundary or require context outside the bounded input.

### 2. The empty check protects a ring-buffer invariant

Target language: `en-US`  
Focus: invariant and failure behavior

Selected code:

```rust
if self.len == 0 {
    return None;
}
let value = unsafe { self.buf[self.head].assume_init_read() };
self.head = (self.head + 1) % self.buf.len();
self.len -= 1;
Some(value)
```

Illustrative desired subtitle (not observed output): “The pop assumes every counted slot is initialized, so head and len must remain consistent with the buffer's initialization state.”

Reject a subtitle that only lists the field updates, claims global memory safety, or infers buffer initialization that is outside the bounded input.

### 3. Retries trade waiting for timeout resilience

Target language: `en-US`  
Focus: explicit tradeoff and terminal failure

Selected code:

```python
for attempt in range(3):
    try:
        return client.fetch()
    except TimeoutError:
        if attempt == 2:
            raise
        time.sleep(2 ** attempt)
```

Illustrative desired subtitle (not observed output): “It retries timeouts with increasing delays, then preserves the failure after the third attempt at the cost of extra waiting.”

Reject a subtitle that says all network errors are retried, or that omits either the retry bound or the final re-raise.

### 4. Closing a missing file is a no-op

Target language: `en-US`  
Focus: input boundary and error propagation

Selected code:

```go
func closeFile(f *os.File) error {
    if f == nil {
        return nil
    }
    return f.Close()
}
```

Illustrative desired subtitle (not observed output): “It treats a nil file as already closed and preserves close errors for a real file.”

Reject a subtitle that says the function closes every file successfully or hides the error returned by `Close`.

### 5. Preserve an explicit zero configuration in Japanese

Target language: `ja-JP`  
Focus: nullish defaulting and configuration boundary

Selected code:

```ts
const concurrency = options.concurrency ?? 4;
return startWorkers(concurrency);
```

Illustrative desired subtitle (not observed output): “未指定（null/undefined）の場合だけ並列数を4に補い、明示した0はstartWorkersへ渡すため、0の意味は呼び出し先の契約に依存します。”

The consequence of an explicit zero depends on the contract of `startWorkers`, which is outside this snippet; do not claim that zero is invalid or that it starts no workers.

Reject a subtitle that treats `??` like a truthiness check, replaces an explicit zero with 4, or claims a `startWorkers` behavior that the bounded input does not establish.

### 6. Translate a comment without adding a reason

Target language: `ja-JP`  
Focus: comment-only translation

Selected comment:

```ts
// Avoid reusing a request after the editor changes.
```

Illustrative desired subtitle (not observed output): “エディターが変更された後は、リクエストを再利用しない。”

The translation may be natural Japanese, but it must retain the timing and prohibition. Reject added explanations such as a claim about stale data unless the selected text itself supplies that claim.

### 7. Unknown context limits the claim

Target language: `en-US`  
Focus: delegation with unknown behavior

Selected code:

```js
return transform(input);
```

Illustrative desired subtitle (not observed output): “It delegates processing of input to transform and returns that result; the transform’s behavior is not shown.”

A shorter equivalent such as “It returns the result produced by transforming input.” also passes if it does not imply validation, normalization, error handling, or any other behavior that the bounded context does not establish.

## Interpretation limits

For semantic-context evaluation, also compare the following pair with the same model and output language, clearing the cache between runs:

- Select `return normalize(left) === normalize(right);` in a file importing `normalize` from another file in the same workspace folder.
- Define `normalize` as `export function normalize(value: string) { return value.trim().toLowerCase(); }` in that other file.
- With semantic context disabled, accept a bounded description of comparison through an unknown normalization function; reject invented normalization rules.
- With semantic context enabled and the definition returned, expect the subtitle to identify that comparison ignores leading/trailing whitespace and case. Reject claims about Unicode normalization, locale-aware comparison, security, or author intent that the definition does not establish.
- Change the definition to return only `value.trim()` and invoke again. The result must no longer attribute case folding to the visible implementation. Provider tests can establish the changed evidence and cache behavior; only an observed model run can establish the wording.

This set is intentionally small and local. It samples six engineering behaviors plus one comment translation case; passing it does not establish general model quality, correctness across languages, or usefulness across a repository. Live Copilot output remains unevaluated until someone runs these cases with the harness or in the product and records verdicts. No live model request is part of this document or of the automated tests, and unit tests for prompt construction or output validation must not be reported as evidence that the generated subtitles are good.
