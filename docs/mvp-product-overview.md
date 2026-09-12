# MVP Product Overview

Status: approved MVP scope with an initial local implementation. Automated contract checks are available; manual UX, real-model quality, and performance acceptance remain pending. See [validation](validation.md).

## Problem to solve

When developers who read OSS or unfamiliar code in a language other than their own move to Chat to resolve a small question, enter context, and read a long explanation, the flow of code reading is interrupted. The same friction appears when they only need to check the meaning of an English comment.

Code Subtitle returns only the meaning needed to read the next line, right where the question arises. Along with fast AI calls, reducing operations, eye movement, and reading volume shortens the time until understanding.

## Target users and situations

- Experienced engineers investigating an OSS implementation who need to understand its responsibilities, invariants, and tradeoffs.
- Code reviewers who want to identify the conditions and failure boundaries that matter when changing a selected piece of code.
- Developers who want to quickly understand the conditions and caveats in English comments in a familiar language.

Teaching code fundamentals from the beginning, explaining an entire file, and proving design intent through history research are out of scope.

## Core experience

```text
Select → shortcut → short subtitle near the end of the selection → continue reading
```

Only one subtitle is displayed at a time. A selection alone does not make a request. If a different piece of code is selected while generation is in progress, cancel the active request and clear the subtitle. Do not generate for the new selection until the next explicit action.

Clear the subtitle within at most 10 seconds after generation completes. Clear it first when `Esc` is pressed, the selection changes, the target document is edited, the editor changes, or the target range leaves the viewport. Do not provide history, pinning, or a copy-only UI.

## Output contract

| Input                      | Output                                                                                   |
| -------------------------- | ---------------------------------------------------------------------------------------- |
| Code                       | Connect a visible mechanism to one engineering consequence, normally in one sentence     |
| Comments only              | Return a short translation that preserves negation, conditions, and caveats              |
| Code and comments together | Focus on the role of the code and treat comments as context                              |
| Code with unclear intent   | State the observable responsibility or specific missing context without inventing intent |

Japanese output targets 100 grapheme clusters, with a display allowance up to 200. For other languages, aim for one sentence that can be understood at a glance; the display limit is defined in [Minimal design](minimal-design.md). Do not drop prohibitions or conditions to make a comment shorter. If a short translation does not fit, switch to guidance asking the user to make the selection smaller.

For `cache.get(key) ?? compute()`, an illustrative subtitle is “Only null or undefined triggers computation, so cached false or zero values remain valid hits.” This identifies a consequential boundary rather than narrating the branch. Do not add unseen properties such as whether `compute()` is pure or whether its result is stored.

Select the most useful responsibility, invariant, failure boundary, or concrete tradeoff supported by the input. Include a limitation or review check only when it changes the reader's interpretation. These subtitles support human review; they do not provide an automatic review verdict or repository-wide correctness claims. See [Output quality](output-quality.md) for representative evaluation cases.

## MVP feature scope

| Feature                     | MVP decision                                                                                                          |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Launch                      | `codeSubtitle.show` via shortcut (`Shift+Alt+E`, macOS `Ctrl+Alt+E`; unverified on Windows/Linux hardware), the editor context menu, or the Command Palette |
| Input                       | One non-whitespace-only selection, or the cursor's whole line when the selection is empty, in the desktop text editor |
| Context                     | Selection, up to five adjacent lines each side, and optional bounded type/docs and one-hop same-workspace definitions |
| Explanation and translation | Process according to the input in a single request; do not make an additional AI request solely for classification    |
| Display                     | Aim for one or two lines near the code; use one line rendered with a Decoration as the initial baseline               |
| Update                      | Append streamed content without blocking input operations                                                             |
| End                         | Cancellation, discarding stale responses, and a short display expiry                                                  |
| Reuse                       | Keep only successful short responses in workspace-separated memory                                                    |
| Configuration               | Output-language/model overrides and a semantic-context switch; bounded semantic context is enabled by default         |
| AI use                      | VS Code Language Model API; no custom API key or custom backend                                                       |

Readability for long lines and narrow split editors is an acceptance criterion for the rendering approach. Do not assume that a stable API can reserve an arbitrary two-line area; perform display validation at the beginning of implementation.

## Excluded

Chat, a detailed panel, long display through Hover, conversation history, automatic code fixes, comment replacement, full-file translation, repository indexing, unrestricted related-file search, continuous translation, proactive generation, persistent caching, and telemetry sent by the extension are excluded from the MVP. Bounded provider-resolved definitions are covered by the [semantic-context design](semantic-context-plan.md).

Formal support for Notebooks, the browser version, and Remote environments is outside the initial acceptance target. Validate rendering and data-storage locations in each environment before declaring support.

## Onboarding and failure experience

Code Subtitle does not require an API key. The standard path requires a Copilot model available through VS Code and permission to use it. On first use, briefly explain the range that will be sent and leave any required consent for model use to VS Code's mechanisms.

If no model is available, consent is denied, the quota is exceeded, or the network is disconnected, briefly state the reason and the next action. Guidance the reader can act on inside the editor (selection, input size, unusable or overlong output, timeout, or a failed request) appears in the subtitle slot beside the code and clears itself after a few seconds; failures that need action outside the editor (no model, access denied, blocked or exhausted quota) use a notification. Do not automatically retry failures in a way that consumes reading time or quota. Treat cancellation caused by a selection change as normal operation and show no notification.

## Success criteria

The following are acceptance criteria for after implementation; they are not results achieved at the current stage.

| Concern              | Acceptance criterion                                                                                                             |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Reading continuity   | Displaying or clearing a subtitle does not move focus, the cursor, or the scroll position                                        |
| Brevity and meaning  | Surface one grounded engineering insight beyond an operational paraphrase; preserve comment meaning and avoid unsupported intent |
| Subtitle readability | Check regular and split editors, long lines, wrapping, light and dark themes, and high-contrast themes                           |
| No rewriting         | The extension causes no change to document content, dirty state, or Undo history before or after the operation                   |
| Correct target       | If B is selected while A is generating, A's late response, failure, or timer cannot change B's display                           |
| Speed                | Aim for median TTFE within one second for a consented, running-extension cache miss, and report p95 and failure rate as well     |
| Reuse                | Redisplay the same input without a request, and never use stale results after an edit or language or model change                |
| Data handling        | Send the minimum context only after an explicit action; do not save source or subtitles to disk or send custom telemetry         |

The first evaluation separates code Why from comment translation across different writing systems, including Japanese. Do not treat accepting multilingual input and quality assurance for each language as the same thing. Check not only when characters appear but also whether the user can understand the meaning.

See [Minimal design](minimal-design.md) for detailed state transitions, performance targets, and verification conditions, and [Product principles](product-principles.md) for the decision criteria when adding features.
