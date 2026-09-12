const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const executable =
  process.env.VSCODE_EXECUTABLE || "/Applications/Visual Studio Code.app/Contents/MacOS/Code";
// VS Code's IPC socket lives under the user data dir and macOS limits Unix socket
// paths to 103 characters, so deep checkouts can relocate the profile directories.
const hostRoot = process.env.CODE_SUBTITLE_HOST_ROOT
  ? path.resolve(process.env.CODE_SUBTITLE_HOST_ROOT)
  : root;

const semanticHost = process.env.CODE_SUBTITLE_SEMANTIC_HOST || "builtin";
if (semanticHost !== "builtin" && semanticHost !== "native") {
  console.error(
    `CODE_SUBTITLE_SEMANTIC_HOST must be builtin or native (received ${JSON.stringify(semanticHost)}).`,
  );
  process.exitCode = 2;
} else {
  const testHostRoot =
    process.env.CODE_SUBTITLE_TEST_HOST_ROOT || path.join(hostRoot, ".test-host");
  const workspaceRoot = path.join(testHostRoot, "workspace");
  const userDataDir = path.join(testHostRoot, `user-data-${semanticHost}`);
  const extensionsDir = path.join(testHostRoot, `extensions-${semanticHost}`);
  fs.mkdirSync(workspaceRoot, { recursive: true });
  const userSettingsDir = path.join(userDataDir, "User");
  fs.mkdirSync(userSettingsDir, { recursive: true });
  fs.writeFileSync(
    path.join(userSettingsDir, "settings.json"),
    `${JSON.stringify(
      {
        "js/ts.experimental.useTsgo": semanticHost === "native",
        "diffEditor.renderSideBySide": process.env.CODE_SUBTITLE_DIFF_MODE !== "inline",
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  fs.mkdirSync(extensionsDir, { recursive: true });

  if (semanticHost === "native") {
    const nativeExtension = findNativeExtension();
    if (!nativeExtension) {
      console.error(
        "TypeScript 7 native-preview is unavailable: no public install was found under ~/.vscode/extensions.",
      );
      process.exitCode = 2;
    } else {
      const destination = path.join(extensionsDir, path.basename(nativeExtension));
      fs.cpSync(nativeExtension, destination, { recursive: true, force: true });
      runHost({ extensionsDir, userDataDir, workspaceRoot });
    }
  } else {
    runHost({ extensionsDir, userDataDir, workspaceRoot });
  }
}

function findNativeExtension() {
  const installedExtensionsRoot = path.join(os.homedir(), ".vscode", "extensions");
  if (!fs.existsSync(installedExtensionsRoot)) {
    return undefined;
  }

  const candidates = fs
    .readdirSync(installedExtensionsRoot, { withFileTypes: true })
    .filter(
      (entry) => entry.isDirectory() && entry.name.startsWith("typescriptteam.native-preview-"),
    )
    .map((entry) => path.join(installedExtensionsRoot, entry.name))
    .sort()
    .reverse();
  for (const candidate of candidates) {
    try {
      const packageJson = JSON.parse(fs.readFileSync(path.join(candidate, "package.json"), "utf8"));
      if (
        packageJson?.name === "native-preview" &&
        String(packageJson.publisher).toLowerCase() === "typescriptteam"
      ) {
        return candidate;
      }
    } catch {
      // Ignore an incomplete extension directory and inspect the next public install.
    }
  }
  return undefined;
}

function runHost({ extensionsDir, userDataDir, workspaceRoot }) {
  const env = { ...process.env, CODE_SUBTITLE_SEMANTIC_HOST: semanticHost };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(
    executable,
    [
      "--extensionDevelopmentPath=" + root,
      "--extensionTestsPath=" + path.join(root, "dist/test/host/index.js"),
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
}
