# Code Subtitle

**Grasp meaning in an instant while reading code.**

[![CI](https://github.com/shm11C3/code-subtitle/actions/workflows/ci.yml/badge.svg)](https://github.com/shm11C3/code-subtitle/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Code Subtitle is a VS Code extension for experienced engineers reading OSS or reviewing unfamiliar code. It displays one short engineering insight for selected code, or a faithful translation of a comment, near the code in the reader's preferred language.

The current release is a locally packaged preview. It includes streamed rendering, cancellation, bounded semantic context from the language service, model-choice reuse, and an in-memory cache. Automated checks pass; visual acceptance, real-model quality, accessibility, and cross-platform keyboard validation remain open. See the [validation record](docs/validation.md).

## Install the preview

The preview targets desktop VS Code 1.135 or newer. To build and install it locally:

```sh
npm ci
npm run check
npm test
npm run package
```

In VS Code, run **Extensions: Install from VSIX…** and choose `code-subtitle-0.0.1.vsix`. To run the extension from source, open the repository in VS Code and launch **Run Code Subtitle** from Run and Debug. See the [development guide](docs/development.md) for host smoke tests and manual acceptance.

This preview uses a local publisher ID and is not published to the VS Code Marketplace yet. The source is available under the [MIT License](LICENSE).

## Why Code Subtitle

- Return to reading without moving your eyes away from the editor.
- Connect code to the responsibility, invariant, failure boundary, or tradeoff that matters when reading or changing it.
- Use VS Code's display language by default so comments and explanations can be understood in a familiar language.
- Keep API-key entry, long prompts, and answer-history management out of everyday use.
- Show subtitles only when needed, without changing source code.

The target is the small question that interrupts code reading: “What boundary does this guard protect?” or “What does this comment require?” Code Subtitle keeps that question beside the code and returns one grounded insight instead of opening a separate chat thread.

## Example

Select the code or comment you want to understand, or place the cursor on the line in question. Run **Code Subtitle: Show Subtitle** and continue reading while the insight streams beside the code.

For example, when the following code is selected:

```ts
const id = ++activeId;
const value = await load();
if (id !== activeId) return;
render(value);
```

```text
↳ The request ID gates rendering so a slower, superseded load cannot overwrite the current view.
```

When only a comment is selected:

```ts
// Do not retry non-idempotent requests.
```

```text
↳ Do not retry non-idempotent requests.
```

These are examples of displayed content. The extension does not insert into or replace the original text. When the reason cannot be inferred from the code, it does not present the author's intent as fact.

## Use it

1. Select code or a comment, or place the cursor on a non-empty line.
2. Run **Code Subtitle: Show Subtitle** from the editor context menu, Command Palette, or keyboard shortcut.
3. Read the streamed subtitle beside the code. Press `Esc` to dismiss it.

The default shortcuts are `Ctrl+Alt+E` on macOS and `Shift+Alt+E` on Windows/Linux. Change them in **Preferences: Open Keyboard Shortcuts** if they conflict with your layout.

The extension displays one temporary subtitle at a time. It clears when the selection changes, the document is edited, the editor changes, `Esc` is pressed, or the reading-time expiry is reached. An empty cursor selection uses the current line as the request.

## What it explains

| Input          | Result                                                                                          |
| -------------- | ----------------------------------------------------------------------------------------------- |
| Code           | One responsibility, invariant, failure boundary, or concrete tradeoff grounded in the selection |
| Comments only  | A short translation that preserves negation, conditions, and caveats                            |
| Unclear intent | The observable responsibility or the specific missing context, without inventing author intent  |

Code Subtitle is designed for OSS reading and human code review. It does not produce an automated review verdict, change source files, or turn a short question into a long lesson.

For Japanese, Chinese, and Korean, the default target is one sentence within 100 grapheme clusters, with a display allowance up to 200. Other languages target 200 grapheme clusters with an allowance up to 400. Only the Japanese limits have been read by native readers; the Chinese and Korean limits are an extrapolation from comparable character density and should be checked with the live evaluation harness. Accuracy of negation, conditions, and caveats takes priority over brevity; if the result does not fit, ask the user to make the selection smaller.

## Language and model support

The programming language follows the active VS Code language mode. The extension accepts any mode VS Code can open; language-service enrichment is used when that mode provides compatible Hover, Definition, or Type Definition providers. TypeScript's built-in service and TypeScript 7 (`tsgo`) have been validated through the same provider API. Other language modes fall back to the selected code and nearby lines when provider evidence is unavailable.

The subtitle language defaults to VS Code's display language. Set `codeSubtitle.outputLanguage` to a language tag such as `ja` or `en` to override it. Set `codeSubtitle.model` to a bare model ID to pin a Copilot model, or use `vendor:id` to select a model supplied by another VS Code language-model provider. With `auto`, Code Subtitle prefers Copilot when available and otherwise shows all models exposed through VS Code; the selected vendor-qualified model is remembered by **Code Subtitle: Choose Model** while it remains available.

## Data boundary

Code is sent only after an explicit command. The request contains the selected text and up to five adjacent lines on each side. With `codeSubtitle.semanticContext` enabled, it may also contain bounded type information, documentation, and one-hop definitions from the same workspace folder. Disable that setting to send only the selection and adjacent lines.

Code Subtitle does not require its own API key, does not run a separate backend, does not modify files, and does not send extension telemetry. Model-provider access, retention, and organization policy still apply. The cache stores completed subtitles in memory only.

## MVP boundaries

- Chat, a detailed panel, long explanations in Hover, and conversation history.
- Code generation, completion, or modification, and writing translations back to files.
- Indexing the entire repository, unrestricted related-file search, and continuous or proactive generation.
- Automated review, comprehensive syntax lessons, and full translation of long comments.
- A custom AI backend, extension-specific API-key settings, and persistent cache storage.

Diff editors, notebooks, browser editors, Remote environments, screen readers, and non-macOS keyboard behavior are not yet part of the validated preview. Track these gaps in the [open issues](https://github.com/shm11C3/code-subtitle/issues).

## Technical direction

The extension uses TypeScript and stable VS Code APIs, and sends requests through the VS Code Language Model API. Subtitles use Text Editor Decorations without source-editing APIs. Each request has a cancellation signal and an identifier so that late responses after cancellation are discarded. Automatic model selection checks Copilot first, then falls back to every model exposed by installed VS Code providers when Copilot is unavailable. The one-time picker remembers a vendor-qualified choice across VS Code restarts, re-validates it against the current catalog, and can be reopened with `Code Subtitle: Choose Model`; no unmeasured speed ranking is assumed.

“No API key required” means that Code Subtitle does not require registration of its own API key or backend. The selected provider may still require sign-in, consent, configuration, quota, or organization approval; those requirements and data-handling rules are provider-specific. The extension does not silently switch providers during an active session. [VS Code Language Model API](https://code.visualstudio.com/api/extension-guides/ai/language-model) and [Language Model Chat Provider API](https://code.visualstudio.com/api/extension-guides/ai/language-model-chat-provider)

On explicit execution, the selected content and up to five surrounding lines on each side are sent to the model. With `codeSubtitle.semanticContext` enabled, bounded language-service type information, documentation, and one-hop definition excerpts from the same workspace folder are also included when available. Disable this user-level setting to use only the selection and adjacent lines. Standard TypeScript and TypeScript 7 (tsgo) use the same VS Code provider APIs; no separate language server is launched by this extension. See [semantic context](docs/semantic-context-plan.md) for limits and fallback behavior.

The extension does not guarantee local model execution; data handling depends on the model provider and organization settings. The extension does not save or send code, responses, or file paths through its logs or telemetry, and the cache is limited to memory.

Speed is measured primarily by TTFE (Time To First Explanation: the time until the first subtitle that makes the meaning understandable). With consent granted, the extension already running, and a cache miss, the targets are **a median of no more than one second until a useful subtitle appears and a median of no more than two seconds until completion**. These are unmeasured targets, not guarantees. First use, slow connections, and cache hits will be measured separately. The opt-in `codeSubtitle.timingLog` setting records content-free phase timings in an output channel to support that measurement.

## Documentation and contribution

- [MVP product overview](docs/mvp-product-overview.md): target users, experience, scope, and acceptance criteria.
- [Minimal design](docs/minimal-design.md): APIs, rendering approach, cancellation, caching, privacy, and performance measurement.
- [Product principles](docs/product-principles.md): principles for deciding features and specifications.
- [Output quality](docs/output-quality.md): examples and evaluation criteria for OSS reading and human code review.
- [Development guide](docs/development.md): local setup, deterministic tests, extension-host smoke tests, and manual acceptance.

Bug reports and focused feature proposals are welcome in [GitHub Issues](https://github.com/shm11C3/code-subtitle/issues). Please include the VS Code version, platform, language mode, model, and whether semantic context was enabled; do not include private source code or prompts.

The product principles are authoritative for product decisions, the product overview is authoritative for MVP scope, and the minimal design is authoritative for technical details and numeric targets. The README is a user-facing summary of them.

## License

Code Subtitle is released under the [MIT License](LICENSE).
