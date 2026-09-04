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
assert.deepEqual(plugin.inject, ['agents', 'tools', 'sessionController']);

// 3. mock cordis ctx with a believable session universe
const sessions = new Map();
const liveAgents = new Map();
const registrations = [];
const calls = [];

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
  provide(key, value) { this.provides[key] = value; },
  effect(factory) { this.effects.push(factory); },
  plugin(pluginModule, config) {
    this.mountedPlugins.push([pluginModule, config]);
    return () => {};
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
      const id = request.sessionId ?? 'session-spawned';
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
// minSendIntervalMs: 0 so back-to-back verification sends are not rate limited
plugin.apply(ctx, { minSendIntervalMs: 0 });
assert.equal(registrations.length, 6, `expected 6 tools, got ${registrations.length}`);
assert.ok(ctx.provides.taskCoordinator, 'taskCoordinator service not provided');
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
const delivered = liveAgents.get('session-worker').delivered.at(-1);
assert.equal(delivered.via, 'followup');
assert.equal(delivered.message.source.kind, 'coordinator');
assert.equal(delivered.message.source.senderSessionId, 'session-super');
console.log('task_send          : OK -> coordinator message delivered, role:', delivered.message.role);

const steerResult = await byName.task_send.execute({ sessionId: 'session-worker', message: 'keep api stable', mode: 'steer' }, supervisorExec);
assert.equal(steerResult.ok, true);
assert.equal(liveAgents.get('session-worker').delivered.at(-1).via, 'steer');
console.log('task_send (steer)  : OK');

const selfResult = await byName.task_send.execute({ sessionId: 'session-super', message: 'loop?' }, supervisorExec);
assert.equal(selfResult.ok, false);
assert.match(selfResult.error, /itself/);
console.log('self-guard         : OK ->', selfResult.error);

const spawnResult = await byName.task_spawn.execute({ prompt: 'run the regression suite', title: '修复｜回归套件' }, supervisorExec);
assert.equal(spawnResult.ok, true);
assert.match(spawnResult.title, /^\d{4}｜修复｜回归套件$/);
assert.ok(sessions.has(spawnResult.sessionId));
console.log('task_spawn         : OK ->', spawnResult.sessionId, 'title:', spawnResult.title, '| visible in list:', (await byName.task_list.execute({}, supervisorExec)).tasks.some((task) => task.sessionId === spawnResult.sessionId));

const waitResult = await byName.task_wait.execute({ sessionId: 'session-worker', timeoutMs: 1000 }, supervisorExec);
assert.equal(waitResult.settled, true);
console.log('task_wait          : OK ->', waitResult.reason);

const cancelResult = await byName.task_cancel.execute({ sessionId: 'session-worker' }, supervisorExec);
assert.equal(cancelResult.ok, true);
console.log('task_cancel        : OK');

// 6. dispose path
for (const factory of ctx.effects) factory()();
assert.equal(registrations.length, 0, 'dispose must unregister all tools');
console.log('dispose            : OK -> all tools unregistered');
console.log('\nALL INTEGRATION CHECKS PASSED');
