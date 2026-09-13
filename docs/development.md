# Development

Use Node.js 22 or newer and desktop VS Code 1.135 or newer for this initial preview. The API type definitions are pinned to 1.134, the closest published version below the local 1.135 validation host. Compatibility with older hosts has not been established.

```sh
npm ci
npm run check
npm test
npm run package
```

The package command creates `code-subtitle-0.0.1.vsix`. Its publisher ID is a local placeholder, and packaging does not publish it to a marketplace. The repository is released under the [MIT License](../LICENSE); a public publisher identity and Marketplace release are still separate decisions.

Open this repository in VS Code and launch **Run Code Subtitle** from Run and Debug to try the extension in a development host. Real generation requires an available language model from VS Code and whatever consent or configuration its provider requires. The extension makes no generation request until **Show Subtitle** is invoked with a valid selection.

## Deterministic tests

The core and adapter tests use Node's built-in test runner. Provider streams and the clock are controlled to test observable behavior without consuming model quota. See the role-specific TDD notes for recorded failing and passing cycles.

## Renderer smoke test

```sh
npm run test:host
```

The runner defaults to the standard macOS VS Code executable. Set `VSCODE_EXECUTABLE` to a desktop VS Code executable on other systems. It uses an isolated `.test-host` profile and extension directory; set `CODE_SUBTITLE_TEST_HOST_ROOT` to a short temporary path when the host's IPC socket path would otherwise be too long. The production renderer displays synthetic text and checks that the source, document version, dirty state, active editor, and selection are unchanged. It makes no model requests.

The same host also exercises real TypeScript provider commands and the semantic collector. Run `CODE_SUBTITLE_SEMANTIC_HOST=native npm run test:host` to check TypeScript 7 (tsgo) using an installed native extension copied into the isolated profile. See [Semantic host validation](semantic-host-validation.md) for setup and coverage.

The isolated host also loads the test-only language-model provider under `test/host/provider`. This exercises a non-Copilot `vendor:id` selection and streamed request without adding the provider to the product or VSIX. An installed third-party provider still needs separate manual validation for its authentication, quota, and data-handling behavior.

The host also opens a synthetic diff and renders a subtitle on the modified side. It defaults to side-by-side mode; run `CODE_SUBTITLE_DIFF_MODE=inline npm run test:host` for inline mode. The diff fixture uses only local `file:` URIs. `git:`, `pr:`, and `vscode-vfs:` review URIs are covered by node tests and intentionally skip semantic providers.

For a visual inspection, set `CODE_SUBTITLE_VISUAL_CHECK=1` when running the command. Use the **Next** and **Finish** notification buttons to inspect the normal, long-line, split-editor, and synthetic diff scenarios. Add `CODE_SUBTITLE_DIFF_MODE=inline` to inspect inline diff mode. This fixture is excluded from the VSIX.

macOS limits Unix socket paths to 103 characters and VS Code keeps its IPC socket under the user data directory, so a deep checkout (for example a git worktree) can fail with `listen EINVAL`. Set `CODE_SUBTITLE_HOST_ROOT` to a short directory to place `.test-host` and `.eval-host` there instead of the repository root.

## Live evaluation harness

```sh
npm run eval:live
```

This runs the seven cases from [Output quality](output-quality.md) (`test/eval/cases.ts`) through the production `createInput`, `VscodeModelGateway`, semantic-context, `fitInput`, and streaming code against a real Copilot model, then records the outputs for a human verdict. It is the only path in this repository that makes live model requests, and it never runs from `npm test`.

The launcher `scripts/eval-live.cjs` opens a desktop VS Code window with a dedicated, persistent profile: `.eval-host/user-data`, `.eval-host/extensions`, the workspace folder `.eval-host/workspace`, and `.eval-host/results`. Unlike the smoke test it keeps extensions enabled. Before the first run, install **GitHub Copilot Chat** from the Extensions view of that window and sign in once; the profile persists across runs. Without an available model the run prints a clear message and exits non-zero. The whole directory is gitignored and excluded from the VSIX.

Options are environment variables: `CODE_SUBTITLE_EVAL_MODEL=<id>` selects a model (otherwise the picker asks once per run and the choice is reused for all cases); `CODE_SUBTITLE_EVAL_SEMANTIC=0` disables semantic context; `CODE_SUBTITLE_EVAL_MODEL_OPTIONS='{"temperature":0.2}'` forwards provider options through `modelOptions`, which production never sets. Each case is written to its own file in the workspace with a matching extension, opened, fully selected, and run without a cache. The run prints a Markdown table and writes it to `.eval-host/results/<ISO timestamp>.md`: model vendor/id/version, output language, returned text, grapheme count, `validateOutput` result, milliseconds to the first non-empty fragment and to completion (both measured from request start, after model resolution and fitting), the number of semantic entries, and an empty `verdict` column for the human pass/reject decision. Only the synthetic cases and the model outputs are written.

## Timing log

Set `codeSubtitle.timingLog` to `true` to record phase timings for each subtitle request in the **Code Subtitle Timing** output channel. Each line has the form `request=<id> <event> +<ms since commandStart>ms` with the events listed in [Minimal design](minimal-design.md) §10. The log never contains code, prompts, subtitles, or file names, and no output channel is created while the setting is off. Use it with the measurement protocol in §10; `firstFragment` is the first rendered fragment, and a person still has to judge when the meaning became understandable.

## Manual acceptance

Record the host version and platform. Check normal and long lines, narrow split editors, wrapping, side-by-side and inline diffs, light/dark/high-contrast themes, zoom, existing line-end decorations, and keyboard dismissal precedence. Check document content, dirty state, and Undo history before and after real command use. For diff editors, verify the subtitle stays on the changed side and disappears when the active selection/editor changes.

Use public or synthetic code for semantic and timing evaluation. Evaluate code purpose, uncertain intent, comment negation, and conditions separately. A passing automated test does not establish translation accuracy, screenshot readability, screen-reader support, or time to first useful explanation. Do not turn unmeasured performance targets into release claims.
