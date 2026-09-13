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
- `npm run test:host`: passed on the branch head (`84fb9b0`) with VS Code 1.135.0 in builtin mode when launched with the same arguments from a short profile path (`/private/tmp/cs-host-a`). The renderer smoke, activation and registration of all four commands including `codeSubtitle.chooseModel`, the cross-file semantic smoke, and the builtin semantic host smoke passed with no model requests. Launching from the agent worktree itself failed before startup because the isolated user-data directory produced an IPC socket path longer than 103 characters (`listen EINVAL ... .test-host/user-data-builtin/1.13-main.sock`); letting `scripts/test-host.cjs` take the profile location from an environment variable is a follow-up. On-screen rendering of inline failure guidance, the context-menu entry, and the new keybinding remain unverified by direct observation.

The deterministic tests cover the inline-versus-notification decision and its 5-second clear, stored-choice reuse, stale-ID fallback, explicit-setting precedence, the Choose Model command, cursor-based dismissal of a current-line subtitle, persistence across visible-range changes, the display-expiry boundaries at 10 and 30 seconds on both the streamed and cached paths, and the phase colors. They do not establish on-screen readability of inline guidance, keyboard behavior on Windows/Linux, or live-model behavior.

## Other language-model provider revision

Issue #2 removes the Copilot-only assumption from model selection. The stable VS Code surface was verified against the [Language Model API](https://code.visualstudio.com/api/extension-guides/ai/language-model), the [Language Model Chat Provider API](https://code.visualstudio.com/api/extension-guides/ai/language-model-chat-provider), and the [API reference](https://code.visualstudio.com/api/references/vscode-api#lm): provider extensions contribute a vendor and return `LanguageModelChat` objects; consumers can call `selectChatModels({ vendor, id })` or omit the selector to enumerate all available models.

The adapter now accepts `vendor:id`, keeps bare model IDs compatible as Copilot IDs, prefers Copilot in `auto`, falls back to all vendors when Copilot is unavailable, and stores automatic choices as vendor-qualified keys. Node tests cover exact vendor matching, Copilot preference, all-provider fallback, duplicate-safe picker identities, stored-choice reuse, stale-choice replacement, and neutral failure guidance.

On 2026-09-12, `npm run check`, `npm run lint`, `npm run fmt:check`, and all 114 tests passed. The real VS Code 1.135.0 extension-host smoke also passed on macOS arm64 using an isolated test-only provider contributed as `code-subtitle-test`; it selected `code-subtitle-test:test-model`, streamed a subtitle through the production gateway, and preserved document text, version, dirty state, and selection. The test provider is under `test/` and excluded from the VSIX. No installed external provider was available in this environment, so provider-specific authentication, quota, retention, and live output quality remain unverified.

## Quality and speed revision

Prompt policy version `5` selects calibration examples by `languageId` (Rust, Go, Python, and a TypeScript fallback) and applies the Japanese output limits to Chinese and Korean; the zh/ko limits are an unvalidated extrapolation. The session now checks the cache before semantic collection and token fitting, `fitInput` skips `countTokens` while the prompt's UTF-8 byte length fits the budget, an opt-in `codeSubtitle.timingLog` setting records content-free phase timings, and `npm run eval:live` provides a live evaluation harness for the output-quality cases.

On 2026-09-12, `npm run check`, `npm run lint`, `npm run fmt:check`, all 99 tests, and `npm run package` passed; the packaged VSIX contains the 15 runtime files and excludes `test/**` and `.eval-host/**`. `npm run test:host` passed on VS Code 1.135.0 (macOS arm64) in built-in mode: renderer, activation and command, cross-file semantic, and semantic host smoke, with no model request. From the deep worktree used for this revision the default `.test-host` path exceeded the macOS Unix-socket limit (`listen EINVAL`), so the run used the new `CODE_SUBTITLE_HOST_ROOT` override with a short directory.

`npm run eval:live` was run once in a fresh profile with no Copilot extension: it printed the "No Copilot model is available in the evaluation profile" guidance, wrote no results file, and exited with code 1. No live model request was made; the harness has not been run against a signed-in Copilot profile, so the recorded outputs, the effect of language-aware examples, the zh/ko limits, and any `modelOptions` experiment remain unevaluated.

After merging `main` with the immediate UX improvements into this branch, the conflicting additions were combined (inline failure guidance keeps the request input while the observer reports the failure; the reading-time expiry and the `cleared` event share `showUntilExpiry`). On 2026-09-12, `npm run check`, `npm run lint`, `npm run fmt:check`, all 121 tests, and `npm run package` passed on the merged tree, and the extension-host smoke passed again from a short profile path.

## Diff editor and PR review validation

Issue #3 is implemented as a validation slice. The renderer uses the active modified-side `TextEditor` supplied by VS Code, so it follows the same zero-width end-of-line decoration path in regular editors and diff editors. No diff-specific request hint is added: the bounded prompt already describes only the selected code and nearby context, and no live evaluation evidence currently shows that a diff label improves the explanation.

Deterministic review-URI coverage verifies that `git:`, `pr:`, and `vscode-vfs:` inputs return an empty semantic context without invoking any provider command. This keeps review views responsive and falls back to the existing selection-plus-adjacent-lines prompt. The existing short-term cache path remains available when `workspace.getWorkspaceFolder` is unavailable.

The real extension-host smoke opens a synthetic `file:` diff and renders a subtitle on the modified line in both modes:

| Matrix case                             | Automated result                             | Direct visual result                                           |
| --------------------------------------- | -------------------------------------------- | -------------------------------------------------------------- |
| Side-by-side, light theme               | Passed on macOS arm64 / VS Code 1.135.0      | Pending: requires an unlocked desktop                          |
| Inline, light theme                     | Passed with `CODE_SUBTITLE_DIFF_MODE=inline` | Pending: requires an unlocked desktop                          |
| Side-by-side, dark theme                | API/non-mutation path is covered             | Pending: run the visual check with a dark theme                |
| Inline, dark theme                      | API/non-mutation path is covered             | Pending: run the visual check with a dark theme                |
| Side-by-side, high contrast             | API/non-mutation path is covered             | Pending: run the visual check with a high-contrast theme       |
| Inline, high contrast                   | API/non-mutation path is covered             | Pending: run the visual check with a high-contrast theme       |
| `git:`, `pr:`, `vscode-vfs:` review URI | Provider-skip regression tests passed        | Requires the Git/GitHub PR provider to open a live review view |

The host smoke also checks that the modified document text, version, dirty state, and selection are unchanged. It does not claim pixel-level readability, screen-reader support, GitHub Pull Requests integration, or Windows/Linux support; record those observations separately before describing diff editors as fully supported.

The visual run was not completed in this session because the macOS desktop was locked and could not be unlocked by the available UI binding.

## Acceptance still requiring direct observation

### Marketplace preparation checks (2026-09-13)

On `feat/prepare-marketplace-publication`, based on `52698c4`, type checking, lint, formatting, all 133 node tests (including four release-policy tests), and `actionlint` passed. A real VS Code host passed renderer, public-ID activation, non-Copilot provider, side-by-side diff, and built-in semantic smoke checks after changing the publisher to `Shm11C3`.

The generated `code-subtitle-0.1.0.vsix` contains the public publisher, MIT manifest metadata, the unchanged MIT license text, the Marketplace README, and the Marketplace pre-release property. Archive inspection confirmed that tests, demo fixtures, scripts, and logo proposals are excluded. Packaging bypasses for missing repository and license are removed.

After separating release channels from version numbers, all 134 tests (including five release-policy tests), type checking, lint, formatting, packaging, and `actionlint` passed. In a temporary copy, tag validation and actual VSIX packaging verified `0.3.0` with `releaseChannel: "stable"` and `0.2.0` with `releaseChannel: "pre-release"`, including the GitHub channel output and presence or absence of the Marketplace pre-release property. Missing and invalid channels are rejected. The initial manifest remains `0.1.0` / `pre-release`.

The user selected logo concept A (Inline Caption). After refinement and a 128 × 128 PNG export to `resources/icon.png`, publication validation passed. Repackaging confirmed that the manifest references the icon, its bytes are included unchanged, and the VSIX declares the Marketplace icon asset. No Marketplace publication, tag push, or live-model acceptance was performed. See the [release checklist](releasing.md).

On 2026-09-13, a dedicated `Code Subtitle Recording` profile in the existing VS Code 1.135.0 macOS arm64 process resolved the native capture tool's separate-process targeting limitation. The real extension and the fixed-response demo provider were loaded as development extensions, with installed extensions disabled. The test-only provider supports Restricted Mode and does not make network requests.

The [10-second GIF](media/code-subtitle-demo.gif) shows code selection, **Show Subtitle** through the Command Palette, partial and completed decoration text, and `Esc` clearing the subtitle. Captured editor tabs remained clean. The GIF uses a 1000 × 370 crop at 15 fps, preserves the fixed-response disclosure, and adjusts pauses for readability. Key frames were inspected after GIF encoding. The default `Ctrl+Alt+E` shortcut could not be reliably delivered by native automation, so this recording does not validate it. This is a UI demonstration with scripted text and streaming delay, not live-model quality, end-to-end latency, or broad visual acceptance.

### Remaining product acceptance

- Inline failure guidance readability and the `Shift+Alt+E` binding on Windows/Linux.

- Subtitle readability on long lines, narrow splits, wrapped lines, diff editors, themes, and zoom.
- Live-generation command interaction, Undo history, keyboard conflicts and dismissal precedence.
- Screen-reader behavior, right-to-left language layout, Windows/Linux, and other excluded environments.
- Actual external-provider availability, first-use consent, provider-specific data handling, translation accuracy, and preservation of negation/conditions.
- Time to first useful explanation and completion latency under the documented measurement protocol.

Do not describe the preview as meeting these acceptance criteria until the corresponding checks are recorded. Automated tests establish deterministic contracts; they do not establish model quality or perceived performance.
