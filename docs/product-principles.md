# Product Principles

Code Subtitle optimizes the time until a user understands the meaning of code and can continue reading. Treat neither the amount of explanation nor the number of features as a substitute for an outcome.

## 1. Keep code reading moving

Make explanations available near the code where a question arises. Do not make the user move to another screen for a subtitle, and do not take the cursor or focus. Start only after an explicit action; simply reading must not start a request or display.

When the selection changes, stop the old work. An explanation that arrives after the user has moved on is an unnecessary display even if its content is correct.

## 2. Make meaning clear at a glance instead of explaining at length

As a rule, provide the understanding needed to read the next line in one sentence. Do not generate greetings, introductions, bullet-point lessons, or restatements of the same content. Stream instead of waiting for the full response.

Do not drop negation or conditions to meet a character count. If an explanation cannot be both short and accurate, ask the user to narrow the selection. Do not expand the MVP by sending long explanations to another panel.

## 3. Never rewrite the original text or code

A subtitle is a display aid, not an appended comment or a replacement translation. Do not change file content, saved state, or Undo history. Do not provide Tab-based insertion like code completion.

Protect this boundary through both API selection and testing on a real editor so that dismissing a display never becomes an edit operation.

## 4. Surface an engineering insight

Write for experienced engineers reading OSS or reviewing code. Assume familiarity with syntax and common programming constructs. Choose one useful insight: the code's responsibility, an invariant it enforces, a failure boundary, or a concrete tradeoff. Connect a visible mechanism to its consequence for callers, state, or data so the reader can reason about changes.

An assumption, limitation, or review check belongs in a subtitle only when it follows from the supplied code and materially affects that insight. Do not force a defect or recommendation into every result. Distinguish effects confirmed by the code from inferences; do not invent an unseen helper's behavior, project architecture, or the author's intent. When evidence is insufficient, state the observable responsibility or the specific missing context. For comment translation, do not add analysis; stay faithful to the original meaning.

Evaluate usefulness separately from format compliance with the examples in [Output quality](output-quality.md). A sentence that merely narrates operations can pass the display validator and still fail the product goal.

## 5. Feel natural for developers who read languages other than English

Use VS Code's display language as the default output language and let users override it. Do not replace identifiers, API names, or necessary technical terms with forced translations that make their meaning ambiguous.

Do not use Japanese character count as the readability standard for every language. Validate length, mixed-script display, and input operations for writing systems such as English, CJK, and right-to-left languages, and do not claim quality for untested languages.

## 6. Favor speed and low friction over additional features

Prioritize the time until useful meaning first appears. Invest in short inputs, short outputs, lightweight rendering, caching, and cancellation of unnecessary requests.

Reduce settings through reasonable defaults. Do not make users repeatedly choose a model or prompt during everyday use. Do not hide consent for model use or an explanation of where data is sent in order to make the product look “configuration-free.”

Model speed alone cannot prove an advantage. Check actual operation count, eye movement, reading time, and the rate of misunderstanding.

## 7. Keep subtitles present only as long as needed

Treat an ephemeral subtitle as the default; do not turn it into a permanent annotation, history, or pinned display. Show only one at a time and clear it on selection change or expiry. Avoid animations that compete with the code and UI that adds work to dismiss it.

The memory cache is internal processing that reduces wait time when rereading; it is not a user-facing explanation history.

## 8. Use small inputs and explicit privacy assumptions

Send only the explicitly selected range and limited context to the model through VS Code. Do not conveniently add the entire file, related files, or history. Treat instructions inside comments as data to be explained.

Not requiring a custom API key does not remove external transmission or the model provider's data processing. Explain the transmission range, memory retention, and logging policy the extension controls, and do not make extension-specific guarantees about the provider's storage or training policy.

## When principles conflict

Protect the original text, meaning accuracy, and transmission range first; within those limits, optimize continuity, speed, and brevity. Do not accept mistranslation for the sake of brevity or a content-free display intended to make TTFE look better.

Evaluate a feature proposal with these questions:

- Does it shorten the time until the user returns to the code?
- Does it only increase operations, reading volume, display occupancy, configuration, or network use?
- Can it be completed within the temporary-subtitle experience?
- Can the same problem be solved by improving defaults, prompts, or performance?

Do not add Chat, a detailed panel, persistent history, or proactive generation to the MVP. Treat future requests as evidence to evaluate, not an automatic roadmap; use observed reading problems and improvement effects as the basis for decisions.

See [MVP product overview](mvp-product-overview.md) for concrete scope and [Minimal design](minimal-design.md) for implementation choices.
