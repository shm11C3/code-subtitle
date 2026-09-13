const assert = require("node:assert/strict");
const { test } = require("node:test");
const { releaseInfo } = require("../scripts/release.cjs");

test("an explicit pre-release channel applies to odd and even minors", () => {
  assert.deepEqual(releaseInfo("0.1.0", "pre-release", "v0.1.0"), {
    version: "0.1.0",
    channel: "pre-release",
    packagePath: "code-subtitle-0.1.0.vsix",
  });
  assert.equal(releaseInfo("0.2.0", "pre-release").channel, "pre-release");
});

test("an explicit stable channel applies regardless of the version's maturity or parity", () => {
  for (const version of ["0.2.0", "0.3.0", "1.0.0"]) {
    assert.equal(releaseInfo(version, "stable").channel, "stable");
  }
});

test("missing or invalid channels cannot silently publish a stable release", () => {
  for (const channel of [undefined, null, "", "preview", "Stable", true]) {
    assert.throws(() => releaseInfo("0.1.0", channel), /releaseChannel/);
  }
});

test("local-only, suffixed and malformed versions cannot be released", () => {
  for (const version of ["0.0.1", "0.1.0-beta.1", "v0.1.0", "0.01.0", "0.1", "0.1.0\n"]) {
    assert.throws(() => releaseInfo(version, "pre-release"), /local-only|major.minor.patch/);
  }
});

test("tags must exactly match the manifest version", () => {
  for (const tag of ["v0.1.1", "0.1.0", "v0.1.0-beta.1", ""]) {
    assert.throws(() => releaseInfo("0.1.0", "pre-release", tag), /does not match/);
  }
});
