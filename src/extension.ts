import * as vscode from 'vscode';
import { CHAT_VIEW_ID, ChatViewProvider } from './vscode/chatView';
import { HarnessController } from './vscode/controller';
import { ApprovalService } from './vscode/host';
import { Logger } from './vscode/log';
import { PROPOSAL_SCHEME, ProposalStore } from './vscode/proposals';

let controller: HarnessController | undefined;
let approvals: ApprovalService | undefined;

export function activate(context: vscode.ExtensionContext): void {
  const channel = vscode.window.createOutputChannel('Coding Harness');
  const log = new Logger(channel, true);
  const proposals = new ProposalStore();
  const approvalService = new ApprovalService(log);
  const harnessController = new HarnessController(context, log, approvalService, proposals);
  const chatView = new ChatViewProvider(context.extensionUri, harnessController, log);

  controller = harnessController;
  approvals = approvalService;

  context.subscriptions.push(
    channel,
    proposals,
    chatView,
    vscode.workspace.registerTextDocumentContentProvider(PROPOSAL_SCHEME, proposals),
    vscode.window.registerWebviewViewProvider(CHAT_VIEW_ID, chatView, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    harnessController.onUiMessage((message) => chatView.post(message)),
    vscode.workspace.onDidChangeConfiguration(async (event) => {
      if (event.affectsConfiguration('codingHarness')) await harnessController.refreshState();
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(async () => {
      await harnessController.refreshState();
    }),
  );

  // The webview is the preferred approval surface; when it is not visible the
  // ApprovalService falls back to a modal dialog.
  approvalService.setBridge((id, request) => chatView.postApproval(id, request));

  registerCommands(context, harnessController, chatView, log, channel);
  log.info(`Coding Harness activated (${harnessController.readConfig().provider}/${harnessController.readConfig().model})`);
}

function registerCommands(
  context: vscode.ExtensionContext,
  controller: HarnessController,
  chatView: ChatViewProvider,
  log: Logger,
  channel: vscode.OutputChannel,
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('codingHarness.newTask', async () => {
      await chatView.reveal();
      const prompt = await vscode.window.showInputBox({
        title: 'Coding Harness — new task',
        prompt: 'What should the agent do?',
        placeHolder: 'e.g. add input validation to the signup endpoint and run the tests',
        ignoreFocusOut: true,
      });
      if (prompt?.trim()) await controller.run(prompt);
    }),

    vscode.commands.registerCommand('codingHarness.runTask', async () => {
      const prompt = await vscode.window.showInputBox({
        title: 'Coding Harness — run task',
        prompt: 'Describe the coding task',
        ignoreFocusOut: true,
      });
      if (prompt?.trim()) {
        await chatView.reveal();
        await controller.run(prompt);
      }
    }),

    vscode.commands.registerCommand('codingHarness.focusChat', async () => {
      await chatView.reveal();
      chatView.post({ type: 'state', state: controller.getState() });
    }),

    vscode.commands.registerCommand('codingHarness.askAboutSelection', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        void vscode.window.showInformationMessage('Open a file and select some code first.');
        return;
      }
      const selection = editor.document.getText(editor.selection);
      if (!selection.trim()) {
        void vscode.window.showInformationMessage('Select some code first.');
        return;
      }
      const rel = vscode.workspace.asRelativePath(editor.document.uri, false);
      const from = editor.selection.start.line + 1;
      const to = editor.selection.end.line + 1;

      const question = await vscode.window.showInputBox({
        title: `Coding Harness — about the selection in ${rel}`,
        prompt: 'What should I do with this selection?',
        value: 'Explain this code and point out any bugs.',
        ignoreFocusOut: true,
      });
      if (!question?.trim()) return;

      const prompt = [
        `${question.trim()}`,
        '',
        `Context — ${rel}, lines ${from}-${to}:`,
        '```' + editor.document.languageId,
        selection,
        '```',
      ].join('\n');

      await chatView.reveal();
      await controller.run(prompt);
    }),

    vscode.commands.registerCommand('codingHarness.revertTask', async () => {
      await chatView.reveal();
      await controller.revertLastTask();
    }),

    vscode.commands.registerCommand('codingHarness.setApiKey', async () => {
      const config = controller.readConfig();
      const key = await vscode.window.showInputBox({
        title: `Coding Harness — API key for "${config.provider}"`,
        prompt: 'Stored in VS Code secret storage (not in settings.json or the workspace).',
        password: true,
        ignoreFocusOut: true,
        placeHolder: config.provider === 'anthropic' ? 'sk-ant-…' : 'sk-…',
      });
      if (key === undefined) return;
      if (!key.trim()) {
        await context.secrets.delete('codingHarness.apiKey');
        void vscode.window.showInformationMessage('Coding Harness: stored API key cleared.');
      } else {
        await controller.storeApiKey(key.trim());
        void vscode.window.showInformationMessage('Coding Harness: API key saved to secret storage.');
      }
      await controller.refreshState();
    }),

    vscode.commands.registerCommand('codingHarness.showLog', () => {
      const state = controller.getState();
      log.info(
        `state: provider=${state.provider}/${state.model} editPolicy=${state.editPolicy} commandPolicy=${state.commandPolicy} ` +
          `workspace=${state.workspace || '(none)'} apiKey=${state.keyPresent ? 'set' : 'unset'} tools=${state.toolCount}`,
      );
      channel.show(true);
    }),
  );
}

export function deactivate(): void {
  approvals?.cancelAll();
  controller?.cancel();
}
