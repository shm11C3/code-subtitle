const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const demoRoot = path.resolve(process.env.CODE_SUBTITLE_DEMO_ROOT || path.join(root, ".demo-host"));
const profile = path.join(demoRoot, "user-data");
const extensions = path.join(demoRoot, "extensions");
const workspace = path.join(demoRoot, "workspace");
fs.mkdirSync(path.join(profile, "User"), { recursive: true });
fs.mkdirSync(workspace, { recursive: true });
fs.cpSync(path.join(root, "test/demo/provider"), path.join(extensions, "demo-provider"), {
  recursive: true,
});
fs.writeFileSync(
  path.join(profile, "User/settings.json"),
  JSON.stringify(
    {
      "codeSubtitle.model": "code-subtitle-demo:fixed-response",
      "codeSubtitle.outputLanguage": "en",
      "codeSubtitle.semanticContext": false,
      "editor.fontSize": 20,
      "editor.minimap.enabled": false,
      "editor.stickyScroll.enabled": false,
      "editor.renderLineHighlight": "none",
      "breadcrumbs.enabled": false,
      "workbench.startupEditor": "none",
      "window.commandCenter": false,
      "extensions.ignoreRecommendations": true,
    },
    null,
    2,
  ) + "\n",
);
const source = `// Code Subtitle | Select code > Show Subtitle > Esc.
// Demo uses a fixed response; timing is illustrative.

let activeId = 0;

async function refresh() {
  const id = ++activeId;
  const value = await load();
  if (id !== activeId) return;
  render(value);
}

declare function load(): Promise<string>;
declare function render(value: string): void;
`;
const file = path.join(workspace, "request-guard.ts");
fs.writeFileSync(file, source);
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(
  process.env.VSCODE_EXECUTABLE || "/Applications/Visual Studio Code.app/Contents/MacOS/Code",
  [
    `--extensionDevelopmentPath=${root}`,
    `--user-data-dir=${profile}`,
    `--extensions-dir=${extensions}`,
    "--skip-welcome",
    "--skip-release-notes",
    "--disable-telemetry",
    "--disable-workspace-trust",
    "--locale=en",
    "--new-window",
    workspace,
    file,
  ],
  { env, stdio: "inherit" },
);
child.on("error", (error) => {
  console.error(error.message);
  process.exitCode = 1;
});
child.on("exit", (code) => {
  process.exitCode = code ?? 1;
});
