const vscode = require("vscode");

const VENDOR = "code-subtitle-test";

function activate(context) {
  context.subscriptions.push(
    vscode.lm.registerLanguageModelChatProvider(VENDOR, {
      provideLanguageModelChatInformation: async () => [
        {
          id: "test-model",
          name: "Code Subtitle Test Model",
          family: "test",
          version: "1",
          maxInputTokens: 8_000,
          maxOutputTokens: 200,
          capabilities: {},
        },
      ],
      provideLanguageModelChatResponse: async (_model, _messages, _options, progress) => {
        progress.report(
          new vscode.LanguageModelTextPart("The test provider returned this subtitle."),
        );
      },
      provideTokenCount: async () => 1,
    }),
  );
}

module.exports = { activate };
