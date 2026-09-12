const { spawnSync } = require("node:child_process");
const path = require("node:path");

const name = process.argv[2];
if (!name || !/^[a-z-]+$/.test(name)) {
  console.error("Usage: node scripts/test-slice.cjs <test-name>");
  process.exit(1);
}
const root = path.resolve(__dirname, "..");
const output = path.join(root, ".test-host/unit", name);
const compile = spawnSync(
  process.execPath,
  [
    path.join(root, "node_modules/typescript/bin/tsc"),
    "--ignoreConfig",
    "--target",
    "ES2022",
    "--module",
    "Node16",
    "--moduleResolution",
    "Node16",
    "--lib",
    "ES2022,ES2022.Intl,DOM",
    "--types",
    "node,vscode",
    "--strict",
    "--noUncheckedIndexedAccess",
    "--esModuleInterop",
    "--skipLibCheck",
    "--noCheck",
    "--rootDir",
    root,
    "--outDir",
    output,
    path.join(root, "test", name + ".test.ts"),
  ],
  { stdio: "inherit", cwd: root },
);
if (compile.status !== 0) process.exit(compile.status ?? 1);
const test = spawnSync(process.execPath, ["--test", path.join(output, "test", name + ".test.js")], {
  stdio: "inherit",
});
process.exit(test.status ?? 1);
