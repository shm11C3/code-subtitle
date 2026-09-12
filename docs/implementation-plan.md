# MVP Implementation Plan

Status: approved by the user on 2026-09-12; local preview implemented. See [validation](validation.md) for completed checks and outstanding product acceptance.

The user subsequently authorized [bounded semantic context](semantic-context-plan.md), extending the original selection-only data boundary through VS Code provider APIs. That plan records the additional limits, fallback, configuration, and regression cases.

## Outcome

A locally installable desktop VS Code extension that turns one explicit selection into a short, streamed subtitle without editing the document or interrupting reading. The existing product overview and minimal design define the scope. Publishing to a marketplace and choosing an OSS license are separate release decisions.

## Architecture

Use TypeScript with a small VS Code adapter and a deterministic core. Do not add a backend, webview, repository index, or general extension framework.

| Boundary                           | Public behavior                                                                                          | Owner during implementation                 |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| Input and output policy            | Validate one selection; bound adjacent context; build a prompt; normalize and validate subtitle text     | Luna / max: core policy                     |
| Subtitle session                   | Start, deduplicate, cancel, expire, and invalidate requests; prevent stale output and stale cleanup      | Luna / max: session control                 |
| Memory cache                       | Retrieve and store completed results; enforce expiry, memory limits, and document/workspace invalidation | Luna / max: core policy, after input policy |
| VS Code adapter                    | Register commands/events; resolve a Copilot model; count tokens; stream text; render decorations         | Luna / max: extension integration           |
| Integration and product acceptance | Resolve difficult API/race issues; inspect UX; review contracts and scope; integrate and verify          | Main session                                |

Module interfaces will follow a tracer bullet rather than a speculative framework. The session receives an immutable request snapshot, a model gateway, a subtitle view, a cache, and a clock. The gateway exposes preparation and cancellable text streaming. The view exposes preparing, partial, complete, and clear states without document mutation. Adapters translate VS Code events into session invalidation; model-specific objects do not enter input policy or cache logic.

## Implementation sequence

1. **Rendering gate.** Build a minimal development-host harness with fixed subtitle text. Inspect normal and long lines, split editors, wrapping, themes, font zoom, and dismissal. No real model is required. If a one-line decoration cannot deliver readable text near the selection, return to a concrete UX decision before expanding implementation.
2. **First vertical slice.** With one behavioral test failing first, implement explicit valid selection → controlled streamed response → completed subtitle. Establish the build and test harness alongside this slice.
3. **Request lifecycle.** Add one failing behavioral test at a time for dismissal, selection/edit/editor invalidation, stale streams and errors, duplicate commands, expiry, timeout, and disposal.
4. **Input and output boundaries.** Incrementally test oversized selections, line-boundary anchors, adjacent context limits, token-driven context reduction, translation instructions, grapheme limits, and invalid/incomplete output rejection.
5. **Model integration and reuse.** Add the Copilot adapter, safe error messages, language/model settings, first-use disclosure, and bounded memory caches. Use fake providers in automated tests and real providers only for explicit manual acceptance.
6. **MVP acceptance.** Run type checks, behavioral tests, extension-host smoke tests, packaging inspection, and manual display/non-mutation checks. Record unavailable live-model and platform checks explicitly.

Each step follows RED → GREEN → focused refactor. Capture the failing test command and cause before implementing the behavior. Do not write a complete test suite against imagined internals before implementing the first path. Agents work in assigned files; shared contracts are agreed before concurrent implementation begins.

## Priority behavioral tests

1. Only a user command with a valid single selection can request a subtitle; source text stays unchanged.
2. The first nonempty fragment is visible before completion, and only a valid completed response enters the cache.
3. After A is cancelled and B starts, A's delayed fragments, exception, timer, and cleanup cannot affect B.
4. Selection changes, edits, editor switches, off-screen targets, dismissal, and closure cancel and clear without automatic resubmission.
5. Input context stays within the documented boundaries; paths and unrelated files never enter the prompt.
6. Cache hits avoid generation; edits, settings/model changes, clear-cache, and workspace removal prevent stale reuse.
7. Timeouts, unavailable models, denied access, interrupted streams, and malformed output show safe guidance without leaking provider payloads or retrying automatically.

Use public module behavior with controlled provider streams and a controllable clock. Verify real VS Code wiring separately in the extension host. Automated tests do not establish semantic translation quality, actual decoration readability, accessibility, or TTFE.

## Decisions and validation gates

- Keep the existing one-line decoration as the first candidate. Do not assume a stable two-line overlay exists.
- Until measured model preferences exist, `auto` falls back to the documented one-time choice among available Copilot models; do not invent a speed ranking. Keep the chosen model in memory for the session.
- Pick the minimum VS Code version from the stable APIs actually used, then verify the declared minimum. A working test on the installed version alone does not prove minimum-version compatibility.
- Keep the proposed shortcuts provisional until host validation; do not claim Windows/Linux keyboard validation from macOS.
- The API reference allows first-use consent inside `sendRequest`. For requests already authorized, start the 10-second deadline when calling it. For a first request without established access, await its response handle before starting the stream deadline; cancellation remains available throughout. This first-use branch cannot promise a 10-second bound on the combined consent/request wait. Report it separately instead of counting consent as a generation timeout. See the [LanguageModelChat API](https://code.visualstudio.com/api/references/vscode-api#LanguageModelChat).
- Preserve the existing 80-line/8,000-character input limits, 5-line adjacent context limits, output limits, cancellation policy, cache bounds, and timeouts.
- Performance goals and real-model quality remain measurements to perform, not properties implied by passing tests.
- English is the documentation and source-comment language. Generated subtitle language follows the editor locale or explicit user setting.

## Approved implementation scope

The user approved the existing command interface (`show`, `dismiss`, `clearCache`), one-line subtitle MVP, and the priority behaviors above. Implementation is delegated by the roles above. Rendering acceptance remains a gate for shipping the experience. License selection does not block local development; do not add a license or publish without a separate decision.
