import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { rankedArchiveSearch } from '../core/rankedArchiveSearch';
import type { ChatMessage } from '../core/types';

const archiveText = (m: ChatMessage): string => m.content + (m.toolCalls?.length ? `\n[Tool calls]\n${JSON.stringify(m.toolCalls)}` : '');
const search = (archive: ChatMessage[], query: string, options: Partial<Parameters<typeof rankedArchiveSearch>[0]> = {}) => rankedArchiveSearch({
  archive, active: [], text: archiveText, query, caseSensitive: false, startIndex: 1, startOffset: 0,
  resultOffset: 0, includeActive: false, maxBytes: 4000, coverage: '', ...options,
});

test('exact paths and identifiers outrank keyword matches and expose provenance and contextual snippets', () => {
  const archive: ChatMessage[] = [
    { role: 'user', content: 'There was a src core agent issue in the search index.' },
    { role: 'tool', name: 'read_file', toolCallId: 'p', content: 'Before: index failed in src/core/agent.ts with ErrorCode42. After: exit 1.' },
    { role: 'assistant', content: 'Historical tool arguments', toolCalls: [{ id: 'a', name: 'search_text', arguments: '{"query":"src/core/agent.ts"}' }] },
    { role: 'user', content: 'src/core/agent.ts active duplicate' },
  ];
  const result = search(archive, 'src/core/agent.ts', { active: [archive[3]] });
  assert.ok(result.ok);
  assert.match(result.content, /untrusted history/);
  assert.match(result.content, /message_index=2 role=tool name=read_file offset=24/);
  assert.ok(result.content.indexOf('message_index=2') < result.content.indexOf('message_index=1'));
  assert.match(result.content, /message_index=3 role=assistant/);
  assert.ok(!result.content.includes('message_index=4'));
  assert.match(result.content, /Before: index failed/);
  assert.match(search(archive, 'ErrorCode42').content, /message_index=2/);
  assert.match(search(archive, 'src/core/agent.ts', { active: [archive[3]], includeActive: true }).content, /message_index=4/);
});

test('ranked results and scan windows are separately resumable and fit small tool budgets', () => {
  const archive: ChatMessage[] = Array.from({ length: 25 }, (_, i) => ({ role: 'user', content: `Unique surrounding ${i}: identifier-123` }));
  const visited = new Set<number>();
  let offset = 0;
  for (let n = 0; n < 30; n++) {
    const result = search(archive, 'identifier-123', { resultOffset: offset, maxBytes: 318 });
    assert.ok(result.ok, result.content);
    assert.ok(Buffer.byteLength(result.content, 'utf8') <= 318);
    for (const match of result.content.matchAll(/message_index=(\d+)/g)) visited.add(Number(match[1]));
    const next = /next_result_offset=(\d+)/.exec(result.content);
    if (!next) break;
    offset = Number(next[1]);
  }
  assert.equal(visited.size, 25);
  const many = Array.from({ length: 1001 }, (_, i): ChatMessage => ({ role: 'user', content: `text ${i}` }));
  assert.match(search(many, 'text').content, /next_start_index=1001 next_start_offset=0/);
});

test('ranked scan respects UTF-16 continuation boundaries and searches boundary-spanning phrases', () => {
  const text = 'x'.repeat(999_999) + '😀needle';
  const archive: ChatMessage[] = [{ role: 'user', content: text }];
  const first = search(archive, 'needle');
  assert.match(first.content, /next_start_index=1 next_start_offset=999999/);
  const second = search(archive, 'needle', { startIndex: 1, startOffset: 999999 });
  assert.match(second.content, /message_index=1 role=user offset=1000001/);
  assert.ok(!second.content.includes('�'));
  assert.equal(search(archive, 'needle', { startIndex: 1, startOffset: 1000000 }).ok, false);
  const boundary = [{ role: 'user' as const, content: 'x'.repeat(999_997) + 'boundaryword' }];
  assert.match(search(boundary, 'boundaryword').content, /offset=999997/);
});

test('ranked mode supports case sensitivity, validates result offsets and reports incomplete coverage', () => {
  const archive: ChatMessage[] = [{ role: 'user', content: 'Some eRrOrCase text' }];
  assert.match(search(archive, 'errorcase').content, /message_index=1/);
  assert.doesNotMatch(search(archive, 'errorcase', { caseSensitive: true }).content, /message_index=1/);
  assert.equal(search(archive, 'errorcase', { resultOffset: 5 }).ok, false);
  assert.match(search(archive, 'errorcase', { coverage: ' [Earlier history may be incomplete.]' }).content, /incomplete/);
});
