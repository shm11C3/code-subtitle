import assert from "node:assert/strict";
import * as vscode from "vscode";
import { VscodeSubtitleView } from "../../src/vscode-view.js";
import type { SubtitleInput } from "../../src/contracts.js";
import { runSemanticSmoke } from "./semantic.js";

const wait = (delayMs: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, delayMs));

/** Exercises the production renderer without accessing any language model. */
export async function run(): Promise<void> {
  const document = await vscode.workspace.openTextDocument({
    language: "typescript",
    content:
      '// Synthetic rendering fixture; no model request is made.\nawait mutex.runExclusive(async () => {\n  await update();\n});\n\n// A long code line deliberately leaves little room for a subtitle.\nconst result = items.filter(item => item.enabled && item.status === "ready").map(item => item.identifier).join(", ");\n',
  });
  const editor = await vscode.window.showTextDocument(document);
  editor.selection = new vscode.Selection(1, 0, 3, 3);
  const input: SubtitleInput = {
    documentUri: document.uri.toString(),
    documentVersion: document.version,
    editorId: "rendering-fixture",
    range: { start: { line: 1, character: 0 }, end: { line: 3, character: 3 } },
    anchorLine: 3,
    languageId: "typescript",
    outputLanguage: "ja",
    selection: document.getText(editor.selection),
    before: "",
    after: "",
  };
  const before = {
    text: document.getText(),
    version: document.version,
    dirty: document.isDirty,
    selection: editor.selection,
  };
  const view = new VscodeSubtitleView(() => editor);
  view.show(input, "", "preparing");
  view.show(input, "同時更新による競合を防ぐため、", "streaming");
  view.show(input, "同時更新による競合を防ぐため、更新処理を一度に一つだけ実行する。", "visible");
  assert.equal(document.getText(), before.text);
  assert.equal(document.version, before.version);
  assert.equal(document.isDirty, before.dirty);
  assert.deepEqual(editor.selection, before.selection);
  assert.equal(vscode.window.activeTextEditor, editor);
  if (process.env.CODE_SUBTITLE_VISUAL_CHECK === "1") {
    await vscode.window.showInformationMessage(
      "Synthetic subtitle: inspect normal editor readability.",
      "Next",
    );
    editor.selection = new vscode.Selection(6, 0, 6, document.lineAt(6).text.length);
    view.show(
      { ...input, anchorLine: 6 },
      "必要な項目の識別子を取り出し、カンマ区切りの文字列にまとめる。",
      "visible",
    );
    await vscode.window.showInformationMessage(
      "Synthetic subtitle: inspect the long line without horizontal scrolling.",
      "Next",
    );
    await vscode.commands.executeCommand("workbench.action.splitEditorRight");
    await vscode.window.showInformationMessage(
      "Synthetic subtitle: inspect narrow split editor readability.",
      "Finish",
    );
  }
  view.clear();
  view.dispose();
  assert.equal(document.getText(), before.text);
  assert.equal(document.version, before.version);
  console.log("Code Subtitle renderer smoke: passed (no model requests).");
  const extension = vscode.extensions.getExtension("Shm11C3.code-subtitle");
  assert.ok(extension, "The development extension is registered.");
  await extension.activate();
  const commands = await vscode.commands.getCommands(true);
  for (const command of [
    "codeSubtitle.show",
    "codeSubtitle.dismiss",
    "codeSubtitle.clearCache",
    "codeSubtitle.chooseModel",
  ]) {
    assert.ok(commands.includes(command), `${command} is registered.`);
  }
  await vscode.commands.executeCommand("codeSubtitle.dismiss");
  await vscode.commands.executeCommand("codeSubtitle.clearCache");
  assert.equal(document.getText(), before.text);
  assert.equal(document.version, before.version);
  assert.equal(document.isDirty, before.dirty);
  console.log("Code Subtitle activation and command smoke: passed.");
  await runProviderSmoke();
  await runDiffSmoke();
  await runSemanticSmoke();
}

async function runProviderSmoke(): Promise<void> {
  const models = await vscode.lm.selectChatModels({ vendor: "code-subtitle-test" });
  assert.equal(models.length, 1, "The isolated host loaded the non-Copilot test provider.");
  assert.equal(models[0]?.vendor, "code-subtitle-test");
  assert.equal(models[0]?.id, "test-model");

  const document = await vscode.workspace.openTextDocument({
    language: "typescript",
    content: "return value;\n",
  });
  const editor = await vscode.window.showTextDocument(document);
  editor.selection = new vscode.Selection(0, 0, 0, document.lineAt(0).text.length);
  const before = {
    text: document.getText(),
    version: document.version,
    dirty: document.isDirty,
    selection: editor.selection,
  };

  await vscode.commands.executeCommand("codeSubtitle.show");

  assert.equal(document.getText(), before.text);
  assert.equal(document.version, before.version);
  assert.equal(document.isDirty, before.dirty);
  assert.deepEqual(editor.selection, before.selection);
  await vscode.commands.executeCommand("codeSubtitle.dismiss");
  console.log("Code Subtitle non-Copilot provider smoke: passed (vendor:id, no source mutation).");
}

async function runDiffSmoke(): Promise<void> {
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  assert.ok(workspaceFolder, "The diff smoke test has a workspace folder.");

  const leftUri = vscode.Uri.joinPath(workspaceFolder.uri, "diff-before.ts");
  const rightUri = vscode.Uri.joinPath(workspaceFolder.uri, "diff-after.ts");
  await vscode.workspace.fs.writeFile(
    leftUri,
    new TextEncoder().encode("export function explain(value: string) {\n  return value;\n}\n"),
  );
  await vscode.workspace.fs.writeFile(
    rightUri,
    new TextEncoder().encode(
      "export function explain(value: string) {\n  return value.trim();\n}\n",
    ),
  );

  await vscode.commands.executeCommand(
    "vscode.diff",
    leftUri,
    rightUri,
    "Code Subtitle diff smoke",
    { preview: false },
  );
  await wait(500);

  const editor = vscode.window.activeTextEditor;
  assert.ok(editor, "The diff editor exposes an active text editor.");
  assert.equal(editor.document.uri.toString(), rightUri.toString());
  const line = 1;
  editor.selection = new vscode.Selection(line, 0, line, editor.document.lineAt(line).text.length);
  const before = {
    text: editor.document.getText(),
    version: editor.document.version,
    dirty: editor.document.isDirty,
    selection: editor.selection,
  };
  const input: SubtitleInput = {
    documentUri: editor.document.uri.toString(),
    documentVersion: editor.document.version,
    editorId: "diff-rendering-fixture",
    range: {
      start: { line, character: 0 },
      end: { line, character: editor.document.lineAt(line).text.length },
    },
    anchorLine: line,
    languageId: editor.document.languageId,
    outputLanguage: "en",
    selection: editor.document.lineAt(line).text,
    before: "",
    after: "",
  };
  const view = new VscodeSubtitleView(() => editor);
  view.show(
    input,
    "The change trims surrounding whitespace before returning the value.",
    "visible",
  );

  assert.equal(editor.document.getText(), before.text);
  assert.equal(editor.document.version, before.version);
  assert.equal(editor.document.isDirty, before.dirty);
  assert.deepEqual(editor.selection, before.selection);

  if (process.env.CODE_SUBTITLE_VISUAL_CHECK === "1") {
    await vscode.window.showInformationMessage(
      `Diff editor (${process.env.CODE_SUBTITLE_DIFF_MODE === "inline" ? "inline" : "side-by-side"}): inspect the subtitle on the changed line in light theme.`,
      "Next",
    );
  }
  view.clear();
  view.dispose();
  console.log(
    `Code Subtitle diff smoke: passed (${process.env.CODE_SUBTITLE_DIFF_MODE === "inline" ? "inline" : "side-by-side"}).`,
  );
}
