# Code Subtitle

**Grasp meaning in an instant while reading code.**

`code-subtitle` is a VS Code extension for experienced engineers reading OSS or reviewing unfamiliar code. It displays one short engineering insight for selected code, or a translation of a comment, near the code in the reader's preferred language.

An initial local preview is implemented. It includes subtitle commands, streamed rendering, request cancellation, bounded input, and in-memory caching. Automated tests and a VS Code extension-host smoke test pass; visual acceptance, real-model quality, and performance evaluation remain open. See the [validation record](docs/validation.md).

## Try the preview

Use desktop VS Code 1.135 or newer and Node.js 22 or newer. Run `npm ci`, `npm test`, and `npm run package`, then use **Extensions: Install from VSIX…** to install `code-subtitle-0.0.1.vsix`. For a development host, open Run and Debug and launch **Run Code Subtitle**. See [development instructions](docs/development.md).

The package uses a local placeholder publisher. It has not been published to a marketplace, and an OSS license has not yet been selected.

## Value

- Return to reading without moving your eyes away from the editor.
- Connect code to the responsibility, invariant, failure boundary, or tradeoff that matters when reading or changing it.
- Use VS Code's display language by default so comments and explanations can be understood in a familiar language.
- Keep API-key entry, long prompts, and answer-history management out of everyday use.
- Show subtitles only when needed, without changing source code.

## Example flow

1. Select the code or comment you want to understand, or just leave the cursor on the line in question.
2. Run `Code Subtitle: Show Subtitle` from the shortcut, the editor's right-click context menu, or the Command Palette. Default shortcuts are `Shift+Alt+E` on Windows/Linux and `Ctrl+Alt+E` on macOS. The Windows/Linux key avoids the menu-bar mnemonic `Alt+E` (Edit menu) but has not been verified on real Windows/Linux hardware. Customize them in VS Code's Keyboard Shortcuts editor to suit your keyboard layout and existing bindings.
3. A short subtitle streams in near the end of the selection.
4. The subtitle disappears when you continue reading and change the selection. Pressing `Esc` while it is visible also dismisses it.

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

## MVP scope

| Included                         | Policy                                                                                                            |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Selection → shortcut → subtitle  | Generate only after an explicit action; target one selection, or the cursor's line when nothing is selected       |
| Short explanation or translation | Surface one grounded engineering insight for code; translate comments while preserving their meaning              |
| One or two lines near the code   | The MVP baseline is one line rendered with a Decoration; decide whether to use two lines after display validation |
| Streaming                        | Start displaying from the first content instead of waiting for the full response                                  |
| Temporary subtitle               | Clear it on selection change, edit, editor switch, `Esc`, or expiry (10–30 s, scaled to the text length)          |
| Cancellation and reuse           | Cancel old requests and use a short-lived, workspace-scoped memory cache                                          |
| Minimal configuration            | Use automatic output language and automatic model selection by default                                            |

For Japanese, the default target is one sentence within 100 grapheme clusters, with a display allowance up to 200. Other languages target 200 grapheme clusters with an allowance up to 400. Accuracy of negation, conditions, and caveats takes priority over brevity; if the result does not fit, ask the user to make the selection smaller.

## Non-goals

- Chat, a detailed panel, long explanations in Hover, and conversation history.
- Code generation, completion, or modification, and writing translations back to files.
- Indexing the entire repository, unrestricted related-file search, and continuous or proactive generation.
- Automated review, comprehensive syntax lessons, and full translation of long comments.
- A custom AI backend, extension-specific API-key settings, and persistent cache storage.

## Technical direction and usage assumptions

The extension uses TypeScript and stable VS Code APIs, and sends requests through the VS Code Language Model API. Subtitles use Text Editor Decorations without source-editing APIs. Each request has a cancellation signal and an identifier so that late responses after cancellation are discarded. In this preview, automatic model selection shows a picker of available Copilot models once and remembers the choice across VS Code restarts (re-validated against the available models, and changeable with `Code Subtitle: Choose Model`); no unmeasured speed ranking is assumed.

“No API key required” means that Code Subtitle does not require registration of its own API key. The standard MVP path is a GitHub Copilot-provided model available in VS Code, so usage permission, sign-in, initial consent for the extension, and an available quota may be required. This does not promise unconditional free use or offline operation. [VS Code Language Model API](https://code.visualstudio.com/api/extension-guides/ai/language-model)

On explicit execution, the selected content and up to five surrounding lines on each side are sent to the model. With `codeSubtitle.semanticContext` enabled, bounded language-service type information, documentation, and one-hop definition excerpts from the same workspace folder are also included when available. Disable this user-level setting to use only the selection and adjacent lines. Standard TypeScript and TypeScript 7 (tsgo) use the same VS Code provider APIs; no separate language server is launched by this extension. See [semantic context](docs/semantic-context-plan.md) for limits and fallback behavior.

The extension does not guarantee local model execution; data handling depends on the model provider and organization settings. The extension does not save or send code, responses, or file paths through its logs or telemetry, and the cache is limited to memory.

Speed is measured primarily by TTFE (Time To First Explanation: the time until the first subtitle that makes the meaning understandable). With consent granted, the extension already running, and a cache miss, the targets are **a median of no more than one second until a useful subtitle appears and a median of no more than two seconds until completion**. These are unmeasured targets, not guarantees. First use, slow connections, and cache hits will be measured separately.

## Documentation

- [MVP product overview](docs/mvp-product-overview.md): target users, experience, scope, and acceptance criteria.
- [Minimal design](docs/minimal-design.md): APIs, rendering approach, cancellation, caching, privacy, and performance measurement.
- [Product principles](docs/product-principles.md): principles for deciding features and specifications.
- [Output quality](docs/output-quality.md): examples and evaluation criteria for OSS reading and human code review.

The product principles are authoritative for product decisions, the product overview is authoritative for MVP scope, and the minimal design is authoritative for technical details and numeric targets. The README is a summary of them.
