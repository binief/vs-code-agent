import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import { HarnessSession } from '../core/agent';
import { estimateMessagesTokens } from '../core/compaction';
import {
  base64Bytes,
  describeImages,
  MAX_IMAGE_BYTES,
  MAX_IMAGES_PER_MESSAGE,
  normalizeImages,
  parseDataUrl,
  toDataUrl,
} from '../core/images';
import { toAnthropicMessages, toOpenAiMessages } from '../core/providers';
import { MockPlannerProvider } from '../core/providers/mock';
import { ToolRegistry } from '../core/tools';
import {
  resolveConfig,
  type ChatMessage,
  type ChatRequest,
  type HarnessHost,
  type ImageAttachment,
  type Provider,
} from '../core/types';

/** 1x1 transparent PNG. */
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const PNG_DATA_URL = `data:image/png;base64,${PNG_BASE64}`;

/* ------------------------------------------------------------ normalising */

test('a pasted data URL becomes a normalised attachment', () => {
  const { images, errors } = normalizeImages([{ name: 'shot.png', dataUrl: PNG_DATA_URL }]);
  assert.equal(errors.length, 0);
  assert.equal(images.length, 1);
  assert.equal(images[0].mediaType, 'image/png');
  assert.equal(images[0].data, PNG_BASE64);
  assert.equal(images[0].name, 'shot.png');
  assert.equal(images[0].bytes, base64Bytes(PNG_BASE64));
  assert.equal(toDataUrl(images[0]), PNG_DATA_URL);
});

test('parseDataUrl rejects anything that is not base64 image data', () => {
  assert.equal(parseDataUrl('https://example.com/a.png'), undefined);
  assert.equal(parseDataUrl('data:image/png,notbase64'), undefined);
  assert.deepEqual(parseDataUrl(PNG_DATA_URL), { mediaType: 'image/png', data: PNG_BASE64 });
});

test('unsupported types, oversized images and junk are reported, not thrown', () => {
  const huge = 'A'.repeat(Math.ceil((MAX_IMAGE_BYTES + 1024) * 4 / 3));
  const { images, errors } = normalizeImages([
    { name: 'doc.pdf', dataUrl: 'data:application/pdf;base64,AAAA' },
    { name: 'big.png', dataUrl: `data:image/png;base64,${huge}` },
    { name: 'broken.png', dataUrl: 'nonsense' },
    { name: 'ok.png', dataUrl: PNG_DATA_URL },
  ]);
  assert.equal(images.length, 1, 'the one good image still goes through');
  assert.equal(errors.length, 3);
  assert.match(errors[0].reason, /unsupported image type/);
  assert.match(errors[1].reason, /limit/);
  assert.match(errors[2].reason, /data URL/);
});

test('a paste batch is capped per message', () => {
  const many = Array.from({ length: MAX_IMAGES_PER_MESSAGE + 3 }, () => ({ dataUrl: PNG_DATA_URL }));
  const { images, errors } = normalizeImages(many);
  assert.equal(images.length, MAX_IMAGES_PER_MESSAGE);
  assert.equal(errors.length, 3);
});

test('images are counted against the context budget', () => {
  const withImage: ChatMessage[] = [{ role: 'user', content: 'what is wrong here?', images: [{ mediaType: 'image/png', data: PNG_BASE64 }] }];
  const withoutImage: ChatMessage[] = [{ role: 'user', content: 'what is wrong here?' }];
  assert.ok(
    estimateMessagesTokens(withImage) > estimateMessagesTokens(withoutImage) + 500,
    'an attached image must cost more than its base64 length suggests',
  );
});

test('describeImages gives a text fallback for models that cannot see', () => {
  const text = describeImages([{ mediaType: 'image/png', data: PNG_BASE64, name: 'shot.png' }]);
  assert.match(text, /1 attached image/);
  assert.match(text, /shot\.png/);
});

/* -------------------------------------------------------------- providers */

const attachment: ImageAttachment = { mediaType: 'image/png', data: PNG_BASE64, name: 'shot.png' };
const visionConversation: ChatMessage[] = [
  { role: 'system', content: 'You are the harness.' },
  { role: 'user', content: 'what is wrong in this screenshot?', images: [attachment] },
];

test('OpenAI mapping sends images as multipart image_url content', () => {
  const messages = toOpenAiMessages(visionConversation) as any[];
  const user = messages[1];
  assert.equal(user.role, 'user');
  assert.ok(Array.isArray(user.content), 'a user turn with images needs multipart content');
  assert.deepEqual(user.content[0], { type: 'text', text: 'what is wrong in this screenshot?' });
  assert.equal(user.content[1].type, 'image_url');
  assert.equal(user.content[1].image_url.url, PNG_DATA_URL);
});

test('a text-only user turn keeps the plain string form', () => {
  const messages = toOpenAiMessages([{ role: 'user', content: 'hello' }]) as any[];
  assert.equal(messages[0].content, 'hello');
});

test('Anthropic mapping sends images as base64 source blocks before the text', () => {
  const { messages } = toAnthropicMessages(visionConversation);
  const user = messages[0] as any;
  assert.equal(user.role, 'user');
  assert.deepEqual(user.content[0], {
    type: 'image',
    source: { type: 'base64', media_type: 'image/png', data: PNG_BASE64 },
  });
  assert.deepEqual(user.content[1], { type: 'text', text: 'what is wrong in this screenshot?' });
});

/* ------------------------------------------------------------------ agent */

function stubHost(root: string): HarnessHost {
  return {
    workspaceRoot: root,
    log: () => {},
    requestApproval: async () => 'reject',
  };
}

/** Captures the request the session builds, then ends the task. */
class CapturingProvider implements Provider {
  readonly id = 'mock';
  readonly label = 'capturing';
  last?: ChatRequest;
  async chat(req: ChatRequest) {
    this.last = req;
    return { text: 'done', toolCalls: [] };
  }
}

test('runTask attaches images to the user turn and keeps them in history', async () => {
  const provider = new CapturingProvider();
  const session = new HarnessSession({
    host: stubHost(fs.realpathSync(path.resolve('.'))),
    config: resolveConfig({ provider: 'mock', maxSteps: 1, stream: false, includeDiagnosticsInPrompt: false }),
    provider,
    registry: new ToolRegistry([]),
  });

  await session.runTask('what is this?', () => {}, { images: [attachment] });

  const sent = provider.last!.messages.find((m) => m.role === 'user');
  assert.ok(sent?.images?.length, 'the provider must receive the attachment');
  assert.equal(sent!.images![0].data, PNG_BASE64);
  assert.ok(session.transcript.some((m) => m.role === 'user' && m.images?.length), 'history keeps the attachment');
});

test('an image with no prompt text still gets an instruction', async () => {
  const provider = new CapturingProvider();
  const session = new HarnessSession({
    host: stubHost(fs.realpathSync(path.resolve('.'))),
    config: resolveConfig({ provider: 'mock', maxSteps: 1, stream: false, includeDiagnosticsInPrompt: false }),
    provider,
    registry: new ToolRegistry([]),
  });

  await session.runTask('   ', () => {}, { images: [attachment] });

  const sent = provider.last!.messages.find((m) => m.role === 'user');
  assert.ok(sent!.content.length > 0, 'an empty text part would be rejected by some endpoints');
  assert.ok(sent!.images?.length);
});

test('the mock planner admits it cannot see an attached image', async () => {
  const mock = new MockPlannerProvider();
  const answer = await mock.chat({
    model: 'mock',
    tools: [],
    messages: [{ role: 'user', content: 'what is this?', images: [attachment] }],
  });
  assert.match(answer.text, /cannot read images/);
});

/* ----------------------------------------------------------------- panel */

const repoRoot = path.resolve(__dirname, '..', '..');
const js = fs.readFileSync(path.join(repoRoot, 'media', 'chat.js'), 'utf8');
const css = fs.readFileSync(path.join(repoRoot, 'media', 'chat.css'), 'utf8');
const view = fs.readFileSync(path.join(repoRoot, 'src', 'vscode', 'chatView.ts'), 'utf8');

test('the composer stages pasted and dropped images', () => {
  assert.match(js, /addEventListener\('paste'/, 'the textarea must intercept clipboard images');
  assert.match(js, /addEventListener\('drop'/, 'dropping an image should work too');
  assert.match(js, /readAsDataURL/, 'attachments travel to the extension as data URLs');
  assert.match(js, /vscode\.postMessage\(\{ type: 'submit', text: value, images \}\)/, 'submit must carry the attachments');
  assert.match(js, /clearAttachments\(\)/, 'the tray must empty once the message is sent');
});

test('the panel renders attachments, before and after sending', () => {
  assert.match(view, /id="attachments"/, 'the staging tray must exist in the markup');
  assert.match(js, /function renderAttachments\(/);
  assert.match(js, /function renderUserImages\(/);
  assert.ok(css.includes('.attachment'), 'the tray needs styling');
  assert.ok(css.includes('.msg-images'), 'sent thumbnails need styling');
});

test('the webview may load inline image data', () => {
  const csp = view.match(/img-src [^`]*?`/);
  assert.ok(csp, 'the CSP must declare img-src');
  assert.match(csp![0], /data:/, 'pasted images are rendered from data URLs');
});

test('the extension forwards attachments to the controller', () => {
  assert.match(view, /this\.controller\.run\(String\(message\.text \?\? ''\), Array\.isArray\(message\.images\)/);
});
