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

## Parallel iteration

`node scripts/test-slice.cjs <name>` transpiles and runs one role's behavioral test file independently. It intentionally skips type checking during the local RED/GREEN iteration so another role's intermediate type errors do not block unrelated behavior tests. Final acceptance requires the complete `npm run check` and `npm test`; a slice result alone is insufficient.
