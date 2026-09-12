# Code Subtitle — Local Preview

Select code or a short comment and run **Code Subtitle: Show Subtitle** to display a temporary, streamed explanation beside the selection.

Subtitles are aimed at experienced engineers reading OSS or reviewing code. They connect a visible mechanism to one useful responsibility, invariant, failure boundary, or tradeoff. For example, a request-ID guard can explain why a late response cannot overwrite the current view. The model is instructed to avoid syntax narration and unsupported design intent; comments alone receive a faithful short translation.

Use `Alt+E` on Windows/Linux or `Ctrl+Alt+E` on macOS. Use **Dismiss Subtitle** or `Esc` to clear it. Selection changes, edits, editor switches, and the display deadline also clear the subtitle. **Clear Cache** clears the in-memory results and cancels active generation.

When a request cannot complete for a reason you can fix in the editor (selection too large, unusable or overlong output, timeout, or a failed request), a short hint appears in the subtitle slot and disappears after a few seconds. Problems that need attention elsewhere, such as no available model or denied access, are shown as notifications.

To change the shortcut, open **Preferences: Open Keyboard Shortcuts** from the Command Palette. On macOS, you can also press `Cmd+K`, then `Cmd+S`. Search for `Code Subtitle: Show Subtitle`, select its pencil icon, press your preferred key combination, and press Enter. VS Code saves the override in your user keyboard settings. The same screen lets you change, remove, or reset the binding and inspect conflicts with other commands.

The extension uses a GitHub Copilot model available in VS Code. It has no API-key setting or separate backend. On first use, choose a model and complete VS Code's consent flow if prompted. Sign-in, model access, and available quota may be required.

Only explicit commands send the selected text and up to five adjacent lines on each side. Optional semantic context also includes bounded language-service type information, documentation, and one-hop definition excerpts from the same workspace folder. It queries at most three selected identifiers, waits at most 600 ms, and includes up to 4,000 UTF-16 code units of extra evidence. Missing or slow providers fall back to the selection and adjacent lines. Untitled files and untrusted workspaces use that basic path as well.

Disable `codeSubtitle.semanticContext` in user settings to omit semantic evidence. Code Subtitle uses VS Code's standard provider APIs, including services supplied by TypeScript 7 (tsgo); the appropriate language extension must be active. No separate language server is launched.

Code Subtitle does not modify source files, persist code or responses, or send telemetry. Model-provider data handling is governed by that provider and your organization. See the [VS Code Language Model API guide](https://code.visualstudio.com/api/extension-guides/ai/language-model).

Output language follows VS Code's display language. Override it with `codeSubtitle.outputLanguage`; select a Copilot model ID with `codeSubtitle.model` if needed. Both are user-level settings.

This preview requires desktop VS Code 1.135 or newer. Long lines and narrow editors can clip line-end decorations. Display readability, screen-reader behavior, live-model quality, and performance still require manual acceptance. Notebook, browser, and Remote environments are outside initial validation.

This is a locally packaged development preview with a placeholder publisher. It has not been published to a marketplace, and an OSS license has not yet been selected.
