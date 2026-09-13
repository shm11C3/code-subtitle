# Marketplace releases

Issue [#1](https://github.com/shm11C3/code-subtitle/issues/1) prepares the first public release. The source is MIT licensed. The publisher is `Shm11C3`, matching [md-hinagata's manifest](https://github.com/shm11C3/md-hinagata/blob/main/apps/vscode-extension/package.json); the extension ID is `Shm11C3.code-subtitle`.

## Release policy

This repository follows the tag/manual publishing flow in [md-hinagata's workflow](https://github.com/shm11C3/md-hinagata/blob/main/.github/workflows/publish-vscode-extension.yml), with an independent versioning policy:

- Publish on a `v*.*.*` tag push or an explicit workflow dispatch.
- Use numeric `X.Y.Z` product release numbers without suffixes. A tag must be exactly `v` plus the manifest version. This project does not claim strict Semantic Versioning compliance.
- Reserve `0.0.x` for local development. The first Marketplace version is `0.1.0`.
- Explicitly set `releaseChannel` in `package.json` to `pre-release` or `stable`. This repository-specific field controls local packaging and CI publication; missing or invalid values are rejected. No part of the version number selects the channel.
- Maintain one active release stream for now: start with pre-releases, then move to the stable channel when ready. Do not maintain simultaneous stable and pre-release lines without revisiting the policy.
- Keep `preview: true` for the first release. The preview label and Marketplace pre-release channel are separate concepts.
- Keep `private: true` to prevent accidental npm publication; it does not prevent VSIX distribution.

`scripts/release.cjs` supplies the version, channel, and VSIX name for both local packaging and CI. The workflow checks types, lint, formatting, and tests, then publishes that same packaged VSIX. It does not rebuild during publishing, create GitHub Releases, generate changelogs, or bump versions automatically. The reference repository's monorepo builds and PR-label automation are not needed here.

### Choosing a version and channel

Use `X` for major changes to how the product is used, `Y` for feature additions or substantial improvements, and `Z` for fixes. Reset the lower components when increasing a higher component. During initial `0.x` development, use `Y` for substantial changes and document their impact. Decide readiness for `1.0.0` separately from entry into the stable Marketplace channel.

For example:

| Version | `releaseChannel` | Purpose                      |
| ------- | ---------------- | ---------------------------- |
| `0.1.0` | `pre-release`    | First public preview         |
| `0.1.1` | `pre-release`    | Preview fixes                |
| `0.2.0` | `stable`         | First stable-channel release |
| `0.2.1` | `stable`         | Fixes                        |
| `0.3.0` | `stable`         | Feature additions            |

These are examples, not a fixed schedule. The initial manifest uses `"releaseChannel": "pre-release"`. To switch channels, change that field and increment the version in the same reviewed release change. Keep the setting in the tagged commit so local packaging, tag-triggered publication, and manual dispatch all use the same channel.

Marketplace [does not support SemVer pre-release suffixes](https://code.visualstudio.com/api/working-with-extensions/publishing-extension#pre-release-extensions), and the same version cannot be reused between channels. Give every publication in this single stream a higher numeric version than the previous publication, including when changing channels. Pre-release users can receive a higher stable version; this transition is intentional for this policy.

Treat compatibility separately from numbering: preserve existing setting keys, values, and command IDs where practical; provide migration or deprecation guidance when changing them. Record changes that require user action in the release notes. A larger version number alone does not make an automatic update safe. VS Code host compatibility remains declared through `engines.vscode`.

## Prepare a release

1. Complete the first-release checklist below, and record product acceptance in [validation](validation.md).
2. Set the version in both `package.json` and `package-lock.json`, for example with `npm version 0.1.1 --no-git-tag-version`.
   Explicitly review `package.json`'s `releaseChannel`; change it to `stable` when moving out of the pre-release stream. The `preview` label is a separate product presentation decision.
3. Run `node scripts/release.cjs validate`, `npm run check`, `npm run lint`, `npm run fmt:check`, `npm test`, and `npm run package`.
4. Inspect and install the generated `code-subtitle-<version>.vsix`. Run the extension-host smoke test with the public extension ID. Preserve the documented limitations.
5. Review and merge the release changes before creating and pushing the matching tag. A tag push publishes to Marketplace.

For the first release, after the changes are merged and release acceptance is complete:

```sh
git switch main
git pull --ff-only
git tag -a v0.1.0 -m "Code Subtitle 0.1.0 pre-release"
git push origin v0.1.0
```

To retry a failed workflow, use the same tag/ref and verify Marketplace state first. If publishing succeeded, do not reuse that version; fix forward with a new patch version. A manual dispatch on a branch publishes its manifest version immediately after checks, so prefer dispatching the intended release tag.

## Publisher credential

Configure the `VSCE_PAT` repository secret with a credential authorized to publish as `Shm11C3`, as in the reference workflow. The token is exposed only to the publish step. No secret is needed to package or test locally.

The [official publishing guide](https://code.visualstudio.com/api/working-with-extensions/publishing-extension) currently recommends Entra ID federation and states that global Azure DevOps PATs retire on December 1, 2026. The initial workflow mirrors the requested reference; migrate authentication before that deadline.

## First-release checklist

- [x] Use the existing `Shm11C3` publisher and declare MIT in the manifest.
- [x] Add repository, issues, homepage, keywords, and dark gallery-banner metadata.
- [x] Remove missing-repository and missing-license packaging bypasses.
- [x] Prepare `0.1.0` on the pre-release channel with `preview: true`.
- [x] Add a tag/manual publish workflow with version and icon validation.
- [x] Add the approved 128 × 128 Marketplace icon at `resources/icon.png`.
- [x] Record and embed the core-flow GIF in the extension README, with a fixed-response disclosure.
- [ ] Finish the relevant manual product acceptance and record results.
- [ ] Configure publisher credentials and perform the first Marketplace release.

The workflow validates the icon format and dimensions before publication. The approved icon is now included; the remaining checklist items still require completion before the first release. This preparation does not claim that the extension is already published.

## Demo recording

Run `npm run demo` to open a dedicated profile with the production extension and a test-only provider. If the default profile path is too long on macOS, use `CODE_SUBTITLE_DEMO_ROOT=/private/tmp/cs-demo npm run demo`. The launcher only writes its own demo profile/workspace. `.demo-host`, `test`, and `scripts` are excluded from the VSIX.

Select the request-ID guard in `request-guard.ts`, press `Ctrl+Alt+E` on macOS (`Shift+Alt+E` on Windows/Linux), wait for the subtitle, then press `Esc`. Capture approximately 8–12 seconds, keeping the fixed-response disclosure visible. The response and streaming delay are scripted to illustrate interaction, not live-model quality or latency. Caption the GIF accordingly when embedding it.

The [recorded demo](media/code-subtitle-demo.gif) shows selection, **Show Subtitle** from the Command Palette, streamed output, and `Esc` dismissal. It is a 1000 × 370 looping GIF assembled from real window captures, with pauses adjusted for readability. The fixed-response disclosure remains visible in the editor.

For native capture tools that cannot target a separate VS Code process, open an empty named profile in the existing process instead:

```sh
code --profile "Code Subtitle Recording" --new-window --disable-extensions \
  --extensionDevelopmentPath="$PWD" \
  --extensionDevelopmentPath="$PWD/test/demo/provider" \
  /private/tmp/cs-demo/workspace /private/tmp/cs-demo/workspace/request-guard.ts
```

First create the sample workspace using the demo launcher with `CODE_SUBTITLE_DEMO_ROOT=/private/tmp/cs-demo`. In the named profile's User Settings JSON, copy the settings generated at `/private/tmp/cs-demo/user-data/User/settings.json`. This profile needs `codeSubtitle.model` set to `code-subtitle-demo:fixed-response`, `codeSubtitle.outputLanguage` to `en`, and `codeSubtitle.semanticContext` to `false`. The test-only provider supports Restricted Mode and makes no network requests. The successful capture used the Command Palette because native automation did not reliably deliver `Ctrl+Alt+E`; the GIF does not establish that shortcut's behavior.

The Marketplace README loads the GIF from this repository's `main` branch. Merge the asset before publishing so the image URL resolves publicly; the GIF is excluded from the VSIX along with the other developer documentation.

## Claims retained for the preview

Keep the extension README's caveats about clipped long lines/narrow editors, visual readability, screen readers, live-model quality, performance, and excluded environments. A fixed-response recording demonstrates interaction only; it does not establish these acceptance criteria or support subsecond speed claims. A Marketplace preview label is not a substitute for those caveats.
