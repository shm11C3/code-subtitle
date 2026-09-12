# Integration TDD Evidence

The main session owns the build harness and real extension-host tests. Individual agent cycles are documented separately.

## Production renderer

- RED: `npm run build` failed because `src/vscode-view.ts` did not exist when the host test first imported the production renderer.
- GREEN: once the renderer was implemented, `node scripts/test-host.cjs` passed on VS Code 1.135.0. It displayed synthetic preparing, partial, and completed text, cleared it, and verified no changes to document text, version, dirty state, selection, or active editor.
- Limitation: this is an API/non-mutation check. Pixel-level readability and Undo-history interaction require direct observation.

## Extension activation and commands

- RED: the next host test activated `code-subtitle-local.code-subtitle` and failed with `Cannot find module .../dist/src/extension.js` before the extension entry point existed.
- GREEN: the completed adapter passed activation, registration of all three commands, and non-mutating dismiss/clear-cache commands in the isolated VS Code 1.135 host.

## Event integration regressions

The main session also added regression checks around the real extension, session, policy, cache, and model gateway with only the VS Code boundary substituted. These verified successful initial consent, selection cancellation without resubmission, document-edit invalidation, and workspace-removal invalidation. The consent bug was identified by code review and corrected by the adapter agent before the new test ran; this is regression verification, not a claimed failing-first cycle.

## Semantic context integration

The following public extension flows were exercised with real session, policy, cache, model gateway, and semantic collector modules, substituting only VS Code and the model boundary:

- RED: explicit execution sent no provider evidence. GREEN: the gateway's input preparation now collects optional evidence before token fitting and cache lookup.
- RED: editing another document in the workspace left a semantic subtitle visible and reusable. GREEN: semantic mode conservatively invalidates the containing workspace and active request.
- RED: filesystem dependency changes left a cached result visible. GREEN: create/change/delete events invalidate semantic results in the affected workspace.
- RED: disabling semantic context left enriched results visible. GREEN: the setting change clears results, and subsequent commands query no semantic providers and omit evidence from the prompt.
- RED: configuration changes belonging to another language provider did not clear semantic results. GREEN: semantic mode invalidates on configuration changes without requiring a language-specific setting list.

A further regression test confirms that a dependency edit during an uncooperative provider request prevents model submission, even after the provider eventually resolves. It passed immediately using the existing cancellation path and is not claimed as a failing-first cycle.

Revision: RED: a repeated command with semantic context enabled re-queried the providers before finding the cached result. GREEN: the cache lookup now precedes evidence collection and token fitting (session cycle 15); the repeated command makes no provider or model request.

## Timing log

RED: with `codeSubtitle.timingLog` enabled, the extension created no output channel and wrote nothing. GREEN: the extension injects a `SubtitleObserver` that lazily creates the **Code Subtitle Timing** channel and writes `request=<id> <event> +<ms>ms` lines; a companion test confirms that the default-off setting creates no channel. The line assertions exclude the fixture's source text, subtitle, and path.

## Live evaluation harness

`npm run eval:live` (`scripts/eval-live.cjs`, `test/eval/index.ts`, `test/eval/cases.ts`) has no automated test because it exists to make real model requests. Its checks are: it compiles with the extension build, it is excluded from the VSIX, and its no-model path prints a clear message and exits non-zero in a fresh profile. Results with a signed-in Copilot profile are recorded by hand in the results directory, not in this repository.

## Parallel iteration

`node scripts/test-slice.cjs <name>` transpiles and runs one role's behavioral test file independently. It intentionally skips type checking during the local RED/GREEN iteration so another role's intermediate type errors do not block unrelated behavior tests. Final acceptance requires the complete `npm run check` and `npm test`; a slice result alone is insufficient.
