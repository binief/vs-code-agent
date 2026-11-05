import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { detectRepetition, dedupeThinking, ThinkingMonitor } from '../core/thinking';

test('short normal thinking is not flagged as repeating', () => {
  const thinking = 'Let me check the project layout first. I will list the files and see what exists.';
  const res = detectRepetition(thinking);
  assert.equal(res.isRepeating, false);
  assert.equal(res.reason, '');
});

test('repeating sentence 3+ times is flagged', () => {
  const thinking =
    'I need to read the file. I need to read the file. I need to read the file. I need to read the file. Let me continue. Another unique sentence here. Yet another one to push over min.';
  const res = detectRepetition(thinking);
  assert.equal(res.isRepeating, true);
  assert.ok(res.reason.includes('repeated'));
  assert.ok(res.repeatedSentences.length > 0);
  assert.ok(res.repeatScore > 0);
});

test('sliding window loop is detected', () => {
  const thinking =
    'First I will list files. Then I will read the file. Then I will check diagnostics. First I will list files. Then I will read the file. Then I will check diagnostics.';
  const res = detectRepetition(thinking);
  assert.equal(res.isRepeating, true);
  assert.match(res.reason, /last 3 sentences|repeated/i);
});

test('high duplicate ratio triggers', () => {
  const thinking = Array.from({ length: 10 }, () => 'The same sentence repeated over and over.').join(' ');
  const res = detectRepetition(thinking);
  assert.equal(res.isRepeating, true);
  assert.ok(res.repeatScore >= 0.35);
});

test('dedupe keeps first two occurrences', () => {
  const thinking =
    'I need to read the file. Unique intro. I need to read the file. Unique middle. I need to read the file. Unique outro.';
  const deduped = dedupeThinking(thinking);
  // Should contain at most 2 copies of the repeated sentence
  const count = (deduped.match(/I need to read the file/g) ?? []).length;
  assert.ok(count <= 2, `expected <=2, got ${count}`);
  assert.match(deduped, /repeated sentence\(s\) hidden/);
});

test('too-long thinking is flagged', () => {
  const thinking = 'a'.repeat(13_000);
  const res = detectRepetition(thinking);
  assert.equal(res.isTooLong, true);
  assert.equal(res.isRepeating, true); // too long counts as needing attention
});

test('ThinkingMonitor suppresses duplicate deltas after threshold', () => {
  const monitor = new ThinkingMonitor({ minSentences: 4, duplicateThreshold: 3, maxChars: 12000 });
  monitor.reset();
  // Feed non-repeating deltas — all should emit
  let res = monitor.add('Let me look at the project layout thoroughly. ');
  assert.equal(res.shouldEmit, true);
  res = monitor.add('I will list the files now to understand the structure. ');
  assert.equal(res.shouldEmit, true);

  // Feed repeating sentence many times to exceed 400-char analysis threshold
  for (let i = 0; i < 20; i++) {
    res = monitor.add('I need to read the file to verify its contents properly. ');
  }
  // After sufficient history, monitor should flag repeating
  const state = monitor.snapshot();
  // May be flagged as repeating or at least have many sentences
  assert.ok(state.totalSentences >= 6, `should have many sentences, got ${state.totalSentences}`);
  // Force final analysis
  const analysis = monitor.analyse();
  assert.ok(analysis.isRepeating, `expected repeating, got ${JSON.stringify(analysis)}`);
});

test('monitor emits notice only once per block', () => {
  const monitor = new ThinkingMonitor({ minSentences: 3, duplicateThreshold: 2, repeatScoreThreshold: 0.2 });
  monitor.reset();
  const deltas = [
    'Hello world. ',
    'Hello world. ',
    'Hello world. ',
    'Another sentence here. ',
    'Hello world. ',
  ];
  let notices = 0;
  for (const d of deltas) {
    const r = monitor.add(d);
    if (r.notice) notices++;
  }
  // Should emit at most once for repeating, plus maybe for tooLong, but not per delta
  assert.ok(notices <= 2, `notices ${notices} should be <=2`);
});
