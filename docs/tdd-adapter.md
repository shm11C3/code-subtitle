# VS Code adapter TDD notes

Status: implementation notes for the MVP adapter. These notes record the boundary and test evidence; they do not claim live-model validation.

The adapter keeps VS Code objects at the outer boundary. `VscodeModelGateway` exposes the core `ModelGateway` contract, while `VscodeSubtitleView` exposes `SubtitleView`. The model gateway receives the VS Code model API, access information, Quick Pick, and input-fitting function as dependencies so node tests can use fake boundary objects without loading a live extension host.

The gateway always queries the `copilot` vendor. A configured model setting must match an available model ID exactly. With `auto`, the gateway presents the available models in the order returned by VS Code and remembers the user's one Quick Pick choice for the gateway's lifetime; it does not rank or label models with invented speed claims. Model catalog and configuration changes invalidate that choice.

`fitInput` supplies the final prompt and calls the injected token counter. The adapter converts each `AbortSignal` into a disposable `CancellationTokenSource`, passes a user message to `countTokens`, and disposes the source on completion, error, or abort. The stream bridge follows the same rule for `sendRequest`; a provider error is converted to a typed `SubtitleError` code and never exposes the provider's message.

`prepare` resolves the model and access state only and returns the pre-enrichment prompt as cache key material. Evidence collection and token counting are deferred to `fit(signal)`, which the session calls after a cache miss; `stream(signal)` reuses the fitted prompt and fits first if `fit` has not run. RED: a new test required `prepare` to make no `countTokens` call, `fit` to count once, and `stream` to send the fitted prompt without counting again; the run hung because the old `prepare` awaited the held counter before returning. GREEN: the deferred `fit` closure memoizes the fitted result; the abort test now aborts `fit` and still observes immediate token-source cancellation and disposal.

The renderer owns one reusable decoration type. It anchors a zero-width range at the selected line's end, renders `after.contentText`, uses theme colors for phases, and clears through `setDecorations` without editing the document. The lookup callback makes the class usable from an extension host smoke test and keeps editor identity outside the renderer.

The first adapter behavior was tested as a vertical slice:

1. RED: the configured-model stream test expected token-source cleanup but the fake fit step did not exercise token counting, so only one source was created instead of two.
2. GREEN: the fake fit step called the injected counter, and the adapter passed `LanguageModelChatMessage.User` to `countTokens`. The targeted type check and six node tests then passed.
3. The focused tests cover exact configured-ID selection without Quick Pick, one-time automatic selection reuse, stream completion and token-source disposal, safe mapping of provider failures, and model re-selection after a stream-level `NotFound`.

`VscodeModelGatewayOptions.modelOptions` is an optional pass-through. RED: a test required `sendRequest` to receive no `modelOptions` key by default and the configured object under `modelOptions` when set, with the justification unchanged; it failed because the gateway always sent only the justification. GREEN: the gateway adds `modelOptions` to the request options only when configured. Production passes nothing; the live evaluation harness sets it from `CODE_SUBTITLE_EVAL_MODEL_OPTIONS`.

The production renderer smoke test uses synthetic text and asserts that document text, version, dirty state, and selection remain unchanged after preparing, streaming, visible, clear, and dispose phases. Real model requests, semantic translation quality, accessibility, and final TTFE remain extension-host or manual acceptance checks.
