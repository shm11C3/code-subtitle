const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

// Launches the live evaluation harness (dist/test/eval/index.js) in a desktop
// VS Code window with a dedicated, persistent profile under .eval-host. Unlike
// the renderer smoke test, extensions stay enabled so that GitHub Copilot can
// provide a model; install and sign in to Copilot in that profile once.
const root = path.resolve(__dirname, "..");
const executable =
  process.env.VSCODE_EXECUTABLE || "/Applications/Visual Studio Code.app/Contents/MacOS/Code";
// VS Code's IPC socket lives under the user data dir and macOS limits Unix socket
// paths to 103 characters, so deep checkouts can relocate the profile directories.
const hostRoot = process.env.CODE_SUBTITLE_HOST_ROOT
  ? path.resolve(process.env.CODE_SUBTITLE_HOST_ROOT)
  : root;

const evalRoot = path.join(hostRoot, ".eval-host");
const workspaceRoot = path.join(evalRoot, "workspace");
const userDataDir = path.join(evalRoot, "user-data");
const extensionsDir = path.join(evalRoot, "extensions");
const resultsDir = path.join(evalRoot, "results");
for (const directory of [workspaceRoot, userDataDir, extensionsDir, resultsDir]) {
  fs.mkdirSync(directory, { recursive: true });
}

console.log(`Code Subtitle live evaluation profile: ${evalRoot}`);
console.log(
  "Install GitHub Copilot Chat in this window's Extensions view and sign in once; results are written to .eval-host/results.",
);

const env = { ...process.env, CODE_SUBTITLE_EVAL_RESULTS_DIR: resultsDir };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(
  executable,
  [
    "--extensionDevelopmentPath=" + root,
    "--extensionTestsPath=" + path.join(root, "dist/test/eval/index.js"),
    "--user-data-dir=" + userDataDir,
    "--extensions-dir=" + extensionsDir,
    "--skip-welcome",
    "--skip-release-notes",
    "--disable-telemetry",
    "--disable-workspace-trust",
    "--new-window",
    workspaceRoot,
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
