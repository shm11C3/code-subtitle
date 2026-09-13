const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

function releaseInfo(version, channel, tag) {
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) {
    throw new Error("Release versions must be major.minor.patch without a suffix.");
  }
  const [major, minor] = version.split(".").map(BigInt);
  if (major === 0n && minor === 0n) {
    throw new Error("0.0.x is local-only; use 0.1.0 or later for publication.");
  }
  if (channel !== "pre-release" && channel !== "stable") {
    throw new Error('package.json releaseChannel must be "pre-release" or "stable".');
  }
  if (tag !== undefined && tag !== `v${version}`) {
    throw new Error(`Tag ${tag} does not match package.json version ${version}.`);
  }
  return {
    version,
    channel,
    packagePath: `code-subtitle-${version}.vsix`,
  };
}

if (require.main === module) {
  try {
    const root = path.resolve(__dirname, "..");
    const manifest = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
    const tag = process.env.GITHUB_REF_TYPE === "tag" ? process.env.GITHUB_REF_NAME : undefined;
    const info = releaseInfo(manifest.version, manifest.releaseChannel, tag);
    if (process.argv[2] === "validate") {
      for (const field of [
        "publisher",
        "license",
        "repository",
        "bugs",
        "homepage",
        "icon",
        "keywords",
        "galleryBanner",
      ]) {
        if (!manifest[field]) throw new Error(`Missing Marketplace metadata: ${field}`);
      }
      const icon = fs.readFileSync(path.join(root, manifest.icon));
      if (
        icon.length < 24 ||
        !icon.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
        icon.readUInt32BE(16) !== 128 ||
        icon.readUInt32BE(20) !== 128
      ) {
        throw new Error("The approved Marketplace icon must be a 128 × 128 PNG.");
      }
    }
    if (process.argv[2] === "package") {
      const args = [
        "package",
        "--readme-path",
        "docs/extension-readme.md",
        "--out",
        info.packagePath,
      ];
      if (info.channel === "pre-release") args.push("--pre-release");
      const result = spawnSync(process.execPath, [require.resolve("@vscode/vsce/vsce"), ...args], {
        cwd: root,
        stdio: "inherit",
      });
      if (result.error) throw result.error;
      process.exitCode = result.status ?? 1;
    } else {
      const output = `version=${info.version}\nchannel=${info.channel}\npackage_path=${info.packagePath}\n`;
      process.stdout.write(output);
      if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, output);
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = { releaseInfo };
