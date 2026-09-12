import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createOps } from '../ops.mjs';
import { resolveConfig } from '../config.mjs';
import { SpawnRegistry } from '../registry.mjs';
import { buildFamily, createFamilyQueries } from '../family.mjs';
const caller = { sessionId: 'task-bridge-external' };
const event = (seq, type = 'assistant/message') => ({ seq, type, time: seq,
  data: type === 'assistant/message' ? { message: { id: `m-${seq}`, content: [{ type: 'text', text: `reply-${seq}` }] } } :
    { id: `m-${seq}`, content: [{ type: 'text', text: '[reference: original]\nmessage' }] } });
function harness(events = []) {
  const rows = [{ sessionId: 's', running: true }];
  const reads = [];
  const agent = { status: 'running', inbox: { nextTurn: [], nextStep: [] },
    session: { seq: events.length, snapshotEvents: (from, to) => { reads.push({ from, to }); return events.slice(from, to); } } };
  const agents = new Map([['s', agent]]);
  const sessionController = { list: async () => ({ items: rows }) };
  return { rows, reads, agent, agents, sessionController,
    ops: createOps({ agents, sessionController, config: resolveConfig({ progressTailMessages: 2 }) }) };
}
test('wait rejects missing/self/subagent and unobservable-running targets, accepts actual cold idle', async () => {
  const h = harness();
  assert.equal((await h.ops.waitFor({ sessionId: 'missing' }, caller)).code, 'target-not-found');
  h.rows.push({ sessionId: caller.sessionId }, { sessionId: 'sub', origin: 'subagent' }, { sessionId: 'cold' });
  assert.equal((await h.ops.waitFor({ sessionId: caller.sessionId }, caller)).code, 'self-send-denied');
  assert.equal((await h.ops.waitFor({ sessionId: 'sub' }, caller)).code, 'subagent-target-denied');
  assert.equal((await h.ops.waitFor({ sessionId: 'cold' }, caller)).targets[0].agentState, 'cold-idle');
  h.agents.clear();
  assert.equal((await h.ops.waitFor({ sessionId: 's' }, caller)).code, 'wait-failed');
  h.sessionController.list = async () => { throw new Error('offline'); };
  assert.equal((await h.ops.waitFor({ sessionId: 's' }, caller)).code, 'wait-failed');
});
test('progress cursor reads only new messages, keeps IDs, and distinguishes queued/observed/unknown', async () => {
  const events = [event(0, 'user/message'), event(1)];
  const h = harness(events);
  h.agent.inbox.nextTurn.push({ id: 'queued', content: [] });
  const first = await h.ops.progress('s', caller, undefined, { messageId: 'queued' });
  assert.equal(first.consumption.state, 'queued');
  assert.equal(first.feedback.messages[0].reference, 'original');
  assert.equal(first.feedback.messages[0].messageId, 'm-0');
  assert.equal((await h.ops.progress('s', caller, undefined, { messageId: 'm-0' })).consumption.state, 'observed');
  assert.equal((await h.ops.progress('s', caller, undefined, { messageId: 'absent' })).consumption.state, 'unknown');
  events.push(event(2), event(3), event(4)); h.agent.session.seq = events.length;
  const second = await h.ops.progress('s', caller, undefined, { cursor: first.feedback.nextCursor });
  assert.deepEqual(second.recent, []);
  assert.deepEqual(second.feedback.messages.map(m => m.seq), [2, 3]);
  assert.equal(second.feedback.hasMore, true);
  const third = await h.ops.progress('s', caller, undefined, { cursor: second.feedback.nextCursor });
  assert.deepEqual(third.feedback.messages.map(m => m.seq), [4]);
  assert.equal(third.feedback.hasMore, false);
  const unchanged = await h.ops.progress('s', caller, undefined, { cursor: third.feedback.nextCursor });
  assert.deepEqual(unchanged.feedback.messages, []);
  assert.equal(unchanged.feedback.nextCursor, third.feedback.nextCursor);
  assert.ok(h.reads.every(r => r.to - r.from <= 400));
  assert.equal((await h.ops.progress('s', caller, undefined, { cursor: 'bad' })).code, 'bad-request');
  h.rows.push({ sessionId: 'other' });
  assert.equal((await h.ops.progress('other', caller, undefined, { cursor: first.feedback.nextCursor })).code, 'bad-request');
  h.agent.session.snapshotEvents = () => { throw new Error(); };
  assert.equal((await h.ops.progress('s', caller)).feedback.coverage, 'unavailable');
});
test('external families isolate refs and unknown origins; bounded receipt history survives reload without private data', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bridge-registry-'));
  const path = join(dir, 'registry.json');
  const registry = new SpawnRegistry(path);
  for (const [id, ref] of [['a', 'PRIVATE-A'], ['b', 'PRIVATE-B'], ['same', 'PRIVATE-A'], ['old1'], ['old2']]) {
    registry.record(id, { parentSessionId: caller.sessionId, depth: 1, externalRef: ref, team: 'shared', promptExcerpt: 'SECRET' });
  }
  registry.record('child', { parentSessionId: 'a', depth: 2 });
  for (let i = 0; i < 105; i++) assert.equal(registry.recordBridgeReceipt('a', { kind: i === 0 ? 'spawn' : 'send', time: i,
    messageId: `m-${i}`, mode: 'steer', delivered: true, text: 'SECRET' }), true);
  assert.equal(registry.recordBridgeReceipt('unregistered', { kind: 'send', time: 1 }), false);
  const loaded = new SpawnRegistry(path);
  const snapshot = loaded.snapshot();
  assert.doesNotMatch(JSON.stringify(snapshot), /PRIVATE|SECRET|externalRef|promptExcerpt/);
  const ids = new Set(['a','b','same','old1','old2','child']);
  const family = buildFamily(snapshot, 'child', ids);
  assert.equal(family.nodes[0].kind, 'external');
  assert.deepEqual(family.nodes.filter(n => n.available).map(n => n.sessionId).sort(), ['a','child','same']);
  assert.notEqual(buildFamily(snapshot, 'old1', ids).rootSessionId, buildFamily(snapshot, 'old2', ids).rootSessionId);
  assert.equal(buildFamily(snapshot, 'old1', ids).nodes[0].association, 'unknown');
  const queries = createFamilyQueries({ registry: loaded, sessionController: { list: async () => [...ids].map(sessionId => ({ sessionId })) } });
  const history = await queries.history('same', 'a');
  assert.equal(history.source, 'bridge-receipts');
  assert.equal(history.events.length, 30);
  assert.equal(history.coverage, 'partial');
  assert.equal(history.events.at(-1).seq, 105);
  const older = await queries.history('same', 'a', history.nextCursor);
  assert.ok(older.events.at(-1).seq < history.events[0].seq);
  assert.equal((await queries.history('same', 'b')).code, 'target-not-in-family');
  assert.equal((await queries.history('old1', 'old1')).ok, true);
});
