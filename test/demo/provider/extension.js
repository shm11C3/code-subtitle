const vscode = require("vscode");

function activate(context) {
  context.subscriptions.push(
    vscode.lm.registerLanguageModelChatProvider("code-subtitle-demo", {
      provideLanguageModelChatInformation: async () => [
        {
          id: "fixed-response",
          name: "Demo (fixed response)",
          family: "demo",
          version: "1",
          maxInputTokens: 8000,
          maxOutputTokens: 200,
          capabilities: {},
        },
      ],
      provideTokenCount: async () => 1,
      provideLanguageModelChatResponse: async (_model, _messages, _options, progress, token) => {
        const words = "A request ID prevents stale results from replacing the current view.".split(
          " ",
        );
        for (const [index, word] of words.entries()) {
          if (token.isCancellationRequested) return;
          progress.report(new vscode.LanguageModelTextPart((index ? " " : "") + word));
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      },
    }),
  );
}

module.exports = { activate };
