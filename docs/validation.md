# MVP Validation

Status: local preview implemented on 2026-09-12. Deterministic and extension-host smoke checks pass; manual product acceptance remains open.

## Environment

- macOS arm64, desktop VS Code 1.135.0.
- Node.js 24.11.1 for local development; Node.js 26.5.1 types and Node.js 22 CI target.
- VS Code API types 1.134.0; only stable APIs.
- Isolated extension-host profile and synthetic input for renderer tests.

## Observed results

- `npm run check`: passed.
- `npm test`: 84 tests passed across policy, cache, session, model adapter, semantic provider, and event integration.
- `npm run package`: produced the local `code-subtitle-0.0.1.vsix` preview.
- VSIX inspection: runtime JavaScript, manifest, and preview README included; no test fixtures, development dependencies, source maps, or local test profile.
- Real extension-host activation: all three commands registered; dismiss and clear-cache executed without document mutation.

The production decoration renderer passed its real extension-host smoke test. Preparing, partial, completed, and cleared states did not change source text, document version, dirty state, selected range, or the active editor. No model request was made.

The main session could not inspect the isolated test window through the available native UI binding, which continued to target the regular VS Code process. A successful renderer API call is not proof of pixel-level readability. The visual scenarios remain reproducible through `CODE_SUBTITLE_VISUAL_CHECK=1 npm run test:host`.

## Experienced-reader output revision

On 2026-09-12, prompt policy version `2` added an experienced OSS/code-review audience, one grounded engineering insight, calibration examples, and the existing language-specific display limits. Two failing-first policy checks covered the request instructions/data boundary and the display-limit instruction; the full 57-test suite and TypeScript check passed. These checks verify prompt construction, not generated meaning. [Output quality](output-quality.md) contains the manual semantic evaluation cases; live-model acceptance remains pending.

The updated VSIX was packaged and reinstalled in the normal VS Code profile. The installed `policy.js` SHA-256 matched the build output. Reload the VS Code window to activate the updated prompt in an existing extension host.

`npm run lint` passed after adding the type-aware Oxlint runtime dependency and resolving the reported diagnostics. `npm run fmt:check` also passed.

## Bounded semantic context revision

Prompt policy version `3` adds whitelisted optional provider evidence while keeping dependency URI/version metadata local. The new `codeSubtitle.semanticContext` user setting defaults to enabled. Collection is bounded to three selected identifiers, one-hop workspace definitions, a 600 ms deadline, and 4,000 UTF-16 code units of evidence. Provider failures/timeouts fall back without a second model call. Same-workspace changes and configuration changes conservatively invalidate semantic results.

On 2026-09-12, `npm run check`, all 78 tests, `npm run lint`, and `npm run fmt:check` passed. Final real-host runs passed with VS Code 1.135.0 on macOS arm64 in both modes:

- Built-in TypeScript: real Hover, Definition, and Type Definition results plus the production semantic collector.
- Native TypeScript 7: installed `TypeScriptTeam.native-preview` 0.20260708.2 copied into an isolated profile, with `js/ts.experimental.useTsgo` enabled; the same checks passed.
- Both modes resolved an imported helper in a different file and included its implementation body and local dependency version. Source/helper text, document versions, dirty state, and editor selection remained unchanged.

See [Semantic host validation](semantic-host-validation.md) for reproducible commands. No live model request was made; these results establish context retrieval and deterministic behavior, not improved generated explanations or end-to-end latency.

The semantic-context VSIX was packaged and reinstalled into the normal VS Code profile. Installed `extension.js`, `policy.js`, and `vscode-semantic.js` matched the build byte-for-byte, and the installed setting defaults to enabled. Reload an existing VS Code window to activate this build.

## Relaxed output acceptance revision

Prompt policy version `4` retains concise targets of 100 Japanese grapheme clusters and 200 for other languages, while allowing display up to 200 and 400 respectively. Inline backticks and emphasis are accepted as literal text. Empty output, control characters, fenced code, headings, lists, block quotes, and links remain invalid. Output exceeding the hard limit has a separate message from unsupported output; responses are never truncated or automatically retried.

Synthetic examples reproduced rejection of a 104-grapheme Japanese explanation and a short explanation containing an inline identifier. Boundary tests cover inclusive hard limits and the next grapheme; session coverage verifies longer Japanese output streams and is cached intact. These checks do not establish the cause or frequency of failures in live model responses.

After recovering local disk space, all 84 tests, TypeScript checking, lint, and formatting passed on 2026-09-12.

The revised VSIX was packaged and reinstalled in the normal VS Code profile. Installed `policy.js`, `session.js`, `vscode-view.js`, and `extension.js` matched the build byte-for-byte. Local `.claude` worktrees are excluded from the package; the inspected archive contains 15 files (28.3 KB). Reload an existing VS Code window to activate the revision.

## Immediate UX improvements revision

On 2026-09-12, branch `feat/immediate-ux-improvements` (based on local `main` at `32663ae`) added inline failure guidance, a persisted automatic model choice with a `Code Subtitle: Choose Model` command, a current-line fallback for an empty selection, an editor context-menu entry, the `Shift+Alt+E` Windows/Linux shortcut, subtitle persistence when the anchor scrolls out of view, a 10–30 second reading-time display expiry, and neutral progress colors. Each behavior change was driven by a failing test first; see the role-specific TDD notes.

Observed results on macOS arm64 with Node.js 24:

- `npm run check`: passed.
- `npm run lint`: passed.
- `npm run fmt:check`: passed.
- `npm test`: 106 tests passed across policy, cache, session, model adapter, renderer, semantic provider, and event integration.
- `npm run package`: produced `code-subtitle-0.0.1.vsix` (15 files, 30.1 KB).
- `npm run test:host`: did not run. VS Code 1.135.0 failed to start because the isolated user-data directory under the agent's checkout produced an IPC socket path longer than 103 characters (`listen EINVAL ... .test-host/user-data-builtin/1.13-main.sock`). Registration of `codeSubtitle.chooseModel`, the context-menu entry, the new keybinding, inline failure rendering, and the current-line fallback therefore remain unverified in a real extension host.

The deterministic tests cover the inline-versus-notification decision and its 5-second clear, stored-choice reuse, stale-ID fallback, explicit-setting precedence, the Choose Model command, cursor-based dismissal of a current-line subtitle, persistence across visible-range changes, the display-expiry boundaries at 10 and 30 seconds on both the streamed and cached paths, and the phase colors. They do not establish on-screen readability of inline guidance, keyboard behavior on Windows/Linux, or live-model behavior.

## Acceptance still requiring direct observation

- Inline failure guidance readability and the `Shift+Alt+E` binding on Windows/Linux.

- Subtitle readability on long lines, narrow splits, wrapped lines, themes, and zoom.
- Live-generation command interaction, Undo history, keyboard conflicts and dismissal precedence.
- Screen-reader behavior, right-to-left language layout, Windows/Linux, and other excluded environments.
- Actual Copilot availability, first-use consent, translation accuracy, and preservation of negation/conditions.
- Time to first useful explanation and completion latency under the documented measurement protocol.

Do not describe the preview as meeting these acceptance criteria until the corresponding checks are recorded. Automated tests establish deterministic contracts; they do not establish model quality or perceived performance.
