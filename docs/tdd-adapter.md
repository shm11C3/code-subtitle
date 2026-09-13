# VS Code adapter TDD notes

Status: implementation notes for the MVP adapter. These notes record the boundary and test evidence; they do not claim live-model validation.

The adapter keeps VS Code objects at the outer boundary. `VscodeModelGateway` exposes the core `ModelGateway` contract, while `VscodeSubtitleView` exposes `SubtitleView`. The model gateway receives the VS Code model API, access information, Quick Pick, and input-fitting function as dependencies so node tests can use fake boundary objects without loading a live extension host.

The gateway uses `vendor:id` model identities. A configured `vendor:id` setting must match both fields returned by VS Code exactly; a bare setting remains a Copilot ID for compatibility. With `auto`, the gateway queries Copilot first and, only when no Copilot model is available, queries all providers. It presents the available models in VS Code's order, labels them with their vendor-qualified key, and remembers the user's Quick Pick choice through the injected `ModelChoiceStore` (the extension backs it with `globalState` under `codeSubtitle.autoModelKey`); it does not rank or label models with invented speed claims. Model catalog and configuration changes invalidate the in-memory model only; the stored key is re-validated on the next resolve and replaced through the picker when it is no longer available.

`fitInput` supplies the final prompt and calls the injected token counter. The adapter converts each `AbortSignal` into a disposable `CancellationTokenSource`, passes a user message to `countTokens`, and disposes the source on completion, error, or abort. The stream bridge follows the same rule for `sendRequest`; a provider error is converted to a typed `SubtitleError` code and never exposes the provider's message.

`prepare` resolves the model and access state only and returns the pre-enrichment prompt as cache key material. Evidence collection and token counting are deferred to `fit(signal)`, which the session calls after a cache miss; `stream(signal)` reuses the fitted prompt and fits first if `fit` has not run. RED: a new test required `prepare` to make no `countTokens` call, `fit` to count once, and `stream` to send the fitted prompt without counting again; the run hung because the old `prepare` awaited the held counter before returning. GREEN: the deferred `fit` closure memoizes the fitted result; the abort test now aborts `fit` and still observes immediate token-source cancellation and disposal.

The renderer owns one reusable decoration type. It anchors a zero-width range at the selected line's end, renders `after.contentText`, uses theme colors for phases, and clears through `setDecorations` without editing the document. The lookup callback makes the class usable from an extension host smoke test and keeps editor identity outside the renderer.

The first adapter behavior was tested as a vertical slice:

1. RED: the configured-model stream test expected token-source cleanup but the fake fit step did not exercise token counting, so only one source was created instead of two.
2. GREEN: the fake fit step called the injected counter, and the adapter passed `LanguageModelChatMessage.User` to `countTokens`. The targeted type check and six node tests then passed.
3. The focused tests cover exact configured-ID selection without Quick Pick, one-time automatic selection reuse, stream completion and token-source disposal, safe mapping of provider failures, and model re-selection after a stream-level `NotFound`.

`VscodeModelGatewayOptions.modelOptions` is an optional pass-through. RED: a test required `sendRequest` to receive no `modelOptions` key by default and the configured object under `modelOptions` when set, with the justification unchanged; it failed because the gateway always sent only the justification. GREEN: the gateway adds `modelOptions` to the request options only when configured. Production passes nothing; the live evaluation harness sets it from `CODE_SUBTITLE_EVAL_MODEL_OPTIONS`.

The production renderer smoke test uses synthetic text and asserts that document text, version, dirty state, and selection remain unchanged after preparing, streaming, visible, clear, and dispose phases. Real model requests, semantic translation quality, accessibility, and final TTFE remain extension-host or manual acceptance checks.

## Inline failure guidance

RED: `test/view.test.ts` loads the production renderer with a fake `vscode` module and an injected timer. It required actionable failures (`selection`, `inputTooLarge`, `outputInvalid`, `outputTooLong`, `timeout`, `network`) to render at the anchor line in `editorWarning.foreground` without a notification, failures needing action outside the editor (`modelUnavailable`, `accessDenied`, `blocked`) to keep the notification, a missing input or editor to fall back to the notification, and an inline failure to clear itself after one timer tick or when a new subtitle or `clear` arrives. The build failed because the renderer accepted only a lookup and `notify` had no input parameter.

GREEN: `VscodeSubtitleView` accepts optional timers, renders inline failures through the same decoration path as subtitles, keeps `codeSubtitle.active` true while the guidance is visible so `Esc` dismisses it, and arms a 5-second clear that `show`, `clear`, and `dispose` cancel. The extension's `dismiss` command and document invalidation clear the view directly because the session holds no active request after a failure. `npm test` passes.

## Persisted automatic model choice

RED: New adapter tests required a stored automatic choice to be reused without the picker, a stale stored ID to fall back to the picker and be overwritten, an explicit `codeSubtitle.model` ID to bypass the store, a catalog invalidation to keep and re-validate the stored ID silently, and an explicit `chooseModel` call to re-open the picker and update the store. Type checking failed because the gateway had no `choiceStore` option or `chooseModel` method.

GREEN: `resolveModel` consults the store before the picker in `auto` mode and writes the vendor-qualified key after a pick; a failed write is ignored so a request never fails because persistence did. `chooseModel` uses the same Copilot-first/all-provider fallback, shows the picker, stores the key, and adopts it immediately when the setting is `auto`. The extension registers `codeSubtitle.chooseModel`, clears cached results after a change as it does for a setting change, and notes when an explicit setting still takes precedence. `npm test` passes.

## Neutral progress colors

RED: A renderer test required preparing and streaming to use `editorCodeLens.foreground`, the completed subtitle to use `editorHint.foreground`, and the texts "Generating…", a trailing " …", and plain text to keep the states distinguishable without color. Preparing used `editorWarning.foreground`, so a normal state looked like an error.

GREEN: `phaseColor` reserves the warning color for inline failure guidance and gives both progress phases the CodeLens color. `npm test` passes.
