/**
 * Live evaluation cases for `npm run eval:live`.
 *
 * `docs/output-quality.md` is the human-readable source for these cases; keep
 * the snippets identical to the document. The calibration examples in
 * `src/policy.ts` must never reuse or paraphrase these snippets, otherwise the
 * live evaluation is contaminated by the prompt itself.
 */
export interface EvalCase {
  readonly id: string;
  readonly title: string;
  readonly languageId: string;
  readonly outputLanguage: string;
  readonly focus: string;
  readonly code: string;
  readonly notes: string;
}

export const EVAL_CASES: readonly EvalCase[] = [
  {
    id: "cancellation-boundary",
    title: "Cancellation owns the current request",
    languageId: "typescript",
    outputLanguage: "en-US",
    focus: "responsibility and cancellation boundary",
    code: [
      "activeController?.abort();",
      "activeController = controller;",
      "const result = await fetchSubtitle(input, controller.signal);",
      "if (controller.signal.aborted) {",
      "  return;",
      "}",
      "renderSubtitle(result);",
    ].join("\n"),
    notes:
      "Pass: the abort-signal check gates publication at the view boundary. Reject: only lists abort and render calls, claims the editor is race-free, or says cancellation makes fetch unable to return.",
  },
  {
    id: "ring-buffer-invariant",
    title: "The empty check protects a ring-buffer invariant",
    languageId: "rust",
    outputLanguage: "en-US",
    focus: "invariant and failure behavior",
    code: [
      "if self.len == 0 {",
      "    return None;",
      "}",
      "let value = unsafe { self.buf[self.head].assume_init_read() };",
      "self.head = (self.head + 1) % self.buf.len();",
      "self.len -= 1;",
      "Some(value)",
    ].join("\n"),
    notes:
      "Pass: the pop assumes every counted slot is initialized, so head and len must stay consistent with initialization state. Reject: only lists field updates, claims global memory safety, or infers buffer initialization outside the input.",
  },
  {
    id: "retry-tradeoff",
    title: "Retries trade waiting for timeout resilience",
    languageId: "python",
    outputLanguage: "en-US",
    focus: "explicit tradeoff and terminal failure",
    code: [
      "for attempt in range(3):",
      "    try:",
      "        return client.fetch()",
      "    except TimeoutError:",
      "        if attempt == 2:",
      "            raise",
      "        time.sleep(2 ** attempt)",
    ].join("\n"),
    notes:
      "Pass: retries timeouts with increasing delays, then preserves the failure after the third attempt. Reject: says all network errors are retried, or omits the retry bound or the final re-raise.",
  },
  {
    id: "nil-file-close",
    title: "Closing a missing file is a no-op",
    languageId: "go",
    outputLanguage: "en-US",
    focus: "input boundary and error propagation",
    code: [
      "func closeFile(f *os.File) error {",
      "    if f == nil {",
      "        return nil",
      "    }",
      "    return f.Close()",
      "}",
    ].join("\n"),
    notes:
      "Pass: treats a nil file as already closed and preserves close errors for a real file. Reject: says every file closes successfully or hides the error returned by Close.",
  },
  {
    id: "explicit-zero-ja",
    title: "Preserve an explicit zero configuration in Japanese",
    languageId: "typescript",
    outputLanguage: "ja-JP",
    focus: "nullish defaulting and configuration boundary",
    code: [
      "const concurrency = options.concurrency ?? 4;",
      "return startWorkers(concurrency);",
    ].join("\n"),
    notes:
      "Pass: only null/undefined receives 4 and an explicit 0 reaches startWorkers, whose contract is outside the snippet. Reject: treats ?? as truthiness, replaces an explicit zero with 4, or claims startWorkers behavior.",
  },
  {
    id: "comment-translation-ja",
    title: "Translate a comment without adding a reason",
    languageId: "typescript",
    outputLanguage: "ja-JP",
    focus: "comment-only translation",
    code: "// Avoid reusing a request after the editor changes.",
    notes:
      "Pass: natural Japanese that keeps the timing and the prohibition. Reject: adds an explanation such as a stale-data claim that the comment does not supply.",
  },
  {
    id: "unknown-context",
    title: "Unknown context limits the claim",
    languageId: "javascript",
    outputLanguage: "en-US",
    focus: "delegation with unknown behavior",
    code: "return transform(input);",
    notes:
      "Pass: delegates to transform and returns its result without implying what transform does. Reject: implies validation, normalization, error handling, or other behavior the input does not establish.",
  },
];

const FILE_EXTENSIONS: ReadonlyMap<string, string> = new Map([
  ["typescript", "ts"],
  ["javascript", "js"],
  ["rust", "rs"],
  ["go", "go"],
  ["python", "py"],
]);

/** File extension that lets VS Code assign the case's language mode. */
export function fileExtension(languageId: string): string {
  return FILE_EXTENSIONS.get(languageId) ?? "txt";
}
