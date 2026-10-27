import { normalizeImage, parseDataUrl } from '../core/images';
import { isTranscriptWellFormed } from '../core/transcript';
import type { ChatMessage, Usage } from '../core/types';
import type { TranscriptItem } from './controller';

/** The same versioned format is used for workspace storage and explicit exports. */
export const CHAT_ARCHIVE_FORMAT = 'coding-harness-chat';
export const CHAT_ARCHIVE_VERSION = 1;
/** Avoid trying to parse an arbitrary, multi-gigabyte file selected for import. */
export const MAX_CHAT_ARCHIVE_BYTES = 512 * 1024 * 1024;

export interface ChatArchive {
  format: typeof CHAT_ARCHIVE_FORMAT;
  version: typeof CHAT_ARCHIVE_VERSION;
  savedAt: string;
  inProgress: boolean;
  items: TranscriptItem[];
  history: ChatMessage[];
  usage: Usage;
}

function invalid(reason: string): never {
  throw new Error(`Invalid Coding Harness chat: ${reason}`);
}

function object(value: unknown, label: string): Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(`${label} must be an object.`);
  return value as Record<string, any>;
}

function string(value: unknown, label: string, nonempty = false): void {
  if (typeof value !== 'string' || (nonempty && !value.trim())) invalid(`${label} must be ${nonempty ? 'a non-empty' : 'a'} string.`);
}

function optionalString(value: unknown, label: string): void {
  if (value !== undefined) string(value, label);
}

function optionalNumber(value: unknown, label: string): void {
  if (value !== undefined && (typeof value !== 'number' || !Number.isFinite(value) || value < 0)) {
    invalid(`${label} must be a non-negative number.`);
  }
}

function optionalBoolean(value: unknown, label: string): void {
  if (value !== undefined && typeof value !== 'boolean') invalid(`${label} must be a boolean.`);
}

function usage(value: unknown, label: string): void {
  const info = object(value, label);
  for (const key of ['inputTokens', 'outputTokens', 'totalTokens', 'cachedTokens', 'tokensPerSecond', 'durationMs']) {
    optionalNumber(info[key], `${label}.${key}`);
  }
}

function images(value: unknown, label: string, display: boolean): void {
  if (!Array.isArray(value) || value.length > 8) invalid(`${label} must contain at most 8 images.`);
  for (const entry of value) {
    const image = object(entry, label);
    string(image.mediaType, `${label}.mediaType`, true);
    optionalString(image.name, `${label}.name`);
    optionalNumber(image.bytes, `${label}.bytes`);
    if (display) {
      string(image.dataUrl, `${label}.dataUrl`, true);
      const parsed = parseDataUrl(image.dataUrl);
      if (!parsed || parsed.mediaType !== image.mediaType || !normalizeImage({ dataUrl: image.dataUrl }).image) {
        invalid(`${label} contains an invalid image.`);
      }
    } else {
      string(image.data, `${label}.data`, true);
      if (!normalizeImage({ mediaType: image.mediaType, data: image.data }).image) invalid(`${label} contains an invalid image.`);
    }
  }
}

function message(value: unknown): void {
  const entry = object(value, 'history message');
  if (!['user', 'assistant', 'tool'].includes(entry.role)) invalid('history contains an unsupported role.');
  string(entry.content, 'history message content');
  optionalString(entry.name, 'history message name');
  optionalString(entry.toolCallId, 'history tool call id');
  if (entry.role === 'tool') string(entry.toolCallId, 'history tool call id', true);
  if (entry.images !== undefined) {
    if (entry.role !== 'user') invalid('only user messages may have images.');
    images(entry.images, 'history images', false);
  }
  if (entry.toolCalls !== undefined) {
    if (entry.role !== 'assistant' || !Array.isArray(entry.toolCalls)) invalid('invalid tool calls.');
    for (const value of entry.toolCalls) {
      const call = object(value, 'tool call');
      string(call.id, 'tool call id', true);
      string(call.name, 'tool call name', true);
      string(call.arguments, 'tool call arguments');
    }
  }
}

function item(value: unknown): void {
  const entry = object(value, 'transcript item');
  string(entry.id, 'transcript item id', true);
  switch (entry.kind) {
    case 'user':
      string(entry.text, 'user text');
      if (entry.images !== undefined) images(entry.images, 'transcript images', true);
      break;
    case 'assistant':
      string(entry.text, 'assistant text');
      if (typeof entry.final !== 'boolean') invalid('assistant final flag must be a boolean.');
      optionalBoolean(entry.streaming, 'assistant streaming');
      break;
    case 'thinking':
      string(entry.text, 'thinking text');
      if (typeof entry.streaming !== 'boolean') invalid('thinking streaming flag must be a boolean.');
      optionalNumber(entry.durationMs, 'thinking duration');
      optionalNumber(entry.startedAt, 'thinking start time');
      break;
    case 'tool':
      string(entry.toolCallId, 'tool call id', true);
      string(entry.name, 'tool name', true);
      string(entry.args, 'tool arguments');
      if (!['running', 'ok', 'failed'].includes(entry.status)) invalid('unknown tool status.');
      for (const key of ['summary', 'detail', 'relPath']) optionalString(entry[key], `tool ${key}`);
      optionalNumber(entry.startedAt, 'tool start time');
      optionalNumber(entry.durationMs, 'tool duration');
      break;
    case 'approval': {
      string(entry.approvalId, 'approval id', true);
      const request = object(entry.request, 'approval request');
      if (!['write', 'delete', 'command'].includes(request.kind)) invalid('unknown approval kind.');
      string(request.title, 'approval title');
      string(request.detail, 'approval detail');
      for (const key of ['relPath', 'absPath', 'newContent', 'oldContent', 'command']) {
        optionalString(request[key], `approval ${key}`);
      }
      if (entry.decision !== undefined && !['apply', 'reject'].includes(entry.decision)) invalid('unknown approval decision.');
      optionalBoolean(entry.interrupted, 'approval interrupted');
      break;
    }
    case 'notice':
      if (!['info', 'warn', 'error'].includes(entry.level)) invalid('unknown notice level.');
      string(entry.message, 'notice message');
      break;
    case 'done':
      if (!['complete', 'max-steps', 'cancelled', 'error'].includes(entry.reason)) invalid('unknown task outcome.');
      string(entry.summary, 'task summary');
      if (!Array.isArray(entry.filesChanged) || !entry.filesChanged.every((file: unknown) => typeof file === 'string')) {
        invalid('changed files must be a list of paths.');
      }
      if (entry.usage !== undefined) usage(entry.usage, 'task usage');
      optionalNumber(entry.tokensPerSecond, 'task speed');
      break;
    default:
      invalid('unknown transcript item.');
  }
}

/** Validate external data before it can replace the current conversation. */
export function parseChatArchive(text: string): ChatArchive {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return invalid('the file is not valid JSON.');
  }
  const archive = object(parsed, 'chat');
  if (archive.format !== CHAT_ARCHIVE_FORMAT) invalid('unrecognized file format.');
  if (archive.version !== CHAT_ARCHIVE_VERSION) invalid(`unsupported version ${String(archive.version)}.`);
  string(archive.savedAt, 'savedAt', true);
  if (typeof archive.inProgress !== 'boolean') invalid('inProgress must be a boolean.');
  if (!Array.isArray(archive.items) || !Array.isArray(archive.history)) invalid('items and history must be arrays.');
  usage(archive.usage, 'usage');
  const ids = new Set<string>();
  for (const entry of archive.items) {
    item(entry);
    if (ids.has(entry.id)) invalid('transcript item ids must be unique.');
    ids.add(entry.id);
  }
  for (const entry of archive.history) message(entry);
  if (archive.history.length && archive.history[0].role !== 'user') invalid('history must start with a user message.');
  if (!isTranscriptWellFormed(archive.history)) invalid('history contains unpaired tool calls or results.');
  return archive as ChatArchive;
}
