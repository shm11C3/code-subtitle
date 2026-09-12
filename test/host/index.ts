import assert from "node:assert/strict";
import * as vscode from "vscode";
import { VscodeSubtitleView } from "../../src/vscode-view.js";
import type { SubtitleInput } from "../../src/contracts.js";

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
  const extension = vscode.extensions.getExtension("code-subtitle-local.code-subtitle");
  assert.ok(extension, "The development extension is registered.");
  await extension.activate();
  const commands = await vscode.commands.getCommands(true);
  for (const command of ["codeSubtitle.show", "codeSubtitle.dismiss", "codeSubtitle.clearCache"]) {
    assert.ok(commands.includes(command), `${command} is registered.`);
  }
  await vscode.commands.executeCommand("codeSubtitle.dismiss");
  await vscode.commands.executeCommand("codeSubtitle.clearCache");
  assert.equal(document.getText(), before.text);
  assert.equal(document.version, before.version);
  assert.equal(document.isDirty, before.dirty);
  console.log("Code Subtitle activation and command smoke: passed.");
}
