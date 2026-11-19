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

    vscode.commands.registerCommand('codingHarness.listDetachedProcesses', async () => {
      await chatView.reveal();
      const processes = controller.getDetachedProcesses();
      if (processes.length === 0) {
        void vscode.window.showInformationMessage('No detached background processes are running.');
        return;
      }
      const lines = processes.map(
        (p) => `PID ${p.pid}: ${p.command} (cwd: ${p.cwd}, started ${new Date(p.startedAt).toLocaleTimeString()})`,
      );
      void vscode.window.showInformationMessage(
        `Detached background processes (${processes.length}):\n${lines.join('\n')}`,
        { modal: true },
      );
    }),

    vscode.commands.registerCommand('codingHarness.stopDetachedCommands', async () => {
      await chatView.reveal();
      const count = controller.killAllDetachedProcesses();
      if (count === 0) {
        void vscode.window.showInformationMessage('No detached background processes to stop.');
        return;
      }
      void vscode.window.showInformationMessage(`Stopped ${count} detached background process(es).`);
    }),

    vscode.commands.registerCommand('codingHarness.listRunningCommands', async () => {
      await chatView.reveal();
      const processes = controller.getRunningCommands();
      if (processes.length === 0) {
        void vscode.window.showInformationMessage('No shell commands are currently running.');
        return;
      }
      const lines = processes.map(
        (p) =>
          `PID ${p.pid}${p.detached ? ' [detached]' : ''}: ${p.command} (cwd: ${p.cwd}, started ${new Date(p.startedAt).toLocaleTimeString()})${p.outputLines.length ? ` · ${p.outputLines.length} output line(s)` : ''}`,
      );
      void vscode.window.showInformationMessage(
        `Running shell commands (${processes.length}):\\n${lines.join('\\n')}`,
        { modal: true },
      );
    }),

    vscode.commands.registerCommand('codingHarness.stopRunningCommands', async () => {
      await chatView.reveal();
      const processes = controller.getRunningCommands();
      if (processes.length === 0) {
        void vscode.window.showInformationMessage('No shell commands to stop.');
        return;
      }
      if (processes.length === 1) {
        const p = processes[0];
        const killed = controller.killRunningCommand(p.pid) ? 1 : 0;
        if (killed === 0) {
          void vscode.window.showInformationMessage(`Could not stop command PID ${p.pid}.`);
          return;
        }
        void vscode.window.showInformationMessage(`Stopped command PID ${p.pid}: ${p.command}.`);
        return;
      }
      // Multiple running commands: let the user choose which to stop.
      interface CommandPick extends vscode.QuickPickItem {
        pid: number | undefined;
      }
      const picks: CommandPick[] = processes.map((p) => ({
        label: `PID ${p.pid}${p.detached ? ' [detached]' : ''}`,
        description: p.command,
        detail: `cwd: ${p.cwd}, started ${new Date(p.startedAt).toLocaleTimeString()}`,
        pid: p.pid,
      }));
      picks.unshift({
        label: 'Stop all running commands',
        description: `${processes.length} command(s)`,
        detail: 'Kill every shell command currently running.',
        pid: undefined,
      });
      const picked = await vscode.window.showQuickPick(picks, {
        title: 'Coding Harness — stop a running command',
        placeHolder: 'Choose a command to stop, or stop all.',
      });
      if (!picked) return;
      let count = 0;
      if (picked.pid === undefined) {
        count = controller.killAllRunningCommands();
      } else {
        count = controller.killRunningCommand(picked.pid) ? 1 : 0;
      }
      if (count === 0) {
        void vscode.window.showInformationMessage('No commands were stopped.');
        return;
      }
      void vscode.window.showInformationMessage(`Stopped ${count} running command(s).`);
    }),

    vscode.commands.registerCommand('codingHarness.showCommandOutput', async () => {
      await chatView.reveal();
      const processes = controller.getRunningCommands();
      if (processes.length === 0) {
        void vscode.window.showInformationMessage('No shell commands are currently running.');
        return;
      }

      const pick = processes.map((p) => ({
        label: `PID ${p.pid}${p.detached ? ' [detached]' : ''}`,
        description: p.command,
        detail: `${p.outputLines.length} output line(s) · cwd: ${p.cwd}`,
        pid: p.pid,
      }));

      const selected = await vscode.window.showQuickPick(pick, {
        title: 'Coding Harness — view command output',
        placeHolder: 'Choose a command to see its recent output.',
      });
      if (!selected) return;

      const output = controller.getRunningCommandOutput(selected.pid);
      if (output.length === 0) {
        void vscode.window.showInformationMessage(
          `No output captured yet for PID ${selected.pid}.`,
        );
        return;
      }

      const content = output.join('\n');
      const doc = await vscode.workspace.openTextDocument({
        content,
        language: 'log',
      });
      await vscode.window.showTextDocument(doc, { preview: false, preserveFocus: false });
    }),

    vscode.commands.registerCommand('codingHarness.selectCopilotModel', async () => {
      await controller.selectCopilotModel();
    }),

    vscode.commands.registerCommand('codingHarness.setApiKey', async () => {
      const config = controller.readConfig();
      if (config.provider === 'copilot') {
        void vscode.window.showInformationMessage('Copilot uses your VS Code sign-in and consent; no Coding Harness API key is needed.');
        return;
      }
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
          `workspace=${state.workspace || '(none)'} apiKey=${state.keyPresent ? 'set' : 'unset'} tools=${state.toolCount} ` +
          `mcp=${state.mcpEnabled ? `${state.mcpServers} srv ${state.mcpToolCount} tools` : 'off'} ` +
          `tokens=${state.cumulativeUsage?.totalTokens || 0} ctx=${Math.round(state.contextPercent || 0)}%`,
      );
      channel.show(true);
    }),

    vscode.commands.registerCommand('codingHarness.compactConversation', async () => {
      await chatView.reveal();
      await controller.compactHistory();
    }),

    vscode.commands.registerCommand('codingHarness.showChatStorageLocation', async () => {
      await controller.showChatStorageLocation();
    }),

    vscode.commands.registerCommand('codingHarness.exportChat', async () => {
      await controller.exportChat();
    }),

    vscode.commands.registerCommand('codingHarness.importChat', async () => {
      await controller.importChat();
      await chatView.reveal();
    }),

    vscode.commands.registerCommand('codingHarness.reloadMcpServers', async () => {
      await chatView.reveal();
      await controller.reloadMcpServers();
    }),

    vscode.commands.registerCommand('codingHarness.openAgentFiles', async () => {
      await chatView.reveal();
      await controller.openAgentInstructions();
    }),

    vscode.commands.registerCommand('codingHarness.reloadAgentFiles', async () => {
      await controller.refreshAgentFiles(true);
    }),

    vscode.commands.registerCommand('codingHarness.previewContext', async () => {
      await controller.previewContext();
    }),
  );
}

export async function deactivate(): Promise<void> {
  approvals?.cancelAll();
  await controller?.shutdown();
}
