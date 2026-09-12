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

## Inline failure guidance

- RED: with the renderer now placing actionable failures beside the code, the extension tests required the unsupported-output and overlong-output cases to appear in the decoration slot without a notification, `Esc` (the `dismiss` command) and a document edit to clear that guidance even though the session holds no active request, and a missing active editor to keep the notification. `dismiss` was a no-op without an active session request.
- GREEN: `dismissActive` and source invalidation clear the view directly. The existing consent, cancellation, and invalidation regressions are unchanged.

## Current-line fallback

- RED: extension tests required an empty single selection to submit the cursor's whole line, the subtitle to stay while the cursor does not move and clear when it does, and a whitespace-only line to report the selection failure without a request. The first two failed because an empty selection was rejected as a selection error.
- GREEN: `show` widens an empty single selection to the full line before building the snapshot, and the active request records the original editor selection so selection-change comparisons are made against the cursor rather than the widened range. `createInput` is unchanged, and the keybinding no longer requires `editorHasSelection`.

## Scrolling keeps the subtitle

- RED: an extension test placed the anchor line outside the editor's visible ranges, required the subtitle to render, and required a visible-range change not to clear it. The subtitle was cancelled because `isCurrent` checked visibility and a visible-range handler dismissed it.
- GREEN: the visible-range handler and the visibility check are removed. Selection change, edit, editor switch, `Esc`, and expiry remain the dismissal triggers.

## Parallel iteration

`node scripts/test-slice.cjs <name>` transpiles and runs one role's behavioral test file independently. It intentionally skips type checking during the local RED/GREEN iteration so another role's intermediate type errors do not block unrelated behavior tests. Final acceptance requires the complete `npm run check` and `npm test`; a slice result alone is insufficient.
