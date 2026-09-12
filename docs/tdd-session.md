# Subtitle Session TDD Notes

This document records the behavioral cycles for the subtitle session. Tests use the public `SubtitleSession` operations and controlled gateway, view, cache, and clock ports.

## Cycle 1: stream the first explanation

RED: `test/session.test.ts` specifies that a valid explicit request renders the first nonempty stream fragment before the provider completes, then renders the complete text when the stream ends. The initial command failed because `SubtitleSession` did not exist and the shared policy module had not yet been supplied.

GREEN: `src/session.ts` now provides the request path, immediate first-fragment rendering, final output validation, and completed-result caching. `npm test` passes the policy and session tests.

The session keeps the request identity and snapshot together, passes one abort signal through preparation and streaming, and checks the active request before every view or cache effect. It clears partial output on cancellation, failure, timeout, or invalid completion and never truncates an overlong response.

The raw stream is bounded at 16,000 UTF-16 code units before normalization. This protects the extension host from a provider emitting whitespace indefinitely while the visible subtitle remains empty; the limit is an internal safety cap and is not a user-facing output limit.

## Cycle 2: cancellation wins over an uncooperative provider

RED: The next behavioral test held request A's stream promise open forever, started request B, and required both public `show` promises to settle while B's completed subtitle remained visible. This exposed the need to race provider preparation and streaming against the request abort signal rather than waiting for provider cooperation.

GREEN: `SubtitleSession` resolves the cancelled request through the abort race, leaves the old request unable to clear or notify the replacement, and allows B to complete normally. The cycle passes in `npm test`.

## Cycle 3: stale stream isolation

RED: A controlled stream was allowed to emit another fragment and then fail after request A had been cancelled by request B. The required behavior was that neither the late fragment nor the late failure could change B's subtitle or produce a notification.

GREEN: The session checks the active request before consuming each fragment and uses the same guard for delayed cleanup. Late iterator activity is discarded after cancellation. The cycle passes in `npm test`.

## Cycle 4: completed-result reuse and expiry

RED: The next test completed one request, invoked `show` again for the same input, and required the second invocation to reuse the completed result without another stream. It also required the temporary view to clear when its display deadline fired.

GREEN: A visible request is allowed to start a new session, so the cache can be checked again and its expiry timer is renewed. Cache hits transition to the visible lifecycle before scheduling expiry. The cycle passes in `npm test`.

## Cycle 5: invalid output has no partial success

RED: The next test streamed a response over the language limit and required the session to clear the view, report `outputInvalid`, and leave the cache unchanged. The session must not truncate the response into an apparently valid subtitle.

GREEN: The session checks the normalized stream length incrementally, aborts the request when the limit is exceeded, and only writes a validated completed response. The focused session slice passes with `node scripts/test-slice.cjs session`.

## Cycle 6: authorized request timeout

RED: The next test held an already-authorized stream open and advanced the controlled clock. It required a timeout notification, cleared subtitle state, and no cache entry.

GREEN: The 10-second request timer starts before calling the authorized stream operation. Its callback aborts the active request and wins the cancellation race, so the public `show` promise settles even if the provider promise never resolves. The focused session slice passes with `node scripts/test-slice.cjs session`.

## Cycle 7: validate the raw stream before normalization

RED: A response with a valid first line followed by a Markdown list was normalized into one plain line before validation. The new test required the raw line structure to remain subject to the output contract.

GREEN: Final validation now receives the raw accumulated stream, while normalization is applied only to the displayed and cached value after validation succeeds. The focused session slice passes with `node scripts/test-slice.cjs session`.

## Cycle 8: separate first-use consent from generation timeout

RED: The next test held the unconsented response handle open and advanced the clock. It required no generation timeout during that wait, then required the normal timeout after the response handle resolved and streaming had begun.

GREEN: The session starts the request deadline only after an unconsented stream operation returns its response handle. Cancellation remains available while consent is pending. The focused session slice passes with `node scripts/test-slice.cjs session`.

## Cycle 9: document invalidation

RED: A request with an uncooperative stream was invalidated through the public document event. The required behavior was immediate clearing and cancellation without an error notification or automatic retry.

GREEN: `invalidateDocument` invalidates matching cache entries and cancels the active request by document URI. The focused session slice passes with `node scripts/test-slice.cjs session`.

## Cycle 10: provider cancellation is quiet

RED: The model adapter can report a user-cancelled consent or picker action as an `AbortError`. The test required the subtitle to clear without surfacing a network failure.

GREEN: The session treats an `AbortError` from an otherwise-current request as cancellation, while unknown provider errors still map to the safe `network` failure. The focused session slice passes with `node scripts/test-slice.cjs session`.

## Cycle 11: duplicate active commands

RED: The next test invoked `show` twice with the same active snapshot while the first stream was still pending. It required one generation and one completed subtitle.

GREEN: The session deduplicates only an identical request in the running lifecycle. Once visible, a repeated command starts a fresh session so cache lookup can renew the display deadline. The focused session slice passes with `node scripts/test-slice.cjs session`.

## Cycle 12: clear-cache invalidates active work

RED: The next test started a stream, cleared the cache while partial output was active, then released a late completion. It required the view to clear and the late result to stay out of the cache.

GREEN: `clearCache` clears stored entries and cancels the active request before the stream can complete. The focused session slice passes with `node scripts/test-slice.cjs session`.

## Cycle 13: disposal

RED: The next test disposed the session while the provider stream was still open, then invoked `show` again. It required the active request and cache to be released and later commands to have no effect.

GREEN: Disposal aborts the active request, clears the view and cache, and makes subsequent commands resolve quietly without preparing another request. The focused session slice passes with `node scripts/test-slice.cjs session`.

## Cycle 14: timer boundaries

RED: The initial test clock fired all callbacks immediately, so it could not prove the 50 ms batching, 10 second request deadline, or 10 second display lifetime. The scheduler was changed to retain each timer's due time, and boundary assertions were added for 49/50 ms and 9,999/10,000 ms.

GREEN: The controlled clock now advances to due timers in order. Later stream fragments remain buffered at 49 ms and flush at 50 ms; authorized requests remain active at 9,999 ms and time out at 10,000 ms; completed subtitles remain visible at 9,999 ms and clear at 10,000 ms. The focused session slice passes with `node scripts/test-slice.cjs session`.

## Cycle 15: failures carry the request input

RED: A new test streamed an overlong response and required `notify` to receive the failed request's input alongside the `outputTooLong` code, so the view can render guidance beside the code. The recording view captured `undefined` because the session called `notify(code)` only.

GREEN: `fail` and the whitespace-only guard pass the request input to `notify(failure, input)`. The session still clears the view before reporting and still reports only for the current request. `npm test` passes.

## Cycle 16: reading-time display expiry

RED: A test completed a 200-grapheme subtitle through the stream and again through the cache, requiring the view to stay visible at 29,999 ms and clear at 30,000 ms on both paths. The fixed 10-second display lifetime from cycle 14 cleared it early.

GREEN: `showUntilExpiry` now takes the completed text and schedules expiry with `displayTtlMs` (grapheme count × 150 ms, clamped to 10–30 seconds) for the streamed-completion and cache-hit paths. The cycle 14 boundaries at 9,999/10,000 ms still hold for short text because 10 seconds is the minimum. `npm test` passes.

## Cycle 17: cache lookup before fitting

RED: Three tests required a repeated request to render the cached text with zero `fit` and zero `stream` calls, fitting to run outside the generation deadline and to cancel quietly on dismissal, and an `inputTooLarge` raised during fitting to be reported as that failure. The RED run hung rather than failed: the old session never called `fit`, so the deadline test waited for a fit start that never came (it now carries a 2 s timeout).

GREEN: `PreparedRequest` gained `fit(signal)`; `prepare` only resolves the model and access state. The session checks the cache immediately after `prepare`, calls `fit` on a miss, arms the request timer at the documented points afterwards, and stores completed results under the same pre-enrichment identity. Two older polling loops were widened from 20 to 50 microtasks because the extra await shifts the first fragment by a few ticks; the assertions are unchanged. The full suite passes with `npm test`.

## Cycle 18: content-free phase timing

RED: Two tests with the controlled clock and a recording observer required a streamed request to report `commandStart`, `prepared`, `requestStart`, `firstFragment`, `streamEnd`, `visible`, and `cleared` with the exact clock values, a repeated request to report `cacheHit` then `visible` with no `requestStart`, a dismissal to report `cancelled` then `cleared`, and an invalid completion to report `failed(outputInvalid)` then `cleared`. The serialized events had to contain no selection text, output text, URI, or editor identifier. Both failed because the session had no observer port.

GREEN: `SubtitleSessionOptions.observer` receives `{ requestId, at, name }` (plus `code` for `failed`) at each phase using `clock.now()`; the default session clock is now `performance.now()` so timestamps are monotonic. Superseding a visible subtitle reports `cancelled` and `cleared` for the old request before `commandStart` of the new one. The full suite passes with `npm test`.
