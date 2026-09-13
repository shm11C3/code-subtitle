const assert = require("node:assert/strict");
const { test } = require("node:test");
const { releaseInfo } = require("../scripts/release.cjs");

test("odd minors produce Marketplace pre-release packages", () => {
  assert.deepEqual(releaseInfo("0.1.0", "v0.1.0"), {
    version: "0.1.0",
    channel: "pre-release",
    packagePath: "code-subtitle-0.1.0.vsix",
  });
  assert.equal(releaseInfo("1.3.2").channel, "pre-release");
});

test("even minors produce stable packages, including minor zero after 1.0", () => {
  assert.equal(releaseInfo("0.2.0").channel, "stable");
  assert.equal(releaseInfo("1.0.0").channel, "stable");
});

test("local-only, suffixed and malformed versions cannot be released", () => {
  for (const version of ["0.0.1", "0.1.0-beta.1", "v0.1.0", "0.01.0", "0.1", "0.1.0\n"]) {
    assert.throws(() => releaseInfo(version), /local-only|major.minor.patch/);
  }
});

test("tags must exactly match the manifest version", () => {
  for (const tag of ["v0.1.1", "0.1.0", "v0.1.0-beta.1", ""]) {
    assert.throws(() => releaseInfo("0.1.0", tag), /does not match/);
  }
});
