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

For a visual inspection, set `CODE_SUBTITLE_VISUAL_CHECK=1` when running the command. Use the **Next** and **Finish** notification buttons to inspect the normal, long-line, and split-editor scenarios. This fixture is excluded from the VSIX.

## Manual acceptance

Record the host version and platform. Check normal and long lines, narrow split editors, wrapping, light/dark/high-contrast themes, zoom, existing line-end decorations, and keyboard dismissal precedence. Check document content, dirty state, and Undo history before and after real command use.

Use public or synthetic code for semantic and timing evaluation. Evaluate code purpose, uncertain intent, comment negation, and conditions separately. A passing automated test does not establish translation accuracy, screenshot readability, screen-reader support, or time to first useful explanation. Do not turn unmeasured performance targets into release claims.
