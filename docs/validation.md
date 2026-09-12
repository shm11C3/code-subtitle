# MVP Validation

Status: local preview implemented on 2026-09-12. Deterministic and extension-host smoke checks pass; manual product acceptance remains open.

## Environment

- macOS arm64, desktop VS Code 1.135.0.
- Node.js 24.11.1 for local development; Node.js 22 types and CI target.
- VS Code API types 1.134.0; only stable APIs.
- Isolated extension-host profile and synthetic input for renderer tests.

## Observed results

- `npm run check`: passed.
- `npm test`: 57 tests passed across policy, cache, session, model adapter, and event integration.
- `npm run package`: produced the local `code-subtitle-0.0.1.vsix` preview.
- VSIX inspection: runtime JavaScript, manifest, and preview README included; no test fixtures, development dependencies, source maps, or local test profile.
- Real extension-host activation: all three commands registered; dismiss and clear-cache executed without document mutation.

The production decoration renderer passed its real extension-host smoke test. Preparing, partial, completed, and cleared states did not change source text, document version, dirty state, selected range, or the active editor. No model request was made.

The main session could not inspect the isolated test window through the available native UI binding, which continued to target the regular VS Code process. A successful renderer API call is not proof of pixel-level readability. The visual scenarios remain reproducible through `CODE_SUBTITLE_VISUAL_CHECK=1 npm run test:host`.

## Experienced-reader output revision

On 2026-09-12, prompt policy version `2` added an experienced OSS/code-review audience, one grounded engineering insight, calibration examples, and the existing language-specific display limits. Two failing-first policy checks covered the request instructions/data boundary and the display-limit instruction; the full 57-test suite and TypeScript check passed. These checks verify prompt construction, not generated meaning. [Output quality](output-quality.md) contains the manual semantic evaluation cases; live-model acceptance remains pending.

The updated VSIX was packaged and reinstalled in the normal VS Code profile. The installed `policy.js` SHA-256 matched the build output. Reload the VS Code window to activate the updated prompt in an existing extension host.

`npm run lint` passed after adding the type-aware Oxlint runtime dependency and resolving the reported diagnostics. `npm run fmt:check` also passed.

## Acceptance still requiring direct observation

- Subtitle readability on long lines, narrow splits, wrapped lines, themes, and zoom.
- Live-generation command interaction, Undo history, keyboard conflicts and dismissal precedence.
- Screen-reader behavior, right-to-left language layout, Windows/Linux, and other excluded environments.
- Actual Copilot availability, first-use consent, translation accuracy, and preservation of negation/conditions.
- Time to first useful explanation and completion latency under the documented measurement protocol.

Do not describe the preview as meeting these acceptance criteria until the corresponding checks are recorded. Automated tests establish deterministic contracts; they do not establish model quality or perceived performance.
