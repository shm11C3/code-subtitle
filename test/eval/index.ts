import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as vscode from "vscode";
import { SubtitleError, type ModelIdentity, type SelectionRange } from "../../src/contracts.js";
import {
  createInput,
  fitInput,
  graphemeLength,
  normalizeOutput,
  validateOutput,
} from "../../src/policy.js";
import { VscodeModelGateway } from "../../src/vscode-model.js";
import { VscodeSemanticContextProvider } from "../../src/vscode-semantic.js";
import { EVAL_CASES, fileExtension, type EvalCase } from "./cases.js";

const CASE_TIMEOUT_MS = 60_000;
const EDITOR_ID = "eval-editor";

interface CaseResult {
  readonly id: string;
  readonly title: string;
  readonly outputLanguage: string;
  readonly model?: ModelIdentity;
  readonly text: string;
  readonly graphemes: number;
  readonly valid: boolean;
  readonly firstMs?: number;
  readonly doneMs?: number;
  readonly semanticEntries: number;
  readonly error?: string;
}

/**
 * Runs the seven output-quality cases through the production pipeline against
 * a real Copilot model and records the outputs for a human verdict. No cache is
 * used; nothing but the synthetic cases and the model outputs is written.
 */
export async function run(): Promise<void> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder || folder.uri.scheme !== "file") {
    throw new Error("The evaluation host must open a local workspace folder.");
  }
  const semanticEnabled = process.env.CODE_SUBTITLE_EVAL_SEMANTIC !== "0";
  const modelSetting = process.env.CODE_SUBTITLE_EVAL_MODEL?.trim() || "auto";
  const modelOptions = parseModelOptions(process.env.CODE_SUBTITLE_EVAL_MODEL_OPTIONS);
  const resultsDir =
    process.env.CODE_SUBTITLE_EVAL_RESULTS_DIR ?? join(folder.uri.fsPath, "..", "results");

  const semanticProvider = new VscodeSemanticContextProvider(vscode);
  const gateway = new VscodeModelGateway({
    runtime: {
      selectChatModels: (selector) => vscode.lm.selectChatModels(selector),
      userMessage: (content) => vscode.LanguageModelChatMessage.User(content),
      createCancellationTokenSource: () => new vscode.CancellationTokenSource(),
    },
    // `context.languageModelAccessInformation` is not available to a test entry.
    // `undefined` means "unknown", which is also what production sees on first use.
    access: { canSendRequest: () => undefined },
    picker: {
      showQuickPick: (items, options, token) => vscode.window.showQuickPick(items, options, token),
    },
    fitInput: async (input, countTokens, maxTokens, signal) => {
      const enriched = semanticEnabled
        ? { ...input, semanticContext: await semanticProvider.collect(input, signal) }
        : input;
      return fitInput(enriched, countTokens, maxTokens, signal);
    },
    modelSetting,
    modelOptions,
  });

  const results: CaseResult[] = [];
  for (const evalCase of EVAL_CASES) {
    const result = await runCase(evalCase, folder, gateway);
    if (result.error === "modelUnavailable" || result.error === "accessDenied") {
      throw new Error(unavailableMessage(result.error, modelSetting));
    }
    results.push(result);
    console.log(`eval: ${evalCase.id} ${result.error ?? `${result.doneMs ?? "?"} ms`}`);
  }

  const report = renderReport(results, {
    semanticEnabled,
    modelSetting,
    modelOptions,
  });
  console.log(`\n${report}`);
  mkdirSync(resultsDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/gu, "-");
  const reportPath = join(resultsDir, `${stamp}.md`);
  writeFileSync(reportPath, report, "utf8");
  console.log(`eval: wrote ${reportPath}`);

  if (results.every((result) => result.error !== undefined)) {
    throw new Error("Every evaluation case failed; see the table above for the failure codes.");
  }
}

async function runCase(
  evalCase: EvalCase,
  folder: vscode.WorkspaceFolder,
  gateway: VscodeModelGateway,
): Promise<CaseResult> {
  const fileUri = vscode.Uri.joinPath(
    folder.uri,
    `eval-${evalCase.id}.${fileExtension(evalCase.languageId)}`,
  );
  await vscode.workspace.fs.writeFile(fileUri, Buffer.from(`${evalCase.code}\n`, "utf8"));
  const document = await vscode.workspace.openTextDocument(fileUri);
  const editor = await vscode.window.showTextDocument(document, { preview: false });
  const end = document.positionAt(evalCase.code.length);
  editor.selection = new vscode.Selection(new vscode.Position(0, 0), end);
  const selection: SelectionRange = {
    start: { line: 0, character: 0 },
    end: { line: end.line, character: end.character },
  };
  const base = {
    id: evalCase.id,
    title: evalCase.title,
    outputLanguage: evalCase.outputLanguage,
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CASE_TIMEOUT_MS);
  try {
    const input = createInput({
      text: document.getText(),
      selections: [selection],
      documentUri: document.uri.toString(),
      documentVersion: document.version,
      editorId: EDITOR_ID,
      workspaceId: folder.uri.toString(),
      languageId: evalCase.languageId,
      outputLanguage: evalCase.outputLanguage,
    });
    const prepared = await gateway.prepare(input, controller.signal);
    const fitted = await prepared.fit(controller.signal);
    const semanticEntries = fitted.input.semanticContext?.entries.length ?? 0;

    const startedAt = performance.now();
    const stream = await prepared.stream(controller.signal);
    let raw = "";
    let firstMs: number | undefined;
    for await (const chunk of stream) {
      raw += chunk;
      if (firstMs === undefined && normalizeOutput(raw).length > 0) {
        firstMs = performance.now() - startedAt;
      }
    }
    const doneMs = performance.now() - startedAt;
    const text = normalizeOutput(raw);
    return {
      ...base,
      model: prepared.model,
      text,
      graphemes: graphemeLength(text),
      valid: validateOutput(raw, evalCase.outputLanguage),
      firstMs,
      doneMs,
      semanticEntries,
    };
  } catch (error: unknown) {
    return {
      ...base,
      text: "",
      graphemes: 0,
      valid: false,
      semanticEntries: 0,
      error: failureLabel(error, controller.signal.aborted),
    };
  } finally {
    clearTimeout(timer);
  }
}

function failureLabel(error: unknown, timedOut: boolean): string {
  if (error instanceof SubtitleError) {
    return error.code;
  }
  if (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    error.name === "AbortError"
  ) {
    return timedOut ? "timeout" : "cancelled";
  }
  return "unexpected";
}

function unavailableMessage(
  code: "modelUnavailable" | "accessDenied",
  modelSetting: string,
): string {
  const selection =
    modelSetting === "auto"
      ? "No Copilot model is available in the evaluation profile."
      : `The model ${JSON.stringify(modelSetting)} is not available in the evaluation profile.`;
  const access =
    code === "accessDenied"
      ? " Model access was denied; allow Code Subtitle to use the model when VS Code asks."
      : "";
  return `${selection}${access} Install GitHub Copilot Chat into .eval-host (this window's Extensions view), sign in once, then rerun npm run eval:live. Set CODE_SUBTITLE_EVAL_MODEL=<id> to pick a model without the picker.`;
}

function parseModelOptions(raw: string | undefined): Record<string, unknown> | undefined {
  if (raw === undefined || raw.trim().length === 0) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("CODE_SUBTITLE_EVAL_MODEL_OPTIONS must be a JSON object.");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("CODE_SUBTITLE_EVAL_MODEL_OPTIONS must be a JSON object.");
  }
  return parsed as Record<string, unknown>;
}

function renderReport(
  results: readonly CaseResult[],
  run: {
    semanticEnabled: boolean;
    modelSetting: string;
    modelOptions: Record<string, unknown> | undefined;
  },
): string {
  const model = results.find((result) => result.model !== undefined)?.model;
  const header = [
    "# Live evaluation",
    "",
    `- Date: ${new Date().toISOString()}`,
    `- VS Code: ${vscode.version}`,
    `- Model: ${model ? `${model.vendor}/${model.id} (${model.version})` : "none"} (setting: ${run.modelSetting})`,
    `- Semantic context: ${run.semanticEnabled ? "on" : "off"}`,
    `- Model options: ${run.modelOptions ? JSON.stringify(run.modelOptions) : "none"}`,
    "- Timings start at request start, after model resolution and prompt fitting.",
    "- Fill in `verdict` (pass/reject and one reason) against docs/output-quality.md.",
    "",
    "| # | Case | Model | Output language | Semantic entries | First (ms) | Done (ms) | Graphemes | Valid | Subtitle | Verdict |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
  ];
  const rows = results.map((result, index) => {
    const cells = [
      String(index + 1),
      result.title,
      result.model ? `${result.model.vendor}/${result.model.id}` : "",
      result.outputLanguage,
      String(result.semanticEntries),
      formatMs(result.firstMs),
      formatMs(result.doneMs),
      String(result.graphemes),
      result.error ? `error: ${result.error}` : result.valid ? "yes" : "no",
      result.text,
      "",
    ];
    return `| ${cells.map(escapeCell).join(" | ")} |`;
  });
  return `${[...header, ...rows].join("\n")}\n`;
}

function formatMs(value: number | undefined): string {
  return value === undefined ? "" : String(Math.round(value));
}

function escapeCell(value: string): string {
  // Escape backslashes first so that an escaped pipe cannot be un-escaped by input.
  return value
    .replace(/\\/gu, "\\\\")
    .replace(/\r?\n/gu, " ")
    .replace(/\|/gu, "\\|");
}
