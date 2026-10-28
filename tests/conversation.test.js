'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./load');
load('util');
load('attach');
const C = load('conversation');

const MODELS = [{ id: 'a/one', name: 'One' }, { id: 'b/two', name: 'Two' }];

function finish(turn, laneId, content, status = 'done') {
  Object.assign(turn.responses[laneId], { status, content });
}

function twoLaneConv() {
  const conv = C.create(MODELS, 1000);
  const [A, B] = conv.lanes.map((l) => l.id);
  return { conv, A, B };
}

test('create builds lanes and empty turns', () => {
  const { conv } = twoLaneConv();
  assert.match(conv.id, /^c_/);
  assert.equal(conv.title, 'New chat');
  assert.deepEqual(conv.lanes.map((l) => [l.modelId, l.modelName, l.active, l.joinedAtTurn]), [['a/one', 'One', true, 0], ['b/two', 'Two', true, 0]]);
  assert.deepEqual(conv.turns, []);
});

test('addTurn creates streaming responses and derives title', () => {
  const { conv, A, B } = twoLaneConv();
  const long = 'Plan a trip to Japan for five days with a focus on food and also some temples\nsecond line';
  const t = C.addTurn(conv, 'broadcast', C.broadcastInputs(conv, long));
  assert.equal(t.index, 0);
  assert.deepEqual(Object.keys(t.responses).sort(), [A, B].sort());
  assert.equal(t.responses[A].status, 'streaming');
  assert.deepEqual(t.responses[A].previous, []);
  assert.equal(conv.title, long.split('\n')[0].slice(0, 60).trim());
  assert.ok(conv.title.length <= 60);
});

test('broadcastInputs skips inactive lanes', () => {
  const { conv, A, B } = twoLaneConv();
  C.removeLane(conv, B);
  assert.deepEqual(C.broadcastInputs(conv, 'hi'), { [A]: 'hi' });
});

test('buildMessages skips turns a lane was not asked', () => {
  const { conv, A, B } = twoLaneConv();
  const t0 = C.addTurn(conv, 'broadcast', C.broadcastInputs(conv, 'q1'));
  finish(t0, A, 'a1'); finish(t0, B, 'b1');
  const t1 = C.addTurn(conv, 'targeted', { [B]: 'only B' });
  finish(t1, B, 'b2');
  assert.deepEqual(C.buildMessages(conv, A, 1), [{ role: 'user', content: 'q1' }, { role: 'assistant', content: 'a1' }]);
  assert.deepEqual(C.buildMessages(conv, B, 1).map((m) => m.content), ['q1', 'b1', 'only B'], 'the requested turn contributes only its user message');
});

test('buildMessages upto index excludes later turns; clarify-batch uses per-lane input', () => {
  const { conv, A, B } = twoLaneConv();
  const t0 = C.addTurn(conv, 'broadcast', C.broadcastInputs(conv, 'q'));
  finish(t0, A, 'which month?'); finish(t0, B, 'budget?');
  C.addTurn(conv, 'clarify-batch', { [A]: 'April', [B]: '$2000' });
  const a = C.buildMessages(conv, A, 1);
  assert.equal(a[a.length - 1].content, 'April');
  const b = C.buildMessages(conv, B, 1);
  assert.equal(b[b.length - 1].content, '$2000');
  assert.equal(C.buildMessages(conv, A, 0).length, 1);
});

test('buildMessages: error response yields user message only; stopped keeps assistant', () => {
  const { conv, A, B } = twoLaneConv();
  const t0 = C.addTurn(conv, 'broadcast', C.broadcastInputs(conv, 'q'));
  finish(t0, A, 'oops', 'error'); finish(t0, B, 'half', 'stopped');
  C.addTurn(conv, 'broadcast', C.broadcastInputs(conv, 'q2'));
  assert.deepEqual(C.buildMessages(conv, A, 1).map((m) => m.role), ['user', 'user']);
  assert.deepEqual(C.buildMessages(conv, B, 1).map((m) => m.role), ['user', 'assistant', 'user']);
});

test('addLane seeds late joiner with TL;DRs, or prior inputs when none', () => {
  const { conv, A, B } = twoLaneConv();
  const t0 = C.addTurn(conv, 'broadcast', C.broadcastInputs(conv, 'first q'));
  finish(t0, A, 'x'); finish(t0, B, 'y');
  const plain = C.addLane(conv, { id: 'c/three', name: 'Three' });
  assert.equal(plain.joinedAtTurn, 1);
  assert.match(plain.seedContext, /^Context from the conversation so far \(you joined late\):\n/);
  assert.match(plain.seedContext, /User: first q/);
  t0.tldr = { status: 'done', content: '- both said hi' };
  const seeded = C.addLane(conv, { id: 'd/four', name: 'Four' });
  assert.match(seeded.seedContext, /both said hi/);
  C.addTurn(conv, 'broadcast', C.broadcastInputs(conv, 'next'));
  const msgs = C.buildMessages(conv, seeded.id, 1);
  assert.equal(msgs[0].role, 'system');
  assert.deepEqual(msgs.slice(1), [{ role: 'user', content: 'next' }]);
});

test('beginRetry moves content to previous and resets', () => {
  const { conv, A } = twoLaneConv();
  const t0 = C.addTurn(conv, 'broadcast', C.broadcastInputs(conv, 'q'));
  finish(t0, A, 'v1');
  t0.responses[A].usage = { cost: 1 };
  C.beginRetry(conv, t0.id, A);
  const r = t0.responses[A];
  assert.equal(r.status, 'streaming');
  assert.equal(r.content, '');
  assert.equal(r.previous.length, 1);
  assert.equal(r.previous[0].content, 'v1');
  assert.deepEqual(r.previous[0].usage, { cost: 1 });
});

test('fork copies up to turn, sets lineage, original untouched', () => {
  const { conv, A, B } = twoLaneConv();
  const t0 = C.addTurn(conv, 'broadcast', C.broadcastInputs(conv, 'q'));
  finish(t0, A, 'a'); finish(t0, B, 'b');
  t0.tldr = { status: 'done', content: 'sum' };
  const t1 = C.addTurn(conv, 'broadcast', C.broadcastInputs(conv, 'q2'));
  finish(t1, A, 'a2'); finish(t1, B, 'b2');
  const f = C.fork(conv, 0);
  assert.notEqual(f.id, conv.id);
  assert.equal(f.parentId, conv.id);
  assert.equal(f.forkedAtTurn, 0);
  assert.equal(f.turns.length, 1);
  assert.equal(f.title, '↳ ' + conv.title);
  assert.equal(f.turns[0].tldr.content, 'sum');
  f.turns[0].responses[A].content = 'changed';
  assert.equal(conv.turns[0].responses[A].content, 'a');
  assert.equal(conv.turns.length, 2);
});

test('fork with onlyLaneId keeps one lane and drops fusion', () => {
  const { conv, A, B } = twoLaneConv();
  const t0 = C.addTurn(conv, 'broadcast', C.broadcastInputs(conv, 'q'));
  finish(t0, A, 'a'); finish(t0, B, 'b');
  t0.fusion = { status: 'done', data: {} };
  const t1 = C.addTurn(conv, 'targeted', { [B]: 'b only' });
  finish(t1, B, 'b2');
  const f = C.fork(conv, 1, { onlyLaneId: A });
  assert.deepEqual(f.lanes.map((l) => l.id), [A]);
  assert.deepEqual(Object.keys(f.turns[0].inputs), [A]);
  assert.deepEqual(Object.keys(f.turns[0].responses), [A]);
  assert.equal(f.turns[0].fusion, undefined);
  assert.equal(f.turns.length, 1, 'turns with nothing left for the lane are dropped');
});

test('recoverInterrupted marks streaming as stopped, keeps content', () => {
  const { conv, A, B } = twoLaneConv();
  const t0 = C.addTurn(conv, 'broadcast', C.broadcastInputs(conv, 'q'));
  t0.responses[A].content = 'half';
  finish(t0, B, 'done');
  t0.tldr = { status: 'streaming', content: 'x' };
  assert.equal(C.recoverInterrupted(conv), true);
  assert.equal(t0.responses[A].status, 'stopped');
  assert.equal(t0.responses[A].content, 'half');
  assert.equal(t0.responses[B].status, 'done');
  assert.equal(t0.tldr.status, 'error');
  assert.equal(t0.tldr.error, 'Interrupted');
  assert.equal(C.recoverInterrupted(conv), false);
});

test('answeredLanes lists done/stopped non-empty responses', () => {
  const { conv, A, B } = twoLaneConv();
  const t0 = C.addTurn(conv, 'broadcast', C.broadcastInputs(conv, 'q'));
  finish(t0, A, 'yes'); finish(t0, B, '', 'stopped');
  assert.deepEqual(C.answeredLanes(t0), [A]);
});

test('laneById finds a lane', () => {
  const { conv, A } = twoLaneConv();
  assert.equal(C.laneById(conv, A).modelId, 'a/one');
});

test('fork of a streaming turn gets new turn ids and no streaming responses', () => {
  const { conv, A, B } = twoLaneConv();
  const t0 = C.addTurn(conv, 'broadcast', C.broadcastInputs(conv, 'q'));
  t0.responses[A].content = 'partial';
  finish(t0, B, 'done');
  const f = C.fork(conv, 0);
  assert.notEqual(f.turns[0].id, t0.id);
  assert.equal(f.turns[0].responses[A].status, 'stopped');
  assert.equal(f.turns[0].responses[A].content, 'partial');
  assert.equal(t0.responses[A].status, 'streaming', 'original untouched');
});

test('system prompt first, then seed context', () => {
  const { conv, A, B } = twoLaneConv();
  C.setSystemPrompt(conv, 'Be brief', 'p1');
  assert.equal(conv.presetId, 'p1');
  const t0 = C.addTurn(conv, 'broadcast', C.broadcastInputs(conv, 'q'));
  finish(t0, A, 'a'); finish(t0, B, 'b');
  const late = C.addLane(conv, { id: 'c/three', name: 'Three' });
  C.addTurn(conv, 'broadcast', C.broadcastInputs(conv, 'q2'));
  const msgs = C.buildMessages(conv, late.id, 1);
  assert.deepEqual(msgs.slice(0, 2).map((m) => m.role), ['system', 'system']);
  assert.equal(msgs[0].content, 'Be brief');
  assert.match(msgs[1].content, /joined late/);
});

test('mid-chat change applies from next turn', () => {
  const { conv, A, B } = twoLaneConv();
  C.setSystemPrompt(conv, 'A');
  for (const q of ['q0', 'q1']) {
    const t = C.addTurn(conv, 'broadcast', C.broadcastInputs(conv, q));
    finish(t, A, 'x'); finish(t, B, 'y');
  }
  C.setSystemPrompt(conv, 'B');
  assert.equal(C.promptAt(conv, 0), 'A');
  assert.equal(C.promptAt(conv, 1), 'A');
  assert.equal(C.promptAt(conv, 2), 'B');
  assert.equal(C.buildMessages(conv, A, 1)[0].content, 'A');
  C.addTurn(conv, 'broadcast', C.broadcastInputs(conv, 'q2'));
  const m = C.buildMessages(conv, A, 2);
  assert.equal(m[0].content, 'B');
  assert.equal(m.filter((x) => x.role === 'system').length, 1);
});

test('setting a prompt before any turn overwrites without history', () => {
  const { conv } = twoLaneConv();
  C.setSystemPrompt(conv, 'one');
  C.setSystemPrompt(conv, 'two');
  assert.equal(C.promptAt(conv, 0), 'two');
  assert.deepEqual(conv.systemPromptHistory || [], []);
});

test('clearing removes prompt for later turns only', () => {
  const { conv, A, B } = twoLaneConv();
  C.setSystemPrompt(conv, 'A', 'p1');
  const t = C.addTurn(conv, 'broadcast', C.broadcastInputs(conv, 'q'));
  finish(t, A, 'x'); finish(t, B, 'y');
  C.setSystemPrompt(conv, '');
  assert.equal(conv.systemPrompt, undefined);
  assert.equal(conv.presetId, undefined);
  assert.equal(C.promptAt(conv, 0), 'A');
  assert.equal(C.promptAt(conv, 1), null);
  C.addTurn(conv, 'broadcast', C.broadcastInputs(conv, 'q1'));
  assert.equal(C.buildMessages(conv, A, 1)[0].role, 'user');
});

test('fork keeps system prompt and history', () => {
  const { conv, A, B } = twoLaneConv();
  C.setSystemPrompt(conv, 'A', 'p1');
  const t = C.addTurn(conv, 'broadcast', C.broadcastInputs(conv, 'q'));
  finish(t, A, 'x'); finish(t, B, 'y');
  C.setSystemPrompt(conv, 'B', 'p2');
  const f = C.fork(conv, 0);
  assert.equal(f.systemPrompt, 'B');
  assert.equal(f.presetId, 'p2');
  assert.equal(C.promptAt(f, 0), 'A');
});

const IMG = { id: 'i1', kind: 'image', name: 'tiny.png', mime: 'image/png', size: 1 };
const PDF = { id: 'p1', kind: 'pdf', name: 'doc.pdf', mime: 'application/pdf', size: 2 };
const urls = { i1: 'data:image/png;base64,AA', p1: 'data:application/pdf;base64,BB' };
const resolve = (id) => urls[id] || null;

test('full turn builds content parts', () => {
  const { conv, A } = twoLaneConv();
  C.addTurn(conv, 'broadcast', C.broadcastInputs(conv, 'Look'), { attachments: [IMG, PDF], delivery: { [A]: 'full' } });
  const m = C.buildMessages(conv, A, 0, resolve);
  assert.deepEqual(m[0].content, [
    { type: 'text', text: 'Look' },
    { type: 'image_url', image_url: { url: urls.i1 } },
    { type: 'file', file: { filename: 'doc.pdf', file_data: urls.p1 } },
  ]);
});

test('empty text with image omits text part', () => {
  const { conv, A } = twoLaneConv();
  C.addTurn(conv, 'broadcast', { [A]: '' }, { attachments: [IMG], delivery: { [A]: 'full' } });
  assert.deepEqual(C.buildMessages(conv, A, 0, resolve)[0].content, [{ type: 'image_url', image_url: { url: urls.i1 } }]);
});

test('text-delivered turn stays a string', () => {
  const { conv, A, B } = twoLaneConv();
  C.addTurn(conv, 'broadcast', { [A]: 'Look', [B]: 'Look\n\n[image omitted: tiny.png]' }, { attachments: [IMG], delivery: { [A]: 'full', [B]: 'text' } });
  assert.equal(C.buildMessages(conv, B, 0, resolve)[0].content, 'Look\n\n[image omitted: tiny.png]');
});

test('history re-sends earlier images', () => {
  const { conv, A } = twoLaneConv();
  const t0 = C.addTurn(conv, 'broadcast', { [A]: 'Look' }, { attachments: [IMG], delivery: { [A]: 'full' } });
  finish(t0, A, 'A cat');
  C.addTurn(conv, 'targeted', { [A]: 'What colour?' });
  const m = C.buildMessages(conv, A, 1, resolve);
  assert.deepEqual(m[0].content[1], { type: 'image_url', image_url: { url: urls.i1 } });
  assert.equal(m[2].content, 'What colour?');
});

test('missing record becomes unavailable text', () => {
  const { conv, A } = twoLaneConv();
  C.addTurn(conv, 'broadcast', { [A]: 'Look' }, { attachments: [IMG], delivery: { [A]: 'full' } });
  assert.deepEqual(C.buildMessages(conv, A, 0)[0].content[1], { type: 'text', text: '[attachment unavailable: tiny.png]' });
});

test('addTurn stores extra fields only when present', () => {
  const { conv, A, B } = twoLaneConv();
  const plain = C.addTurn(conv, 'broadcast', { [A]: 'x' });
  assert.equal('attachments' in plain, false);
  const t = C.addTurn(conv, 'broadcast', { [A]: 'x' }, { attachments: [IMG], delivery: { [A]: 'full' }, skipped: { [B]: "can't read images" } });
  assert.deepEqual(t.skipped, { [B]: "can't read images" });
  assert.equal(B in t.responses, false);
});

test('attachmentIdsFor drops images for text delivery and skips lanes not asked', () => {
  const { conv, A, B } = twoLaneConv();
  C.addTurn(conv, 'broadcast', { [A]: 'x', [B]: 'x [image omitted]' }, { attachments: [IMG, PDF], delivery: { [A]: 'full', [B]: 'text' } });
  C.addTurn(conv, 'targeted', { [A]: 'y' }, { attachments: [{ id: 'i2', kind: 'image', name: 'b.png' }, { id: 't1', kind: 'text', name: 'n.md' }], delivery: { [A]: 'full' } });
  assert.deepEqual(C.attachmentIdsFor(conv, A, 1), ['i1', 'p1', 'i2']);
  assert.deepEqual(C.attachmentIdsFor(conv, A, 0), ['i1', 'p1']);
  assert.deepEqual(C.attachmentIdsFor(conv, B, 1), ['p1']);
});

test('text-only lanes still receive PDFs, just not images', () => {
  const { conv, A, B } = twoLaneConv();
  C.addTurn(conv, 'broadcast', { [A]: 'Look', [B]: 'Look\n\n[image omitted: tiny.png]' }, { attachments: [IMG, PDF], delivery: { [A]: 'full', [B]: 'text' } });
  assert.deepEqual(C.buildMessages(conv, B, 0, resolve)[0].content, [
    { type: 'text', text: 'Look\n\n[image omitted: tiny.png]' },
    { type: 'file', file: { filename: 'doc.pdf', file_data: urls.p1 } },
  ]);
  assert.deepEqual(C.attachmentIdsFor(conv, B, 0), ['p1']);
});

test('addTurn stores route', () => {
  const { conv, A } = twoLaneConv();
  const route = { mode: 'auto', picks: [{ modelId: 'a/one', p: 0.6 }] };
  const t = C.addTurn(conv, 'broadcast', { [A]: 'hi' }, { route });
  assert.deepEqual(t.route, route);
  assert.notEqual(t.route, route);
  assert.notEqual(t.route.picks, route.picks);
  assert.equal('route' in C.addTurn(conv, 'broadcast', { [A]: 'x' }), false);
});

test('ensureLanes reactivates and never duplicates', () => {
  const c = C.create([{ id: 'a/one', name: 'One' }, { id: 'b/two', name: 'Two' }]);
  C.removeLane(c, c.lanes[1].id);
  const ids = C.ensureLanes(c, [{ id: 'b/two', name: 'Two' }, { id: 'c/three', name: 'Three' }, { id: 'a/one', name: 'One' }]);
  assert.equal(c.lanes.length, 3);
  assert.equal(c.lanes[1].active, true);
  assert.deepEqual(ids, [c.lanes[1].id, c.lanes[2].id, c.lanes[0].id]);
  assert.equal(c.lanes[2].modelId, 'c/three');
});

test('ensureLanes late joiner gets seed context', () => {
  const { conv, A } = twoLaneConv();
  C.addTurn(conv, 'broadcast', { [A]: 'first question' });
  const [id] = C.ensureLanes(conv, [{ id: 'c/three', name: 'Three' }]);
  const lane = C.laneById(conv, id);
  assert.equal(lane.joinedAtTurn, 1);
  assert.match(lane.seedContext, /first question/);
});

test('fork keeps route and judge on copied turns', () => {
  const { conv, A } = twoLaneConv();
  const t = C.addTurn(conv, 'broadcast', { [A]: 'hi' });
  finish(t, A, 'ok');
  t.route = { mode: 'auto', picks: [{ modelId: 'a/one', p: 1 }] };
  t.judge = { status: 'done', winner: A };
  const f = C.fork(conv, 0);
  assert.deepEqual(f.turns[0].route, t.route);
  assert.deepEqual(f.turns[0].judge, t.judge);
  assert.notEqual(f.turns[0].route, t.route);
  assert.notEqual(f.turns[0].judge, t.judge);
});

test('recoverInterrupted marks a streaming judge as interrupted', () => {
  const { conv, A } = twoLaneConv();
  const t = C.addTurn(conv, 'broadcast', { [A]: 'hi' });
  finish(t, A, 'ok');
  t.judge = { status: 'streaming' };
  assert.equal(C.recoverInterrupted(conv), true);
  assert.equal(t.judge.status, 'error');
  assert.equal(t.judge.error, 'Interrupted');
});
