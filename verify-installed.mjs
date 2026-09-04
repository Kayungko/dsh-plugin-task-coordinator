/**
 * Integration verification for the installed plugin copy.
 * Runs under plain node from the INSTALLED profile location, importing the
 * real @deepseek-ai/dsh-tools and @deepseek-ai/dsh-llm host packages plus the
 * plugin entry, then executes apply() against a mock cordis ctx and exercises
 * every registered tool end-to-end.
 *
 * Usage: node verify-installed.mjs  (from the installed plugin directory)
 */

import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);

// 1. dependency resolution from the installed location
const toolsPath = require.resolve('@deepseek-ai/dsh-tools');
const llmPath = require.resolve('@deepseek-ai/dsh-llm');
const skillFsPath = require.resolve('@deepseek-ai/dsh-skill-filesystem');
console.log('resolved dsh-tools :', toolsPath);
console.log('resolved dsh-llm   :', llmPath);
console.log('resolved skill-fs  :', skillFsPath);

// 2. import the real host packages and the plugin entry
const { defineTool } = await import('@deepseek-ai/dsh-tools');
const { createUserMessage } = await import('@deepseek-ai/dsh-llm');
assert.equal(typeof defineTool, 'function', 'defineTool export missing');
assert.equal(typeof createUserMessage, 'function', 'createUserMessage export missing');
const plugin = await import('./index.mjs');
assert.equal(typeof plugin.apply, 'function');
assert.deepEqual(plugin.inject, ['agents', 'tools', 'sessionController', 'commands']);

// 3. mock cordis ctx with a believable session universe
const sessions = new Map();
const liveAgents = new Map();
const registrations = [];
const calls = [];
let createCount = 0;

sessions.set('session-super', {
  sessionId: 'session-super',
  updatedAt: Date.now(),
  running: true,
  blank: false,
  cwd: '/proj',
  projections: { asOfSeq: 1, values: { title: 'Supervisor' } },
});

sessions.set('session-worker', {
  sessionId: 'session-worker',
  updatedAt: Date.now(),
  running: true,
  blank: false,
  cwd: '/proj',
  projections: { asOfSeq: 3, values: { title: 'Worker task', todos: [{ content: 'a', status: 'completed' }, { content: 'b', status: 'pending' }] } },
});

liveAgents.set('session-worker', {
  id: 'session-worker',
  status: 'idle',
  delivered: [],
  followup(message) { this.delivered.push({ via: 'followup', message }); },
  steer(message) { this.delivered.push({ via: 'steer', message }); },
  whenIdle() { return Promise.resolve(); },
  inbox: { nextTurn: [], nextStep: [] },
  session: {
    id: 'session-worker',
    seq: 3,
    header: { id: 'session-worker', cwd: '/proj' },
    events: [
      { type: 'user/message', seq: 1, time: 1, data: { content: [{ type: 'text', text: 'kickoff' }], source: { kind: 'user' } } },
      { type: 'assistant/message', seq: 2, time: 2, data: { message: { content: [{ type: 'text', text: 'working on it' }] } } },
    ],
  },
});

const ctx = {
  logger: { info: (message) => console.log('[plugin]', message), warn: (message) => console.log('[plugin][warn]', message) },
  provides: {},
  effects: [],
  mountedPlugins: [],
  commandRegistrations: [],
  provide(key, value) { this.provides[key] = value; },
  effect(factory) { this.effects.push(factory); },
  plugin(pluginModule, config) {
    this.mountedPlugins.push([pluginModule, config]);
    return () => {};
  },
  commands: {
    register(definition) {
      this.commandRegistrations ??= [];
      ctx.commandRegistrations.push(definition);
      return () => ctx.commandRegistrations.splice(ctx.commandRegistrations.indexOf(definition), 1);
    },
  },
  // user-questions seam stand-in: auto-approve the first (approve) option,
  // mirroring the real ctx.get('userQuestions').ask() contract shape.
  get(name) {
    if (name !== 'userQuestions') return undefined;
    return {
      async ask(request) {
        return {
          answers: request.questions.map((question) => ({
            id: question.id,
            selected: [question.options[0].label],
          })),
        };
      },
    };
  },
  tools: {
    register(definition) {
      registrations.push(definition);
      return () => registrations.splice(registrations.indexOf(definition), 1);
    },
  },
  sessionController: {
    async list() { calls.push('list'); return { items: [...sessions.values()] }; },
    async create(request) {
      calls.push('create');
      createCount += 1;
      const id = request.sessionId ?? `session-spawned-${createCount}`;
      sessions.set(id, { sessionId: id, updatedAt: Date.now(), running: false, blank: true, cwd: request.cwd, projections: { asOfSeq: 0, values: {} } });
      return { sessionId: id };
    },
    async rename(request) {
      calls.push('rename');
      sessions.get(request.sessionId).projections.values.title = request.title;
      return { title: request.title, seq: 1 };
    },
    async prompt(request, signal) {
      // mirror the real Remote facade: signal is dereferenced unconditionally
      signal.throwIfAborted();
      calls.push('prompt');
      const row = sessions.get(request.sessionId);
      if (row) row.kickoffPrompt = request.content?.[0]?.text;
      return { accepted: true };
    },
    async cancel(request) { calls.push('cancel'); return { accepted: true }; },
    async resolveAgent(sessionId) {
      calls.push('resolve');
      const agent = liveAgents.get(sessionId);
      return agent ? { agent } : { error: { code: 'session-not-found', message: 'no' } };
    },
    async inspect(sessionId) { calls.push('inspect'); return { meta: { id: sessionId }, events: [] }; },
  },
  agents: { get: (id) => liveAgents.get(id) },
};

// 4. apply the plugin for real (with the real defineTool compiling schemas)
// minSendIntervalMs: 0 so back-to-back verification sends are not rate limited;
// registryFile: temp dir so the user's real registry is untouched.
const verifyDir = mkdtempSync(join(tmpdir(), 'task-coord-verify-'));
const registryFile = join(verifyDir, 'registry.json');
plugin.apply(ctx, { minSendIntervalMs: 0, registryFile });
assert.equal(registrations.length, 8, `expected 8 tools, got ${registrations.length}`);
assert.equal(ctx.commandRegistrations.length, 1, 'expected the /tasks command');
assert.equal(ctx.commandRegistrations[0].name, 'tasks');
assert.ok(ctx.provides.taskCoordinator, 'taskCoordinator service not provided');
assert.equal(ctx.provides.taskCoordinator.version, '0.7.0');
// the skill mount is fire-and-forget (dynamic import); give it a macrotask
await new Promise((resolve) => setImmediate(resolve));
assert.equal(ctx.mountedPlugins.length, 1, 'expected the skill provider mount');
const [skillPluginModule, skillConfig] = ctx.mountedPlugins[0];
assert.equal(skillPluginModule.name, 'skill-filesystem');
assert.equal(skillConfig.providerName, 'task-coordinator');
assert.equal(skillConfig.includeDefaultRoots, false);
assert.equal(skillConfig.customSkillDirs.length, 1);
const skillFile = join(skillConfig.customSkillDirs[0], 'task-coordination', 'SKILL.md');
assert.ok(existsSync(skillFile), `bundled skill missing: ${skillFile}`);
const skillBody = readFileSync(skillFile, 'utf8');
assert.match(skillBody, /^---\r?\nname: task-coordination/m);
assert.match(skillBody, /description:/);
console.log('skill mount        : OK ->', skillConfig.providerName, '@', skillConfig.customSkillDirs[0]);
const byName = Object.fromEntries(registrations.map((tool) => [tool.name, tool]));
console.log('registered tools   :', registrations.map((tool) => tool.name).join(', '));

const supervisorExec = { agent: { id: 'session-super', session: { header: { cwd: '/proj' } } } };

// 5. exercise each tool through the real definitions
const listResult = await byName.task_list.execute({}, supervisorExec);
assert.equal(listResult.ok, true);
const workerRow = listResult.tasks.find((task) => task.sessionId === 'session-worker');
assert.ok(workerRow, 'worker task missing from list');
console.log('task_list          : OK ->', workerRow.title, '/', workerRow.status);

const progressResult = await byName.task_progress.execute({ sessionId: 'session-worker' }, supervisorExec);
assert.equal(progressResult.ok, true);
assert.equal(progressResult.agentState, 'idle');
assert.equal(progressResult.recent.length, 2);
console.log('task_progress      : OK ->', progressResult.recent.at(-1).text);

const sendResult = await byName.task_send.execute({ sessionId: 'session-worker', message: 'please also cover edge cases' }, supervisorExec);
assert.equal(sendResult.ok, true);
assert.ok(typeof sendResult.messageId === 'string' && sendResult.messageId.length > 0, 'messageId missing');
const delivered = liveAgents.get('session-worker').delivered.at(-1);
assert.equal(delivered.via, 'followup');
assert.equal(delivered.message.source.kind, 'coordinator');
assert.equal(delivered.message.source.senderSessionId, 'session-super');
console.log('task_send          : OK -> coordinator message delivered, messageId:', sendResult.messageId);

const refResult = await byName.task_send.execute({ sessionId: 'session-worker', message: '改成方案 B', reference: sendResult.messageId }, supervisorExec);
assert.equal(refResult.ok, true);
assert.equal(refResult.reference, sendResult.messageId);
const refDelivered = liveAgents.get('session-worker').delivered.at(-1);
assert.ok(refDelivered.message.content[0].text.startsWith(`[reference: ${sendResult.messageId}]`), 'reference annotation missing');
console.log('task_send (ref)    : OK -> reference quoted visibly');

const steerResult = await byName.task_send.execute({ sessionId: 'session-worker', message: 'keep api stable', mode: 'steer' }, supervisorExec);
assert.equal(steerResult.ok, true);
assert.equal(liveAgents.get('session-worker').delivered.at(-1).via, 'steer');
console.log('task_send (steer)  : OK');

const selfResult = await byName.task_send.execute({ sessionId: 'session-super', message: 'loop?' }, supervisorExec);
assert.equal(selfResult.ok, false);
assert.equal(selfResult.code, 'self-send-denied');
assert.match(selfResult.error, /itself/);
console.log('self-guard         : OK ->', selfResult.code, '/', selfResult.error);

const spawnResult = await byName.task_spawn.execute({ prompt: 'run the regression suite', title: '修复｜回归套件', team: '验证编组' }, supervisorExec);
assert.equal(spawnResult.ok, true);
assert.match(spawnResult.title, /^\d{4}｜修复｜回归套件$/);
assert.equal(spawnResult.team, '验证编组');
assert.equal(spawnResult.depth, 1, 'root-spawned tasks must be depth 1');
assert.ok(sessions.has(spawnResult.sessionId));
assert.ok(typeof spawnResult.correlationId === 'string' && spawnResult.correlationId.length > 0);
assert.ok(existsSync(registryFile), 'registry file was not written');
const teamList = await byName.task_list.execute({ team: '验证编组' }, supervisorExec);
assert.deepEqual(teamList.tasks.map((task) => task.sessionId), [spawnResult.sessionId]);
// report-back convention: kickoff prompt carries the push-back instruction naming the supervisor
const spawnKickoff = sessions.get(spawnResult.sessionId).kickoffPrompt;
assert.match(spawnKickoff, /^run the regression suite/);
assert.match(spawnKickoff, /汇报约定/);
assert.match(spawnKickoff, /session-super/);
console.log('task_spawn         : OK ->', spawnResult.sessionId, 'title:', spawnResult.title, '| team listed:', teamList.tasks.length === 1, '| report-back:', /汇报约定/.test(spawnKickoff));

// dispatch confirmation gate: unapproved batch is refused...
const unapprovedBatch = await byName.task_spawn_batch.execute({
  tasks: [
    { title: '探索｜批量甲', prompt: 'batch item one' },
    { title: '探索｜批量乙', prompt: 'batch item two' },
  ],
}, supervisorExec);
assert.equal(unapprovedBatch.ok, false);
assert.equal(unapprovedBatch.code, 'confirmation-required');
// ...so confirm first (approval card flow, auto-approved by the mock seam)
const confirmResult = await byName.task_confirm.execute({
  plan: '## 拆分方案\n- 任务1：批量甲（独立）\n- 任务2：批量乙（独立）',
}, supervisorExec);
assert.equal(confirmResult.ok, true);
assert.equal(confirmResult.approved, true);
assert.ok(confirmResult.confirmationId.startsWith('confirm-'));
// batch spawn (decomposition execution step) with per-item results + depth
const batchResult = await byName.task_spawn_batch.execute({
  tasks: [
    { title: '探索｜批量甲', prompt: 'batch item one' },
    { title: '探索｜批量乙', prompt: 'batch item two' },
  ],
  team: '批量验证',
  confirmationId: confirmResult.confirmationId,
}, supervisorExec);
assert.equal(batchResult.ok, true);
assert.equal(batchResult.startedCount, 2);
assert.equal(batchResult.failedCount, 0);
assert.equal(batchResult.team, '批量验证');
for (const item of batchResult.results) {
  assert.equal(item.ok, true);
  assert.equal(item.depth, 1);
  assert.ok(sessions.has(item.sessionId));
}
const batchTeamList = await byName.task_list.execute({ team: '批量验证' }, supervisorExec);
assert.equal(batchTeamList.count, 2);
// every batch task got the report-back instruction too
for (const item of batchResult.results) {
  const kickoff = sessions.get(item.sessionId).kickoffPrompt;
  assert.match(kickoff, /汇报约定/);
  assert.match(kickoff, /session-super/);
}
// the confirmation is single-use
const reusedBatch = await byName.task_spawn_batch.execute({
  tasks: [{ prompt: 'x' }, { prompt: 'y' }],
  confirmationId: confirmResult.confirmationId,
}, supervisorExec);
assert.equal(reusedBatch.code, 'confirmation-required');
const batchBad = await byName.task_spawn_batch.execute({ tasks: [] }, supervisorExec);
assert.equal(batchBad.code, 'bad-request');
console.log('task_confirm       : OK -> approved,', confirmResult.confirmationId, '(single-use enforced)');
console.log('task_spawn_batch   : OK ->', batchResult.results.map((item) => item.sessionId).join(', '), '| gate + team listed:', batchTeamList.count === 2);

// report-back opt-out: kickoff is exactly the user prompt
const quietSpawn = await byName.task_spawn.execute({ prompt: 'quiet errand', reportBack: false }, supervisorExec);
assert.equal(quietSpawn.ok, true);
assert.equal(sessions.get(quietSpawn.sessionId).kickoffPrompt, 'quiet errand');
console.log('reportBack: false  : OK -> kickoff stays pristine');

const waitResult = await byName.task_wait.execute({ sessionIds: ['session-worker', spawnResult.sessionId], mode: 'all', timeoutMs: 1000 }, supervisorExec);
assert.equal(waitResult.settled, true);
assert.equal(waitResult.count, 2);
console.log('task_wait (multi)  : OK ->', waitResult.reason);

// slash command: /tasks (direct execution, no model turn)
const tasksCommand = ctx.commandRegistrations[0];
const invocationBase = {
  commandId: 'verify-cmd-1',
  agent: { id: 'session-super', session: { header: { cwd: '/proj' } } },
  attachments: [],
  signal: new AbortController().signal,
};
const listCmd = await tasksCommand.handler({ ...invocationBase, rawInput: '' });
assert.equal(listCmd.kind, 'success');
assert.match(listCmd.text, /session-worker/);
const teamCmd = await tasksCommand.handler({ ...invocationBase, rawInput: 'team 验证编组' });
assert.equal(teamCmd.kind, 'success');
assert.match(teamCmd.text, new RegExp(spawnResult.sessionId));
const inspectCmd = await tasksCommand.handler({ ...invocationBase, rawInput: 'session-worker' });
assert.equal(inspectCmd.kind, 'success');
assert.match(inspectCmd.text, /Worker task/);
const shortCmd = await tasksCommand.handler({ ...invocationBase, rawInput: spawnResult.sessionId.replace(/^session-/, '') });
assert.equal(shortCmd.kind, 'success');
// ambiguous prefix ('spawned' matches three batch sessions) must be rejected
const ambiguousCmd = await tasksCommand.handler({ ...invocationBase, rawInput: 'spawned' });
assert.equal(ambiguousCmd.kind, 'error');
assert.match(ambiguousCmd.text, /ambiguous/);
const badCmd = await tasksCommand.handler({ ...invocationBase, rawInput: 'team' });
assert.equal(badCmd.kind, 'error');
console.log('slash /tasks       : OK -> list/team/inspect/short-id/ambiguous/usage all settled');

const cancelResult = await byName.task_cancel.execute({ sessionId: 'session-worker' }, supervisorExec);
assert.equal(cancelResult.ok, true);
console.log('task_cancel        : OK');

// 6. dispose path
for (const factory of ctx.effects) factory()();
assert.equal(registrations.length, 0, 'dispose must unregister all tools');
console.log('dispose            : OK -> all tools unregistered');
console.log('\nALL INTEGRATION CHECKS PASSED');
