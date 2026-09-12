const { spawn } = require("node:child_process");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const executable =
  process.env.VSCODE_EXECUTABLE || "/Applications/Visual Studio Code.app/Contents/MacOS/Code";
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(
  executable,
  [
    "--extensionDevelopmentPath=" + root,
    "--extensionTestsPath=" + path.join(root, "dist/test/host/index.js"),
    "--user-data-dir=" + path.join(root, ".test-host/user-data"),
    "--extensions-dir=" + path.join(root, ".test-host/extensions"),
    "--skip-welcome",
    "--skip-release-notes",
    "--disable-extensions",
    "--new-window",
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
