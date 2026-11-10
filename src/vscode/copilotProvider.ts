import * as vscode from 'vscode';
import type { ChatMessage, ChatRequest, Provider, ProviderResponse } from '../core/types';

const unavailable = 'No GitHub Copilot models are available to this extension. Install/enable GitHub Copilot Chat, sign in to an eligible Copilot account in VS Code, and run Coding Harness: Select Copilot Model. Organization policy and model availability may also apply.';

function copilotError(error: unknown): unknown {
  const code = (error as { code?: string } | undefined)?.code;
  if (code === 'NoPermissions') return new Error('VS Code denied Copilot model access. Allow Coding Harness to access Copilot models, then try again.');
  if (code === 'Blocked') return new Error('Copilot blocked this request. Check your Copilot plan, quota, model access and organization policy.');
  if (code === 'NotFound') return new Error(`Copilot model is no longer available. ${unavailable}`);
  return error;
}

async function selectModels(id: string, signal?: AbortSignal): Promise<vscode.LanguageModelChat[]> {
  if (!signal) return await vscode.lm.selectChatModels({ vendor: 'copilot', id });
  if (signal.aborted) throw new Error('Cancelled.');
  let abort!: () => void;
  const cancelled = new Promise<never>((_resolve, reject) => { abort = () => reject(new Error('Cancelled.')); });
  signal.addEventListener('abort', abort, { once: true });
  try {
    if (signal.aborted) throw new Error('Cancelled.');
    return await Promise.race([vscode.lm.selectChatModels({ vendor: 'copilot', id }), cancelled]);
  } finally { signal.removeEventListener('abort', abort); }
}

/** Use only the public VS Code Language Model API. VS Code owns sign-in and consent. */
export class CopilotProvider implements Provider {
  readonly id = 'copilot';
  readonly label = 'GitHub Copilot (VS Code)';

  async chat(req: ChatRequest): Promise<ProviderResponse> {
    if (!vscode.lm?.selectChatModels || !vscode.LanguageModelToolCallPart || !vscode.LanguageModelToolResultPart) {
      throw new Error('GitHub Copilot tool calling requires a newer VS Code with the Language Model API. Update VS Code and Copilot Chat.');
    }
    if (!req.model.trim()) throw new Error('No Copilot model selected. Run Coding Harness: Select Copilot Model.');
    if (req.signal?.aborted) throw new Error('Cancelled.');
    const models = await selectModels(req.model, req.signal).catch((error: unknown) => { throw copilotError(error); });
    if (req.signal?.aborted) throw new Error('Cancelled.');
    const model = models.find((item) => item.vendor === 'copilot' && item.id === req.model);
    if (!model) throw new Error(`Copilot model "${req.model}" is not currently available. ${unavailable}`);
    const messages = toCopilotMessages(req.messages);
    const cancellation = new vscode.CancellationTokenSource();
    const abort = () => cancellation.cancel();
    req.signal?.addEventListener('abort', abort, { once: true });
    if (req.signal?.aborted) cancellation.cancel();
    try {
      if (req.signal?.aborted) throw new Error('Cancelled.');
      const response = await model.sendRequest(messages, {
        justification: 'Coding Harness uses this model to respond to your task and to summarize conversation context.',
        ...(req.tools.length ? { tools: req.tools.map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.parameters })) } : {}),
      }, cancellation.token);
      let text = '';
      const toolCalls: ProviderResponse['toolCalls'] = [];
      for await (const part of response.stream) {
        if (req.signal?.aborted) throw new Error('Cancelled.');
        if (part instanceof vscode.LanguageModelTextPart) {
          text += part.value;
          req.onDelta?.(part.value);
        } else if (part instanceof vscode.LanguageModelToolCallPart) {
          if (!part.callId || !part.name) throw new Error('Copilot returned an invalid tool call.');
          if (!part.input || typeof part.input !== 'object' || Array.isArray(part.input)) throw new Error('Copilot returned invalid tool arguments.');
          const args = JSON.stringify(part.input);
          if (args === undefined) throw new Error('Copilot returned invalid tool arguments.');
          toolCalls.push({ id: part.callId, name: part.name, arguments: args });
        }
      }
      if (req.signal?.aborted) throw new Error('Cancelled.');
      // The stable API does not expose finish reason, usage, temperature or output limit.
      return { text, toolCalls };
    } catch (error) {
      throw copilotError(error);
    } finally {
      req.signal?.removeEventListener('abort', abort);
      cancellation.dispose();
    }
  }
}

/** VS Code exposes only User/Assistant roles; system instructions become a leading user message. */
export function toCopilotMessages(messages: ChatMessage[]): vscode.LanguageModelChatMessage[] {
  const result: vscode.LanguageModelChatMessage[] = [];
  for (const message of messages) {
    if (message.role === 'system') {
      result.push(vscode.LanguageModelChatMessage.User(`Harness instructions and context (the VS Code Language Model API has no system role):\n\n${message.content}`));
      continue;
    }
    if (message.role === 'user') {
      const parts: Array<vscode.LanguageModelTextPart | vscode.LanguageModelDataPart> = [];
      if (message.content) parts.push(new vscode.LanguageModelTextPart(message.content));
      for (const image of message.images ?? []) {
        if (!vscode.LanguageModelDataPart?.image) throw new Error('Images with Copilot require a newer VS Code (1.106 or later). Update VS Code or remove the images.');
        parts.push(vscode.LanguageModelDataPart.image(Buffer.from(image.data, 'base64'), image.mediaType));
      }
      result.push(vscode.LanguageModelChatMessage.User(parts));
      continue;
    }
    if (message.role === 'assistant') {
      const parts: Array<vscode.LanguageModelTextPart | vscode.LanguageModelToolCallPart> = [];
      if (message.content) parts.push(new vscode.LanguageModelTextPart(message.content));
      for (const call of message.toolCalls ?? []) {
        let input: unknown;
        try { input = JSON.parse(call.arguments); } catch { throw new Error(`Cannot send previous tool call "${call.name}" to Copilot: its arguments are not valid JSON.`); }
        if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error(`Cannot send previous tool call "${call.name}" to Copilot: its arguments are not a JSON object.`);
        parts.push(new vscode.LanguageModelToolCallPart(call.id, call.name, input));
      }
      result.push(vscode.LanguageModelChatMessage.Assistant(parts));
      continue;
    }
    if (!message.toolCallId) throw new Error('Cannot send a tool result to Copilot without a matching call ID.');
    const part = new vscode.LanguageModelToolResultPart(message.toolCallId, [new vscode.LanguageModelTextPart(message.content)]);
    const previous = result[result.length - 1];
    if (previous?.role === vscode.LanguageModelChatMessageRole.User && previous.content.length > 0 && previous.content.every((item) => item instanceof vscode.LanguageModelToolResultPart)) previous.content.push(part);
    else result.push(vscode.LanguageModelChatMessage.User([part]));
  }
  return result;
}

export { unavailable as COPILOT_UNAVAILABLE_MESSAGE };
