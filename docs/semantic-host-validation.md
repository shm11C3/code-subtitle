# Semantic host validation

Observed on 2026-09-12: both built-in and native modes passed on macOS arm64, VS Code 1.135.0. Native mode used `TypeScriptTeam.native-preview` 0.20260708.2 with `js/ts.experimental.useTsgo` enabled in the isolated profile. Both modes passed the production collector checks for same-file and imported cross-file definitions, including non-mutation assertions. No model request was made.

The extension-host smoke uses VS Code's public provider commands against a local synthetic TypeScript file. It does not invoke a language model or the subtitle command. The fixture checks that Hover returns typed text, Definition resolves to the local function declaration, and Type Definition resolves to the local interface. It also checks that provider queries preserve source text, document version, dirty state, and selection.

Run the built-in TypeScript host with:

```sh
npm run test:host
```

The runner defaults to `CODE_SUBTITLE_SEMANTIC_HOST=builtin`. To exercise the TypeScript 7 native-preview extension when it is installed in the public VS Code extensions directory, run:

```sh
CODE_SUBTITLE_SEMANTIC_HOST=native npm run test:host
```

The runner opens `.test-host/workspace`, uses mode-specific `.test-host/user-data-*` and `.test-host/extensions-*` directories, and does not use the normal VS Code profile. It writes only the selected mode's `User/settings.json`, setting `js/ts.experimental.useTsgo` to `false` for `builtin` and `true` for `native`, and disables the workspace-trust prompt for that isolated session. In native mode it reads only matching `typescriptteam.native-preview-*` directories and copies the selected extension into the isolated extensions directory. It does not download or install packages. If the public native-preview extension is unavailable, the command exits before launching VS Code with an explicit unavailable message.

The semantic smoke reports the selected mode in its passing line. It first warms the public provider commands, then runs `VscodeSemanticContextProvider` against the same file and a cross-file import. It checks typed hover evidence, a same-file definition excerpt containing `return { id }`, and a cross-file helper excerpt containing `return value.trim().toLowerCase()` together with the helper's dependency URI and version. A successful built-in run establishes provider API behavior through the standard TypeScript extension. A successful native run establishes the same provider behavior while the active TypeScript 7 extension exposes its language-server API and has selected `tsgo` in the isolated profile. Provider results alone do not establish semantic translation quality or model output quality; evaluate those separately with the documented model acceptance cases.
