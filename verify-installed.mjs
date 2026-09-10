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
import { resolveUiLocale, uiStrings } from './i18n.mjs';

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
const createRequests = [];
const installedSections = [];
let createCount = 0;
// The supervisor session is a member of exactly one workspace; every spawn it
// performs must therefore carry workspaceId (host create: workspaceId XOR cwd).
const verifyWorkspace = { id: 'ws-verify', path: '/proj', sessionIds: ['session-super'] };
// 0.16.0 migrate fixtures: a second workspace added mid-run (so the earlier
// single-workspace assertions stay valid), the seeded-create captures and the
// durable-archive journal.
const migrateTargets = [];
const migrateCreateRequests = [];
const archivedSessions = [];

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
  session: (() => {
    // REAL Session-entity shape (0.24.1 regression pin): the live host session
    // exposes seq + ranged snapshotEvents(from, to) — NOT a plain `.events`
    // array (dsh-session lib L1331/L1342). The old mock carried the imaginary
    // `.events` shape and masked the production bug (recent always []). This
    // mock deliberately OMITS `.events` so a non-empty recent proves the
    // snapshotEvents path is the one running.
    const events = [
      { type: 'user/message', seq: 1, time: 1, data: { content: [{ type: 'text', text: 'kickoff' }], source: { kind: 'user' } } },
      { type: 'assistant/message', seq: 2, time: 2, data: { message: { content: [{ type: 'text', text: 'working on it' }] } } },
    ];
    return {
      id: 'session-worker',
      seq: 3,
      header: { id: 'session-worker', cwd: '/proj' },
      snapshotEvents: (from = 0, to = 3) => events.filter((event) => event.seq >= from && event.seq < to),
    };
  })(),
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
  // cordis ctx.inject stand-in (0.18.0): the settings service composes
  // immediately, so the plugin's section installs during apply().
  inject(deps, callback) {
    if (deps.includes('settings')) callback({ settings: ctx.get('settings') });
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
  // workspace-registry stand-in: the supervisor lives in one workspace, so
  // spawned children must attach to it (workspaceId in the create request).
  get(name) {
    if (name === 'workspaceRegistry') return {
      list: () => [verifyWorkspace, ...migrateTargets],
      // live-entity access (0.12.0 task_workspace): mimics workspace.attachSession /
      // detachSession membership mutation without the host's cwd validation
      get: (id) => (id === verifyWorkspace.id ? {
        attachSession: async (sessionId) => {
          if (!verifyWorkspace.sessionIds.includes(sessionId)) verifyWorkspace.sessionIds.unshift(sessionId);
        },
        detachSession: async (sessionId) => {
          const at = verifyWorkspace.sessionIds.indexOf(sessionId);
          if (at >= 0) verifyWorkspace.sessionIds.splice(at, 1);
        },
      } : migrateTargets.some((ws) => ws.id === id) ? {
        // 0.16.0 migrate target entity: the clone (born with this workspace's
        // path as cwd) attaches here
        attachSession: async (sessionId) => {
          const target = migrateTargets.find((ws) => ws.id === id);
          if (target && !target.sessionIds.includes(sessionId)) target.sessionIds.unshift(sessionId);
        },
        detachSession: async () => {},
      } : undefined),
      // 0.16.0 migrate: durable archive of the original session
      archiveSession: async (sessionId) => { archivedSessions.push(sessionId); },
    };
    if (name === 'sessionQuery') return {
      // 0.16.0 migrate: complete replay-validated log, source NOT made live
      async readSession(sessionId) {
        calls.push('readSession');
        if (sessionId === 'session-migrate-me') {
          return {
            session: { id: sessionId, cwd: '/elsewhere', createdAt: 999, agentPreset: 'preset-verify' },
            events: [{ type: 'turn/start', seq: 0 }, { type: 'turn/end', seq: 1 }],
          };
        }
        if (sessionId === 'session-same-cwd') {
          return { session: { id: sessionId, cwd: '/proj2', createdAt: 1 }, events: [] };
        }
        throw new Error(`session "${sessionId}" not found`);
      },
    };
    if (name === 'sessions') return {
      // 0.16.0 migrate: seeded creation — the clone is born with meta.cwd
      create(id, options) {
        calls.push('sessions.create');
        migrateCreateRequests.push(options ?? {});
        return { id: `session-migrated-${migrateCreateRequests.length}` };
      },
      async flush() { calls.push('sessions.flush'); },
    };
    if (name === 'settings') return {
      // settings-service stand-in (0.18.0): one durable section the plugin
      // installs, with a stored user layer the spawn path must fall back to.
      get: (ns) => (ns === 'task-coordinator'
        ? { provider: 'prov-verify', model: 'model-ok', reasoningEffort: 'high', maxQueuePerTask: 12 }
        : undefined),
      installSection(owner, ns, schema, entry, hooks) {
        installedSections.push(ns);
        hooks.setSource(() => entry);
        hooks.onChange();
      },
    };
    if (name === 'llm') return {
      // catalog pre-validation stand-in (0.13.0): mirror resolveCallConfig
      async resolveCallConfig(selection) {
        calls.push('resolveCallConfig');
        if (selection.model === 'model-ghost') throw new Error(`model "${selection.model}" is not served by provider "${selection.provider}"`);
        return selection;
      },
      // route-discovery stand-in (0.14.0): mirror listProviders/listModels
      listProviders: () => [{ id: 'prov-verify', name: 'Verify Provider' }],
      async listModels(providerId) {
        calls.push('listModels');
        return providerId === 'prov-verify' ? [{ id: 'model-ok', name: 'OK Model' }] : [];
      },
    };
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
      createRequests.push(request);
      createCount += 1;
      const id = request.sessionId ?? `session-spawned-${createCount}`;
      // mirror the host SessionCommandController.create semantics (commands.js
      // L84-116): cwd = workspace?.path ?? request.cwd, then attachSession —
      // so workspaceId-based creation lands the session ON the workspace path
      // (what task_list's ungrouped filter and the sidebar bucket key on).
      const knownWorkspace = [verifyWorkspace, ...migrateTargets].find((workspace) => workspace.id === request.workspaceId);
      const derivedCwd = knownWorkspace ? knownWorkspace.path : request.cwd;
      if (request.workspaceId === verifyWorkspace.id) verifyWorkspace.sessionIds.push(id);
      sessions.set(id, { sessionId: id, updatedAt: Date.now(), running: false, blank: true, cwd: derivedCwd, projections: { asOfSeq: 0, values: {} } });
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
    async selectModel(request) {
      calls.push('selectModel');
      if (request.model === 'model-bad') throw new Error(`model "${request.model}" is not served by provider "${request.provider}"`);
      const { sessionId, ...selection } = request;
      return { selected: selection };
    },
    async modelCatalog() {
      calls.push('modelCatalog');
      return {
        default: { provider: 'prov-verify', model: 'model-ok' },
        routableProviders: ['prov-verify'],
        groups: [
          {
            id: 'prov-verify',
            name: 'Verify Provider',
            models: [
              { id: 'model-ok', name: 'OK Model', reasoning: { efforts: [{ id: 'high', name: 'High' }], defaultEffort: 'high' } },
            ],
          },
        ],
        failures: [],
      };
    },
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
assert.equal(registrations.length, 11, `expected 11 tools, got ${registrations.length}`);
assert.equal(ctx.commandRegistrations.length, 1, 'expected the /tasks command');
assert.equal(ctx.commandRegistrations[0].name, 'tasks');
assert.ok(ctx.provides.taskCoordinator, 'taskCoordinator service not provided');
assert.equal(ctx.provides.taskCoordinator.version, JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version);
// 0.24.0 service seam: the enabled provide payload carries the LIVE ops
// instance — the same object the registered tools delegate to (bridge
// consumers resolve the service and call these members directly). The names
// are ops.mjs's actual members, not the task_* tool names.
const provided = ctx.provides.taskCoordinator;
const SEAM_MEMBERS = ['pendingCount', 'listTasks', 'progress', 'sendMessage', 'spawnTask', 'confirmPlan', 'confirmSelect', 'consumeConfirmation', 'workspaceOp', 'models', 'spawnBatch', 'waitFor', 'cancelTask'];
assert.ok(provided.ops, 'enabled provide payload must carry ops (0.24.0 service seam)');
for (const member of SEAM_MEMBERS) {
  assert.equal(typeof provided.ops[member], 'function', `provided ops.${member} must be a function`);
}
// the payload is live, not a serialized copy: one direct call through the
// provided instance exercises the same sessionController wiring the tools use
const seamList = await provided.ops.listTasks({}, { sessionId: 'session-super', cwd: '/proj' });
assert.equal(seamList.ok, true, 'a call through the provided ops must work end-to-end');
assert.ok(Array.isArray(seamList.tasks), 'the provided ops returns the real listTasks shape');
// disabled path: the service STILL exists (a missing service would leave a
// bridge consumer forever inert), but ops is absent — the degrade signal
// bridge consumers map to 503. Fresh minimal ctx: the disabled early return
// touches nothing but provide + logger.
{
  const disabledProvides = {};
  const disabledCtx = {
    logger: { info: () => {}, warn: () => {} },
    provide(key, value) { disabledProvides[key] = value; },
    get: () => undefined,
    inject() {},
  };
  plugin.apply(disabledCtx, { enabled: false });
  assert.ok(disabledProvides.taskCoordinator, 'the service must be provided even when disabled');
  assert.equal(disabledProvides.taskCoordinator.version, provided.version, 'disabled payload carries the same version');
  assert.equal('ops' in disabledProvides.taskCoordinator, false, 'disabled provide payload must NOT carry ops');
}
console.log('service seam       : OK -> enabled payload carries the live ops (13 members, direct call works); disabled payload omits ops');
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
assert.ok(sendResult.queueDepth && Number.isInteger(sendResult.queueDepth.nextTurn) && Number.isInteger(sendResult.queueDepth.nextStep), 'queueDepth receipt missing');
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

// Queue-cap override (0.23.0): the settings mock carries maxQueuePerTask 12 —
// depth 7 (above the config default 5) must still be admitted and depth 12
// denied queue-full, proving the limiter reads the cap LIVE from the settings
// section (getter wiring in index.mjs) with no restart.
{
  const workerAgent = liveAgents.get('session-worker');
  for (let index = 0; index < 7; index += 1) workerAgent.inbox.nextTurn.push({ synthetic: index });
  const underCap = await byName.task_send.execute({ sessionId: 'session-worker', message: '深度 7 仍应放行' }, supervisorExec);
  assert.equal(underCap.ok, true, 'settings cap 12 must live-override the config default 5 (depth 7 admits)');
  while (workerAgent.inbox.nextTurn.length < 12) workerAgent.inbox.nextTurn.push({ synthetic: 'fill' });
  const atCap = await byName.task_send.execute({ sessionId: 'session-worker', message: '深度 12 应拒' }, supervisorExec);
  assert.equal(atCap.ok, false, 'depth at the settings cap must deny');
  assert.match(JSON.stringify(atCap), /queue-full|pending message/, 'the denial names the queue-full cause');
  workerAgent.inbox.nextTurn.length = 0;
  console.log('queue cap override : OK -> settings maxQueuePerTask=12 live-overrides config default 5 (depth 7 admits, 12 denies queue-full)');
}

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
assert.equal(createRequests[0].workspaceId, 'ws-verify', 'spawn must attach the caller workspace');
assert.equal(createRequests[0].cwd, undefined, 'session.create takes workspaceId XOR cwd');
assert.equal(spawnResult.cwd, '/proj', 'result cwd reflects the workspace path');
assert.ok(verifyWorkspace.sessionIds.includes(spawnResult.sessionId), 'created session attached to the workspace');
// 0.19.0 placement observability: every receipt states the workspace
// attachment ({id,title} | null) and HOW the placement was decided.
assert.equal(spawnResult.placement, 'caller-inherited');
assert.deepEqual(spawnResult.workspace, { id: 'ws-verify', title: null });

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
  plan: '# 拆分方案\n- 任务1：批量甲（独立）\n- 任务2：批量乙（独立）',
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

// 0.10.0 multi-select confirmation: the auto-approving mock seam picks the
// FIRST option, i.e. a one-task subset of the two proposed tasks.
const selectResult = await byName.task_confirm_select.execute({
  tasks: [
    { title: '功能｜选择甲', scope: '独立子任务（用于多选确认验证）' },
    { title: '功能｜选择乙' },
  ],
}, supervisorExec);
assert.equal(selectResult.ok, true);
assert.equal(selectResult.approved, true);
assert.deepEqual(selectResult.selected, ['功能｜选择甲']);
assert.ok(selectResult.confirmationId.startsWith('confirm-'));
// subset enforcement: a batch containing the unapproved title is rejected
const selectMismatch = await byName.task_spawn_batch.execute({
  tasks: [
    { title: '功能｜选择甲', prompt: 'selected task' },
    { title: '功能｜选择乙', prompt: 'unselected task' },
  ],
  confirmationId: selectResult.confirmationId,
}, supervisorExec);
assert.equal(selectMismatch.ok, false);
assert.equal(selectMismatch.code, 'confirmation-mismatch');
// the exact approved subset dispatches fine (credential survives sub-threshold use)
const subsetBatch = await byName.task_spawn_batch.execute({
  tasks: [{ title: '功能｜选择甲', prompt: 'selected task' }],
  confirmationId: selectResult.confirmationId,
}, supervisorExec);
assert.equal(subsetBatch.ok, true);
assert.equal(subsetBatch.startedCount, 1);
console.log('task_confirm_select: OK -> subset', JSON.stringify(selectResult.selected), '| mismatch rejected | subset dispatched');

// 0.11.0 mission-scoped (reusable) approval: confirm ONCE, then every gated
// batch of the mission reuses the same confirmationId.
const missionConfirm = await byName.task_confirm.execute({
  plan: '# 长线方案（复用凭证验证）',
  reusable: true,
}, supervisorExec);
assert.equal(missionConfirm.ok, true);
assert.equal(missionConfirm.approved, true);
assert.equal(missionConfirm.reusable, true);
const missionBatchOne = await byName.task_spawn_batch.execute({
  tasks: [{ prompt: '里程碑一甲' }, { prompt: '里程碑一乙' }],
  confirmationId: missionConfirm.confirmationId,
}, supervisorExec);
assert.equal(missionBatchOne.ok, true);
const missionBatchTwo = await byName.task_spawn_batch.execute({
  tasks: [{ prompt: '里程碑二甲' }, { prompt: '里程碑二乙' }],
  confirmationId: missionConfirm.confirmationId,
}, supervisorExec);
assert.equal(missionBatchTwo.ok, true); // credential survived the first success
console.log('reusable credential: OK ->', missionConfirm.confirmationId, 'covered two gated batches');
console.log('task_spawn_batch   : OK ->', batchResult.results.map((item) => item.sessionId).join(', '), '| gate + team listed:', batchTeamList.count === 2);
assert.equal(createRequests[1].workspaceId, 'ws-verify', 'batch item 1 inherits the workspace');
assert.equal(createRequests[2].workspaceId, 'ws-verify', 'batch item 2 inherits the workspace');

// report-back opt-out: kickoff is exactly the user prompt
const quietSpawn = await byName.task_spawn.execute({ prompt: 'quiet errand', reportBack: false }, supervisorExec);
assert.equal(quietSpawn.ok, true);
assert.equal(sessions.get(quietSpawn.sessionId).kickoffPrompt, 'quiet errand');
console.log('reportBack: false  : OK -> kickoff stays pristine');
assert.equal(createRequests[3].workspaceId, 'ws-verify', 'reportBack opt-out does not affect workspace inheritance');

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

// 0.12.0 task_workspace: list + attach/detach an existing session through the
// live workspace entity (membership mutation, no conversation touched).
// NOTE: placed after the slash-command section on purpose — its extra spawn
// would push the mock id sequence to session-spawned-10 and make the short-id
// prefix 'spawned-1' ambiguous in the tests above.
const wsList = await byName.task_workspace.execute({ action: 'list' }, supervisorExec);
assert.equal(wsList.ok, true);
assert.equal(wsList.workspaces.length, 1);
assert.equal(wsList.workspaces[0].id, 'ws-verify');
const wsAttach = await byName.task_workspace.execute({ action: 'attach', sessionId: 'session-migrate-me', workspacePath: '/proj' }, supervisorExec);
assert.equal(wsAttach.ok, true);
assert.ok(verifyWorkspace.sessionIds.includes('session-migrate-me'), 'attached through the entity');
const wsDetach = await byName.task_workspace.execute({ action: 'detach', sessionId: 'session-migrate-me', workspaceId: 'ws-verify' }, supervisorExec);
assert.equal(wsDetach.ok, true);
assert.ok(!verifyWorkspace.sessionIds.includes('session-migrate-me'), 'detached through the entity');
const wsGhost = await byName.task_workspace.execute({ action: 'attach', sessionId: 's', workspaceId: 'ws-ghost' }, supervisorExec);
assert.equal(wsGhost.ok, false);
assert.equal(wsGhost.code, 'workspace-not-found');
// spawn upgrade: an explicit cwd matching the workspace path attaches instead
// of dropping the child into the ungrouped bucket
const upgraded = await byName.task_spawn.execute({ prompt: '工作区升级验证', cwd: '/proj/' }, supervisorExec);
assert.equal(upgraded.ok, true);
assert.ok(verifyWorkspace.sessionIds.includes(upgraded.sessionId), 'explicit-cwd spawn upgraded to workspace attachment');
assert.equal(upgraded.placement, 'exact-match');
assert.deepEqual(upgraded.workspace, { id: 'ws-verify', title: null });
console.log('task_workspace     : OK -> list/attach/detach + spawn cwd-upgrade verified');

// 0.19.0 ancestor normalization end-to-end: a cwd INSIDE the workspace tree
// attaches to the (nearest) ancestor workspace; the host then derives the
// session cwd from the workspace ROOT, so the receipt says where the task
// actually works and the kickoff tells it its real target directory.
const ancestorSpawn = await byName.task_spawn.execute({ prompt: '祖先归一验证', cwd: '/proj/sub/feature' }, supervisorExec);
assert.equal(ancestorSpawn.ok, true, `ancestor spawn failed: ${ancestorSpawn.error ?? ''}`);
assert.equal(ancestorSpawn.placement, 'ancestor-normalized');
assert.deepEqual(ancestorSpawn.workspace, { id: 'ws-verify', title: null });
assert.equal(ancestorSpawn.cwd, '/proj', 'receipt cwd is the workspace root');
assert.equal(ancestorSpawn.normalizedFrom, '/proj/sub/feature');
assert.match(ancestorSpawn.note, /ancestor normalization/);
const ancestorCreate = createRequests.at(-1);
assert.equal(ancestorCreate.workspaceId, 'ws-verify', 'ancestor spawn sends workspaceId, not the subdirectory');
assert.equal(ancestorCreate.cwd, undefined, 'workspaceId and cwd stay mutually exclusive');
const ancestorKickoff = sessions.get(ancestorSpawn.sessionId).kickoffPrompt;
assert.match(ancestorKickoff, /^祖先归一验证/);
assert.match(ancestorKickoff, /工作目录提示（工作区归一）/);
assert.match(ancestorKickoff, /\/proj\/sub\/feature/, 'kickoff names the task target directory');
assert.ok(verifyWorkspace.sessionIds.includes(ancestorSpawn.sessionId), 'normalized spawn attached to the workspace');
// the durable registry keeps the caller's intended directory for remediation
const registryPayload = JSON.parse(readFileSync(registryFile, 'utf8'));
assert.equal(registryPayload.entries[ancestorSpawn.sessionId].expectedWorkspace, '/proj/sub/feature');

// 0.19.0 ungrouped terminal end-to-end: an unmatched cwd lands ungrouped with
// the strong receipt warning + remediation hint, and task_list({ ungrouped })
// surfaces it (the real index.mjs probeWorktree ran here: /nowhere/at-all/.git
// does not exist, so it degrades to plain ungrouped, not ungrouped-worktree).
const straySpawn = await byName.task_spawn.execute({ prompt: '未分组回执验证', cwd: '/nowhere/at-all', team: '未分组验证' }, supervisorExec);
assert.equal(straySpawn.ok, true);
assert.equal(straySpawn.placement, 'ungrouped');
assert.equal(straySpawn.workspace, null);
assert.match(straySpawn.warning, /ungrouped placement/);
assert.match(straySpawn.warning, /task_workspace/);
assert.match(straySpawn.hint, /task_progress/);
assert.equal(JSON.parse(readFileSync(registryFile, 'utf8')).entries[straySpawn.sessionId].expectedWorkspace, '/nowhere/at-all');
const ungroupedList = await byName.task_list.execute({ ungrouped: true }, supervisorExec);
assert.equal(ungroupedList.ungrouped, true);
assert.deepEqual(ungroupedList.tasks.map((task) => task.sessionId), [straySpawn.sessionId], 'ungrouped filter must surface exactly the stray session (workspace-attached rows are excluded)');
assert.match(ungroupedList.hint, /task_workspace/);
console.log('workspace placement : OK -> ancestor-normalized (workspaceId + root cwd + i18n kickoff note + registry expectedWorkspace) | ungrouped receipt warning + task_list ungrouped filter');

// 0.16.0 task_workspace migrate: true cross-workspace move — the clone +
// attach + archive route over the five host primitives (readSession →
// sessions.create+flush → target attachSession → archiveSession).
migrateTargets.push({ id: 'ws-verify2', path: '/proj2', sessionIds: [] });
const migrateResult = await byName.task_workspace.execute(
  { action: 'migrate', sessionId: 'session-migrate-me', workspaceId: 'ws-verify2' },
  supervisorExec,
);
assert.equal(migrateResult.ok, true, `migrate must succeed: ${migrateResult.error ?? ''}`);
assert.equal(migrateResult.sessionId, 'session-migrated-1', 'result reports the NEW session id');
assert.equal(migrateResult.migratedFrom, 'session-migrate-me');
assert.equal(migrateResult.workspaceId, 'ws-verify2');
assert.equal(migrateResult.archived, true);
assert.equal(migrateCreateRequests[0].meta.cwd, '/proj2', 'clone born with the TARGET workspace path');
assert.equal(migrateCreateRequests[0].meta.createdAt, 999, 'original createdAt preserved');
assert.equal(migrateCreateRequests[0].meta.agentPreset, 'preset-verify', 'original agentPreset preserved');
assert.equal(migrateCreateRequests[0].seed.length, 2, 'the complete log is seeded');
assert.ok(migrateTargets[0].sessionIds.includes('session-migrated-1'), 'clone attached to the target workspace');
assert.deepEqual(archivedSessions, ['session-migrate-me'], 'original durably archived');
// a source whose cwd already equals the target path is refused with an attach
// hint — no redundant clone, no archive
const noopMigrate = await byName.task_workspace.execute(
  { action: 'migrate', sessionId: 'session-same-cwd', workspaceId: 'ws-verify2' },
  supervisorExec,
);
assert.equal(noopMigrate.code, 'bad-request');
assert.match(noopMigrate.error, /use action 'attach'/);
assert.equal(migrateCreateRequests.length, 1, 'same-cwd refusal clones nothing');
assert.deepEqual(archivedSessions, ['session-migrate-me'], 'same-cwd refusal archives nothing');
console.log('task_workspace migrate: OK -> clone+attach+archive route, meta carry-over (cwd/createdAt/preset/seed), same-cwd refusal');

// 0.13.0 per-child model selection: catalog pre-validation, then install via
// sessionController.selectModel between create and kickoff (order matters).
const modelSpawn = await byName.task_spawn.execute({ prompt: '模型指定验证', provider: 'prov-verify', model: 'model-ok', reasoningEffort: 'high' }, supervisorExec);
assert.equal(modelSpawn.ok, true);
assert.deepEqual(modelSpawn.model, { provider: 'prov-verify', model: 'model-ok', reasoningEffort: 'high' });
const createAt = calls.lastIndexOf('create');
const selectAt = calls.lastIndexOf('selectModel');
const promptAt = calls.lastIndexOf('prompt');
assert.ok(createAt >= 0 && createAt < selectAt && selectAt < promptAt, 'model installed between create and kickoff');
// an invalid route is rejected up front — no session is created
const ghostSpawn = await byName.task_spawn.execute({ prompt: '不应创建', provider: 'prov-verify', model: 'model-ghost' }, supervisorExec);
assert.equal(ghostSpawn.ok, false);
assert.equal(ghostSpawn.code, 'model-unavailable');
assert.equal(ghostSpawn.sessionId, undefined);
// 0.14.0: the rejection carries an actionable route hint
assert.match(ghostSpawn.error, /models served by provider "prov-verify": model-ok/);
// provider and model are a pair
assert.equal((await byName.task_spawn.execute({ prompt: '不应创建', provider: 'prov-verify' }, supervisorExec)).code, 'bad-request');
console.log('model selection    : OK -> installed before kickoff | invalid route rejected up front with route hint | pair enforced');

// 0.18.0 spawn-model defaults: the settings section installed during apply(),
// and a spawn omitting provider+model falls back to the stored default route.
assert.ok(installedSections.includes('task-coordinator'), 'expected the task-coordinator settings section to be installed');
const defaultSpawn = await byName.task_spawn.execute({ prompt: '默认路线验证' }, supervisorExec);
assert.equal(defaultSpawn.ok, true);
assert.deepEqual(defaultSpawn.model, { provider: 'prov-verify', model: 'model-ok', reasoningEffort: 'high' });
assert.equal(defaultSpawn.modelSource, 'plugin-default');
const defaultSelect = calls.lastIndexOf('selectModel');
const defaultCreate = calls.lastIndexOf('create');
const defaultPrompt = calls.lastIndexOf('prompt');
assert.ok(defaultCreate >= 0 && defaultCreate < defaultSelect && defaultSelect < defaultPrompt, 'default route installed between create and kickoff');
console.log('spawn defaults     : OK -> settings section installed | omitted route falls back to the stored default (plugin-default)');

// 0.14.0 model-route discovery: the live catalog projection supervisors
// consult before spawning with provider+model (per-deployment, never guessed).
const catalog = await byName.task_models.execute({}, supervisorExec);
assert.equal(catalog.ok, true);
assert.deepEqual(catalog.default, { provider: 'prov-verify', model: 'model-ok' });
assert.equal(catalog.providers[0].id, 'prov-verify');
assert.deepEqual(catalog.providers[0].models[0], { id: 'model-ok', name: 'OK Model', efforts: ['high'], defaultEffort: 'high' });
assert.match(catalog.hint, /task_spawn/);
console.log('task_models        : OK -> live catalog projection (ids + efforts + default)');

// 0.15.0 UI localization: zh/en dictionaries + preference resolution ship with
// the installed bundle (the static import above proves i18n.mjs deployed). The
// mock settings service serves no locale section, so every card/kickoff in
// this run already proved the graceful zh default end-to-end (汇报约定 asserts above).
assert.deepEqual([resolveUiLocale('en'), resolveUiLocale('zh'), resolveUiLocale(undefined), resolveUiLocale('fr')], ['en', 'zh', 'zh', 'zh']);
assert.equal(uiStrings('en').confirmApproveLabel, 'Dispatch as planned (Recommended)');
assert.match(uiStrings('en').reportBackSuffix('session-x'), /^Reporting convention: .*session session-x via task_send/);
assert.match(uiStrings('zh').reportBackSuffix('session-x'), /^汇报约定：/);
assert.equal(uiStrings('en').tasksCommandDescription, 'View coordination tasks and team groupings (direct query, no model turn)');
console.log('i18n               : OK -> zh/en dictionaries, locale resolution, graceful zh default');

const cancelResult = await byName.task_cancel.execute({ sessionId: 'session-worker' }, supervisorExec);
assert.equal(cancelResult.ok, true);
console.log('task_cancel        : OK');

// 6. dispose path
for (const factory of ctx.effects) factory()();
assert.equal(registrations.length, 0, 'dispose must unregister all tools');
console.log('dispose            : OK -> all tools unregistered');

// 7. client module: declaration, bundle format, slot occupation, copy behavior
const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
assert.equal(pkg.dsh?.client?.platform, 'web', 'dsh.client.platform must be "web"');
assert.equal(pkg.exports?.['./client'], './client.js', 'exports["./client"] must point at ./client.js');
assert.equal(pkg.exports?.['./package.json'], './package.json', 'exports["./package.json"] is required by the client-modules manifest scan');
assert.ok(existsSync(new URL('./client.js', import.meta.url)), 'client.js bundle missing');

const clientSrc = readFileSync(new URL('./client.js', import.meta.url), 'utf8');
const clientRegistrations = [];
const fakeWindow = { __ModuleLoader__: { load: (entry) => clientRegistrations.push(entry) } };
new Function('window', clientSrc)(fakeWindow);
assert.equal(clientRegistrations.length, 1, 'client.js must register exactly one module');
const clientEntry = clientRegistrations[0];
assert.equal(clientEntry.id, pkg.name, 'client module id must match package name');

const fakeReact = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  // 0.20.0: lazy initializers are real React semantics the orchestration view
  // relies on (useState(() => Date.now())) — invoke them like the host would.
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  // present on the real host's React 18: the component subscribes to locale
  // snapshot revisions; the stand-in just reads the current snapshot
  useSyncExternalStore: (subscribe, getSnapshot) => getSnapshot(),
  // 0.18.0 settings tab: effects (service sighting, catalog loads) never run
  // under the stand-in, which is exactly the degraded first-render contract
  useEffect: () => {},
};
const clientExports = clientEntry.factory((spec) => {
  assert.equal(spec, 'react', 'client module may only require shared graph deps');
  return fakeReact;
});
assert.equal(typeof clientExports.apply, 'function');
assert.deepEqual(clientExports.inject, ['slots']);

const slotInjections = [];
const slotCtx = {
  slots: {
    inject: (name, thunk) => slotInjections.push({ name, thunk }),
    register: (options, component) => ({ options, component }),
  },
};
clientExports.apply(slotCtx);
assert.equal(slotInjections.length, 3, 'header utilities + settings section + orchestration view');
assert.equal(slotInjections[0].name, 'conversation.session.header.utilities');
const occupation = slotInjections[0].thunk();
assert.equal(occupation.options.id, 'copy-session-id');
assert.equal(typeof occupation.component, 'function');

// 0.18.1 first-level settings section: the second occupation registers the
// "任务编排" page in the settings left nav (native order values: general=0,
// models=10, plugins=15, agent-presets=20 — ours is 25). The thunk installs
// styles first — stub a minimal document whose querySelector always hits
// (style already present) so no DOM is touched.
const docDesc = Object.getOwnPropertyDescriptor(globalThis, 'document');
Object.defineProperty(globalThis, 'document', {
  value: { querySelector: () => ({}) },
  configurable: true,
});
assert.equal(slotInjections[1].name, 'settings.section');
const tabOccupation = slotInjections[1].thunk();
if (docDesc) Object.defineProperty(globalThis, 'document', docDesc);
else delete globalThis.document;
assert.equal(tabOccupation.options.id, 'task-coordinator');
assert.equal(tabOccupation.options.order, 25);
assert.match(tabOccupation.options.label(), /任务编排/);
assert.equal(typeof tabOccupation.component, 'function');
// The section renders a degraded (never-crashing) tree before any service is
// sighted: react stand-in has no useEffect, so call the component directly.
const tabTree = tabOccupation.component({});
assert.equal(tabTree.type, 'div', 'settings section renders a root div without services');
// Static source guards (0.18.1): every optional-service read must go through
// ctx.get() — the runner's inject-declaration gate THROWS on direct property
// access, which is exactly how 0.18.0's selects greyed out for good.
assert.match(clientSrc, /hostCtx\.get\("locale"\)/, 'ensureLocale must read the locale service through ctx.get()');
assert.match(clientSrc, /hostCtx\.get\("settingsScope"\)/, 'getBoundScope must read settingsScope through ctx.get()');
assert.match(clientSrc, /hostCtx\.get\("remote"\)/, 'getCatalogFace must read remote through ctx.get()');
assert.match(clientSrc, /"value" in response/, 'the catalog effect must unwrap the client result envelope (0.18.4)');
assert.match(clientSrc, /hostCtx\.get\("remote\.session"\)/, 'the catalog face must try the dotted remote.session service first (0.18.3)');
assert.match(clientSrc, /scope\.mutate\(/, 'save must write the section as ONE atomic mutate (0.18.5 — per-field writes composed half-pair states the host rejected)');
assert.match(clientSrc, /\{ op: "set", path: \["maxQueuePerTask"\], value: draft\.maxQueuePerTask \}/, 'the atomic save must include the queue-cap field (0.23.0)');
assert.match(clientSrc, /const QUEUE_CAP = 50;/, 'the client cap constant mirrors MAX_QUEUE_PER_TASK_CAP');
assert.match(clientSrc, /sameRoute\(landed, draft\)/, 'save must verify the landed snapshot before reporting success (0.18.5 honest-save check)');

const wrote = [];
const navDesc = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
Object.defineProperty(globalThis, 'navigator', {
  value: { clipboard: { writeText: async (t) => { wrote.push(t); } } },
  configurable: true,
});
const button = occupation.component({ sessionId: 'session-copy-target' });
assert.equal(button.type, 'button');
assert.match(button.props.title, /session-copy-target/);
await button.props.onClick();
assert.deepEqual(wrote, ['session-copy-target']);

// 0.16.1 regression (the v0.15.0 "header.action" bare-key button): the real
// host hands slot occupants a `t` bound to the registration's `locale` NS even
// when our dictionaries are NOT registered (the locale plugin can load after
// this bundle) — LocaleRuntime.translate then echoes the raw key. The button
// must fall back to the bundled zh dictionary and never render a bare key.
const bareKeyButton = occupation.component({ sessionId: 'session-copy-target', t: (key) => key });
assert.equal(bareKeyButton.children[0], '复制会话Id', 'a bare-key-echoing t() must fall back to the bundled zh dictionary');
assert.equal(bareKeyButton.props.title, '复制会话Id（session-copy-target）');

// Late locale service: the runtime appears AFTER apply() (the real-world load
// order that broke v0.15.0). The next render must register the dictionaries
// and resolve through the host runtime — zh first, then a live en switch.
const lateRuntime = {
  dicts: new Map(),
  register(ns, dicts) { this.dicts.set(ns, dicts); return () => {}; },
  translate(ns, key) { return this.dicts.get(ns)?.[lateActive]?.[key] ?? key; },
  getSnapshot() { return { active: lateActive, locales: ['zh', 'en'], revision: lateRevision }; },
  subscribe() { return () => {}; },
};
let lateActive = 'zh';
let lateRevision = 1;
slotCtx.locale = lateRuntime; // the service shows up late, like the real host
const lateZh = occupation.component({ sessionId: 's-late', t: (key) => lateRuntime.translate('task-coordinator', key) });
assert.equal(lateRuntime.dicts.has('task-coordinator'), true, 'late registration must connect on the first render after the service appears');
assert.equal(lateZh.children[0], '复制会话Id', 'late-registered runtime resolves zh through the host translate');
lateActive = 'en';
lateRevision += 1;
const lateEn = occupation.component({ sessionId: 's-late', t: (key) => lateRuntime.translate('task-coordinator', key) });
assert.equal(lateEn.children[0], 'Copy Session ID', 'en switch resolves through the host runtime');
assert.equal(lateEn.props.title, 'Copy Session ID (s-late)', 'en title uses ASCII parentheses off snapshot.active');
if (navDesc) Object.defineProperty(globalThis, 'navigator', navDesc);
else delete globalThis.navigator;

// 0.20.0 orchestration-view fixtures (SYNTHETIC data only: fictional session
// ids, titles and payloads — never real transcript content). Shared by the
// gated-ctx probe below and the main assertion section at the tail.
const orchNow = Date.now();
const orchNodeStore = new Map();
const orchOrder = [];
let orchSeq = 0;
const orchPush = (node) => { const key = `orch-node-${orchSeq++}`; orchNodeStore.set(key, node); orchOrder.push(key); };
const orchToolResult = (name, argsRaw, resultText, time) => orchPush({
  kind: 'tool-call',
  data: { root: { kind: 'tool-result', callId: `orch-call-${orchSeq}`, time, call: { name, argsRaw }, callTime: time, content: resultText === null ? [] : [{ type: 'text', text: resultText }], isError: false, subCalls: [] } },
});
const orchRelay = (senderSessionId, time) => orchPush({
  kind: 'context',
  data: { seq: orchSeq, time, content: [{ type: 'text', text: 'synthetic report payload' }], source: { kind: 'coordinator', form: 'relay', senderSessionId }, provenance: { role: 'inject', label: 'coordinator' }, form: 'relay' },
});
// A settled spawn whose result carries the child identity…
orchToolResult('task_spawn', JSON.stringify({ title: '探索｜甲任务', team: '编组甲', prompt: 'synthetic kickoff' }),
  JSON.stringify({ ok: true, sessionId: 'session-alpha', shortId: 'alpha', title: '0909｜探索｜甲任务', team: '编组甲', cwd: '/proj', started: true, correlationId: 'corr-alpha', depth: 1, model: { provider: 'prov-x', model: 'model-x' } }), 1000000);
// …a batch with one failed item (no session was born for it)…
orchToolResult('task_spawn_batch', JSON.stringify({ tasks: [{ title: '功能｜乙', prompt: 'synthetic b' }, { title: '功能｜丙', prompt: 'synthetic c' }], team: '编组乙' }),
  JSON.stringify({ ok: true, startedCount: 1, failedCount: 1, team: '编组乙', results: [
    { ok: true, sessionId: 'session-beta', title: '0909｜功能｜乙', correlationId: 'corr-beta', depth: 1 },
    { ok: false, code: 'model-unavailable', error: 'synthetic rejection' },
  ] }), 1100000);
// …a steer send with its receipt…
orchToolResult('task_send', JSON.stringify({ sessionId: 'session-alpha', message: 'synthetic course correction', mode: 'steer' }),
  JSON.stringify({ ok: true, delivered: true, targetId: 'session-alpha', mode: 'steer', messageId: 'msg-1', placement: 'next-step (mid-run steering)', targetStatus: 'running', queueDepth: { nextTurn: 0, nextStep: 1 } }), 1200000);
// …two inbound relay reports (one stale, one inside RECENT_MS → flow shimmer)…
orchRelay('session-alpha', 1300000);
orchRelay('session-beta', orchNow - 30000);
// …and a wait note.
orchToolResult('task_wait', JSON.stringify({ sessionIds: ['session-alpha'], mode: 'any' }),
  JSON.stringify({ ok: true, settled: true, reason: 'idle', waitedMs: 10, count: 1, targets: [{ sessionId: 'session-alpha', idle: true, agentState: 'idle' }] }), 1400000);
// Malformed shapes that must ALL be skipped without throwing: a
// window-truncated result (call === null), a non-JSON result text, a failed
// spawn (ok:false → note only, never a child), an unrelated tool, a RUNNING
// call, a store that throws on one key, and a key whose node is missing.
orchPush({ kind: 'tool-call', data: { root: { kind: 'tool-result', callId: 'orch-call-trunc', time: 1500000, call: null, callTime: 1500000, content: [{ type: 'text', text: '{}' }], isError: false, subCalls: [] } } });
orchToolResult('task_spawn', JSON.stringify({ title: '畸｜无结果', team: '编组甲' }), 'not json at all', 1510000);
orchToolResult('task_spawn', '{"title":"streaming incompl', JSON.stringify({ ok: false, code: 'spawn-create-failed', error: 'synthetic failure' }), 1520000);
orchToolResult('read', '{"file_path":"synthetic.txt"}', 'file body', 1530000);
orchPush({ kind: 'tool-call', data: { root: { callId: 'orch-call-run', name: 'task_send', argsRaw: '{"sessionId":"session-al', time: 1540000, turn: 1, step: 1, subCalls: [] } } });
orchOrder.push('orch-node-boom', 'orch-node-missing');
const orchSnapshot = {
  order: [...orchOrder],
  nodes: { get: (key) => { if (key === 'orch-node-boom') throw new Error('synthetic store glitch'); return orchNodeStore.get(key); } },
};
const orchSessionsList = {
  ids: ['session-superview', 'session-alpha', 'session-beta'],
  current: 'session-superview',
  byId: {
    'session-superview': { id: 'session-superview', displayTitle: 'Superview 合成总控', running: true, completed: false, blank: false, updatedAt: orchNow - 4000, projectionValues: { todos: [{ content: 'a', status: 'completed' }, { content: 'b', status: 'in_progress' }], goal: { goal: { phase: 'active', objective: 'synthetic' } } } },
    'session-alpha': { id: 'session-alpha', displayTitle: 'Alpha 合成任务', running: true, completed: false, blank: false, updatedAt: orchNow - 5000, projectionValues: { todos: [{ content: 'a', status: 'completed' }, { content: 'b', status: 'pending' }, { content: 'c', status: 'pending' }], goal: { goal: { phase: 'active', objective: 'synthetic' } } } },
    'session-beta': { id: 'session-beta', displayTitle: 'Beta 合成任务', running: false, completed: true, blank: false, updatedAt: orchNow - 65000, projectionValues: {} },
  },
};
const orchChatSeat = (selector) => selector(orchSnapshot);
const orchSessionsSeat = (selector) => selector(orchSessionsList);
/** Depth-first collect over the fake-react element tree (elements only). */
const orchIsElement = (node) => node !== null && typeof node === 'object' && typeof node.type !== 'undefined';
const orchCollect = (root, predicate) => {
  const found = [];
  const walk = (node) => {
    if (node === null || node === undefined || typeof node === 'string') return;
    if (Array.isArray(node)) { for (const item of node) walk(item); return; }
    if (!orchIsElement(node)) return;
    if (predicate(node)) found.push(node);
    if (Array.isArray(node.children)) for (const child of node.children) walk(child);
    else walk(node.children);
  };
  walk(root);
  return found;
};
/** True when any text node under the tree matches the pattern. */
const orchByText = (root, pattern) => {
  let hit = false;
  const walk = (node) => {
    if (node === null || node === undefined || hit) return;
    if (typeof node === 'string') { if (pattern.test(node)) hit = true; return; }
    if (Array.isArray(node)) { for (const item of node) walk(item); return; }
    if (!orchIsElement(node)) return;
    if (Array.isArray(node.children)) for (const child of node.children) walk(child);
    else walk(node.children);
  };
  walk(root);
  return hit;
};

// 0.18.1 runner-gate regression (the root cause of the permanently grey
// selects): dsh-cordis-client-runner's dynamicCordisContext gates direct
// ctx.serviceName property access behind the fiber's inject declaration —
// reading an UNDECLARED service throws. Our bundle declares only ["slots"],
// so locale / settingsScope / remote must be sighted through ctx.get().
// This harness replicates the gate: undeclared property reads throw, get()
// answers. A FRESH factory invocation provides fresh module state (the
// locale-registered flag is module-level and persists across apply()).
{
  const gatedRuntime = {
    dicts: new Map(),
    register(ns, dicts) { this.dicts.set(ns, dicts); return () => {}; },
    translate(ns, key) { return this.dicts.get(ns)?.zh?.[key] ?? key; },
    getSnapshot() { return { active: 'zh', locales: ['zh', 'en'], revision: 1 }; },
    subscribe() { return () => {}; },
  };
  // Live settings services behind the gate: the tab component must render
  // (not throw, not blank) when it sights a bound scope + remote face.
  const gatedScopeSnap = {
    status: 'ready',
    value: { provider: 'prov-gated', model: 'model-gated', reasoningEffort: '' },
    writable: true,
    revision: 1,
  };
  // 0.20.0: the sessions service stands in behind the gate — the view's
  // child-card click must sight it through ctx.get() and call open(id);
  // 0.21.1 (kept in 0.22.0): binding(id).session.loadOlder() is the
  // history-paging face for long-session window truncation.
  const gatedOpened = [];
  const gatedLoaded = [];
  const gatedServices = {
    locale: gatedRuntime,
    settingsScope: {
      bind: () => ({
        getSnapshot: () => gatedScopeSnap,
        subscribe: () => () => {},
        set: async () => {},
        mutate: async () => {},
      }),
    },
    // 0.18.4: the CLIENT wire answers a result envelope ({ok, value}), not the
    // bare catalog the host-side facade returns — the fake mirrors the wire.
    remote: { session: { modelCatalog: async () => ({ ok: true, value: { groups: [], failures: [], default: undefined } }) } },
    sessions: {
      open: (id) => gatedOpened.push(id),
      binding: (id) => ({ session: { loadOlder: async () => { gatedLoaded.push(id); } } }),
    },
  };
  const gatedSlotInjections = [];
  const gatedSlotService = {
    inject: (name, thunk) => gatedSlotInjections.push({ name, thunk }),
    register: (options, component) => ({ options, component }),
  };
  const gatedCtx = new Proxy({}, {
    get(_target, prop) {
      if (prop === 'get') return (name) => gatedServices[name];
      if (prop === 'slots') return gatedSlotService;
      throw new Error(`service "${String(prop)}" is not declared by your plugin. Declare it on the plugin you return: { inject: ['${String(prop)}', …] }`);
    },
  });
  const freshExports = clientRegistrations[0].factory((spec) => {
    assert.equal(spec, 'react', 'client module may only require shared graph deps');
    return fakeReact;
  });
  assert.deepEqual(freshExports.inject, ['slots']);
  let gatedApplyError = null;
  try { freshExports.apply(gatedCtx); } catch (error) { gatedApplyError = error; }
  assert.equal(gatedApplyError, null, 'apply() must survive the runner inject gate (no direct undeclared service reads)');
  assert.equal(gatedSlotInjections.length, 3, 'all three slots register through the gated ctx');
  // The eager ensureLocale inside apply() sights the runtime through
  // ctx.get('locale') under the gate — the 0.16.1 lazy sighting that never
  // actually engaged in production until this fix.
  assert.equal(gatedRuntime.dicts.has('task-coordinator'), true, 'ensureLocale must sight the runtime through ctx.get() under the gate');
  const gatedOccupation = gatedSlotInjections[0].thunk();
  Object.defineProperty(globalThis, 'navigator', { value: { clipboard: { writeText: async () => {} } }, configurable: true });
  const gatedButton = gatedOccupation.component({ sessionId: 's-gated' });
  assert.equal(gatedButton.children[0], '复制会话Id', 'button renders through the gated ctx');
  // The settings section renders with live services behind the gate (0.18.2
  // blank-panel regression: a render/effect throw abdicates the entry and
  // blanks the panel — the stub React runs no effects, so this asserts the
  // render-body path with a bound scope + remote face stays crash-free).
  Object.defineProperty(globalThis, 'document', { value: { querySelector: () => ({}) }, configurable: true });
  const gatedTab = gatedSlotInjections[1].thunk();
  const gatedTabTree = gatedTab.component({});
  assert.equal(gatedTabTree.type, 'div', 'settings section renders through the gated ctx with live services');
  // 0.20.0 orchestration view through the gate: the third slot registers with
  // the contract shape (id/order/label), renders the synthetic topology, and
  // the child-card click sights the sessions service through ctx.get() — the
  // sidebar's authoritative navigation primitive (research Q3), unreachable
  // via a direct hostCtx.sessions read under the runner gate.
  assert.equal(gatedSlotInjections[2].name, 'conversation.view');
  const gatedOrchOccupation = gatedSlotInjections[2].thunk();
  assert.equal(gatedOrchOccupation.options.id, 'orchestration');
  assert.equal(gatedOrchOccupation.options.order, 20, 'order 20 sits after the native chat(0)/trajectory(10) tabs');
  assert.match(gatedOrchOccupation.options.label(), /编排|Orchestration/);
  assert.equal(typeof gatedOrchOccupation.component, 'function');
  const gatedOrchTree = gatedOrchOccupation.component({ sessionId: 'session-superview', useChat: orchChatSeat, useSessions: orchSessionsSeat, useSession: (selector) => selector({ hasMore: true }) });
  assert.equal(gatedOrchTree.type, 'div', 'orchestration view renders through the gated ctx');
  const gatedChildCards = orchCollect(gatedOrchTree, (el) => el.props && String(el.props.className || '').includes('orchViewNode') && el.props['data-role'] === 'child');
  assert.equal(gatedChildCards.length, 2, 'both synthetic children render through the gated ctx');
  gatedChildCards[0].props.onClick();
  assert.deepEqual(gatedOpened, ['session-alpha'], 'child-card click must navigate via ctx.get("sessions").open');
  // 0.21.1 (kept): hasMore seat → history button → loadOlder through the gated face.
  const gatedHistoryBtn = orchCollect(gatedOrchTree, (el) => el.type === 'button' && Array.isArray(el.children) && el.children.some((text) => typeof text === 'string' && /载入更早记录|Load older/.test(text)))[0];
  assert.ok(gatedHistoryBtn, 'the hasMore seat surfaces the load-older button');
  gatedHistoryBtn.props.onClick();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(gatedLoaded, ['session-superview'], 'the history button pages via ctx.get("sessions").binding(id).session.loadOlder()');
  if (docDesc) Object.defineProperty(globalThis, 'document', docDesc);
  else delete globalThis.document;
  if (navDesc) Object.defineProperty(globalThis, 'navigator', navDesc);
  else delete globalThis.navigator;
}

console.log('client module      : OK -> dsh.client declared, bundle loads, header slot occupied (copy writes sessionId), first-level settings section registered (order 25)');
console.log('client i18n        : OK -> bare-key t() falls back to zh, late locale service registers on first sight, zh/en resolve live');
console.log('client runner gate : OK -> apply/render survive the inject gate; locale sights via ctx.get(); source reads settingsScope/remote through ctx.get()');

// 8. orchestration view (0.20.0): registration shape, pure-function test
// surface, synthetic-fixture extraction, deterministic layout, render probes
// (live/empty/throwing seats), degraded navigation fallback and static source
// guards. The fixtures are fully synthetic — fictional ids/titles/payloads,
// never real transcript content.
{
  Object.defineProperty(globalThis, 'document', { value: { querySelector: () => ({}) }, configurable: true });
  var orchOccupation = slotInjections[2].thunk();
  if (docDesc) Object.defineProperty(globalThis, 'document', docDesc);
  else delete globalThis.document;
  assert.equal(slotInjections[2].name, 'conversation.view');
  assert.equal(orchOccupation.options.name, 'conversation.view');
  assert.equal(orchOccupation.options.id, 'orchestration');
  assert.equal(orchOccupation.options.order, 20, 'order 20 sits after the native chat(0)/trajectory(10) tabs');
  assert.match(orchOccupation.options.label(), /编排|Orchestration/);
  assert.equal(orchOccupation.options.locale, 'task-coordinator', 'the view reuses the plugin dictionary namespace');
  assert.equal(typeof orchOccupation.component, 'function');
}

// 8a. the pure-function test surface
const orchApi = clientExports.__orchestration;
assert.ok(orchApi && typeof orchApi === 'object', 'exports.__orchestration test surface must exist');
assert.equal(typeof orchApi.extractOrchestration, 'function');
assert.equal(typeof orchApi.layoutTopology, 'function');
assert.equal(typeof orchApi.orchSessionInfo, 'function');
assert.equal(typeof orchApi.orchAgoText, 'function');
assert.equal(orchApi.RECENT_MS, 120000);
assert.equal(orchApi.ORCH_COORD, 'coordinator');

// 8b. extraction over the synthetic snapshot: two children (spawn + batch
// success), five edges (2 spawn, 1 steer send, 2 relay reports), one wait
// note + one spawn-failed note — and every malformed shape skipped silently.
const orchExtraction = orchApi.extractOrchestration(orchSnapshot);
assert.equal(orchExtraction.children.length, 2, 'spawn + batch-success children only (failed batch item never becomes a child)');
assert.equal(orchExtraction.edges.length, 5, '2 spawn + 1 send + 2 report edges');
const alphaChild = orchExtraction.children.find((child) => child.sessionId === 'session-alpha');
const betaChild = orchExtraction.children.find((child) => child.sessionId === 'session-beta');
assert.ok(alphaChild && betaChild, 'both synthetic children extracted');
assert.equal(alphaChild.title, '0909｜探索｜甲任务', 'the result title wins over the args title');
assert.equal(alphaChild.team, '编组甲');
assert.equal(alphaChild.correlationId, 'corr-alpha');
assert.equal(alphaChild.depth, 1);
assert.equal(alphaChild.model && alphaChild.model.model, 'model-x');
assert.equal(alphaChild.shortId, 'alpha');
assert.equal(betaChild.team, '编组乙', 'batch children inherit the batch team');
assert.equal(betaChild.correlationId, 'corr-beta');
const orchSpawnEdges = orchExtraction.edges.filter((edge) => edge.kind === 'spawn');
assert.deepEqual(orchSpawnEdges.map((edge) => edge.to).sort(), ['session-alpha', 'session-beta']);
assert.ok(orchSpawnEdges.every((edge) => edge.from === 'coordinator'));
const orchSendEdges = orchExtraction.edges.filter((edge) => edge.kind === 'send');
assert.equal(orchSendEdges.length, 1);
assert.equal(orchSendEdges[0].mode, 'steer');
assert.equal(orchSendEdges[0].messageId, 'msg-1');
assert.equal(orchSendEdges[0].to, 'session-alpha');
const orchReportEdges = orchExtraction.edges.filter((edge) => edge.kind === 'report');
assert.equal(orchReportEdges.length, 2, 'inbound relay context nodes become report edges');
assert.ok(orchReportEdges.every((edge) => edge.to === 'coordinator' && /^session-/.test(edge.from)));
const orchWaitNotes = orchExtraction.notes.filter((note) => note.kind === 'wait');
assert.equal(orchWaitNotes.length, 1);
assert.equal(orchWaitNotes[0].detail.settled, true);
assert.equal(orchExtraction.notes.filter((note) => note.kind === 'spawn-failed').length, 1, 'the ok:false spawn lands as a note, never a child');
assert.equal(orchExtraction.scanned, 11, 'scanned counts every non-null node including the malformed ones');
// malformed inputs never throw
assert.deepEqual(orchApi.extractOrchestration(null), { children: [], edges: [], notes: [], scanned: 0 });
assert.deepEqual(orchApi.extractOrchestration({}).children, []);
assert.deepEqual(orchApi.extractOrchestration({ order: 'not-an-array', nodes: null }).children, []);

// 8c. layout determinism: same extraction → identical layout; teams in
// code-point order with the ungrouped row LAST; the supervisor sits on top.
const orchLayoutA = orchApi.layoutTopology(orchExtraction);
const orchLayoutB = orchApi.layoutTopology(orchExtraction);
assert.equal(JSON.stringify(orchLayoutA), JSON.stringify(orchLayoutB), 'layoutTopology must be deterministic');
// UTF-16 code-unit order: '乙' (U+4E59) sorts BEFORE '甲' (U+7532).
assert.deepEqual(orchLayoutA.rows.map((row) => row.team), ['编组乙', '编组甲']);
assert.ok(orchLayoutA.nodes.coordinator, 'the supervisor node always exists');
assert.equal(orchLayoutA.nodes.coordinator.y, orchApi.ORCH_LAYOUT.padTop, 'supervisor on the top row');
assert.ok(orchLayoutA.rows.every((row) => row.y > orchLayoutA.nodes.coordinator.y), 'team rows sit below the supervisor');
assert.ok(orchLayoutA.nodes['session-alpha'] && orchLayoutA.nodes['session-beta']);
assert.ok(orchLayoutA.size.width > 0 && orchLayoutA.size.height > 0);
const orchLooseLayout = orchApi.layoutTopology({ children: [
  { sessionId: 'session-loose-b', time: 2000 },
  { sessionId: 'session-loose-a', time: 1000 },
  { sessionId: 'session-teamed', team: 'Z 组', time: 1500 },
], edges: [], notes: [] });
assert.deepEqual(orchLooseLayout.rows.map((row) => row.team), ['Z 组', ''], 'ungrouped children form the LAST row');
assert.deepEqual(orchLooseLayout.rows[1].ids, ['session-loose-a', 'session-loose-b'], 'in-row order follows spawn time');

// 8d. live-session join (pure): running/completed/title/todos/goal from the
// useSessions projection rows — the same source task_list reads host-side.
const orchAlphaInfo = orchApi.orchSessionInfo(orchSessionsList.byId, 'session-alpha');
assert.equal(orchAlphaInfo.running, true);
assert.equal(orchAlphaInfo.title, 'Alpha 合成任务');
assert.deepEqual(orchAlphaInfo.todos, { done: 1, total: 3 });
assert.equal(orchAlphaInfo.goalPhase, 'active');
assert.equal(orchApi.orchSessionInfo(orchSessionsList.byId, 'session-ghost'), null);
assert.equal(orchApi.orchSessionInfo(null, 'session-alpha'), null);
assert.equal(orchApi.orchAgoText(orchNow - 5000, orchNow, (key) => (key === 'orch.time.now' ? '刚刚' : key)), '刚刚');
assert.equal(orchApi.orchAgoText(orchNow - 65000, orchNow, (key, params) => (key === 'orch.time.min' ? `${params.n} 分钟前` : key)), '1 分钟前');
assert.equal(orchApi.orchAgoText(undefined, orchNow, (key) => key), 'orch.time.unknown');

// 8e. render probes under the fake-react stand-in: live seats render the
// topology without throwing; MISSING seats render the empty-state card plus
// diagnostics; a THROWING seat renders a diagnostics line instead of letting
// the render throw (the host SlotErrorBoundary abdicates entries that throw).
const orchTree = orchOccupation.component({ sessionId: 'session-superview', useChat: orchChatSeat, useSessions: orchSessionsSeat });
assert.equal(orchTree.type, 'div', 'the view renders a root div with live seats');
const orchChildCards = orchCollect(orchTree, (el) => el.props && String(el.props.className || '').includes('orchViewNode') && el.props['data-role'] === 'child');
assert.equal(orchChildCards.length, 2, 'both synthetic children render');
assert.deepEqual(orchChildCards.map((card) => card.props['data-state']).sort(), ['completed', 'running'], 'live running/completed states join from useSessions');
const orchCoordCards = orchCollect(orchTree, (el) => el.props && el.props['data-role'] === 'coordinator');
assert.equal(orchCoordCards.length, 1, 'exactly one supervisor card');
assert.equal(orchCoordCards[0].props['data-state'], 'running', 'the supervisor state comes from the same sessions source');
const orchEdgeEls = orchCollect(orchTree, (el) => el.type === 'path' && el.props && String(el.props.className || '').includes('orchViewEdge'));
assert.equal(orchEdgeEls.length, 5, '2 spawn + 1 send + 2 report edges render');
assert.equal(orchEdgeEls.filter((el) => String(el.props.className).includes('orchViewFlow')).length, 1, 'exactly the RECENT_MS report edge gets the dash-flow shimmer');
assert.ok(orchByText(orchTree, /steer/), 'the send edge carries its mode label');
assert.ok(orchByText(orchTree, /1\/3/), 'the todos chip joins n/m from the sessions projection');
assert.ok(orchByText(orchTree, /编组甲/), 'team names render (chip and/or row label)');
const orchEmptyTree = orchOccupation.component({ sessionId: 'session-plain' });
assert.equal(orchEmptyTree.type, 'div');
assert.ok(orchByText(orchEmptyTree, /未派发子任务|No tasks dispatched/), 'missing seats render the empty-state card');
assert.ok(orchCollect(orchEmptyTree, (el) => el.props && el.props['data-kind'] === 'error').length >= 1, 'missing seats render a diagnostics line');
// 0.21.1 (kept in 0.22.0): a chat window WITHOUT spawn records reports its
// scanned size — the window-truncation diagnostic behind the empty state.
const orchWindowTree = orchOccupation.component({ sessionId: 'session-superview', useChat: (selector) => selector({ order: ['n1'], nodes: { get: () => ({ kind: 'text', data: {} }) } }) });
assert.ok(orchByText(orchWindowTree, /已扫描当前转录窗口 1 条|Scanned 1 nodes/), 'the empty state reports the scanned window size');
const orchBrokenTree = orchOccupation.component({ sessionId: 'session-superview', useChat: () => { throw new Error('chat seat boom'); }, useSessions: orchSessionsSeat });
assert.ok(orchByText(orchBrokenTree, /chat seat boom/), 'a throwing seat surfaces its reason in a diagnostics line');

// 8f. degraded navigation: without a sessions service in sight (this slotCtx
// exposes no ctx.get) the child click falls back to copying the session id.
Object.defineProperty(globalThis, 'navigator', { value: { clipboard: { writeText: async (text) => { wrote.push(text); } } }, configurable: true });
orchChildCards[0].props.onClick();
await new Promise((resolve) => setImmediate(resolve));
assert.deepEqual(wrote.slice(-1), ['session-alpha'], 'degraded click copies the session id');
if (navDesc) Object.defineProperty(globalThis, 'navigator', navDesc);
else delete globalThis.navigator;

// 8g. static source guards: the orchestration jump must sight the sessions
// service through ctx.get() (the runner's inject gate throws on direct
// undeclared property reads), and the bundle never reads hostCtx.sessions.
assert.match(clientSrc, /hostCtx\.get\("sessions"\)/, 'the child-card jump must sight sessions via ctx.get()');
assert.match(clientSrc, /\.binding\(coordinatorId\)/, 'history paging goes through the sessions binding face');
assert.doesNotMatch(clientSrc, /hostCtx\.sessions\b/, 'no direct hostCtx.sessions property read (runner inject gate)');
assert.match(clientSrc, /name: "conversation\.view"/);
assert.match(clientSrc, /id: "orchestration"/);
console.log('client orchestration: OK -> view registered (id orchestration, order 20, ' + orchOccupation.options.label() + '), synthetic extraction (spawn/batch/steer/relay/malformed), deterministic layout, live/empty/throwing render probes, degraded copy fallback, ctx.get("sessions") jump + static guards');

console.log('\nALL INTEGRATION CHECKS PASSED');
// The degraded-click probe leaves a 6s flash timer behind; exit explicitly so
// the harness does not wait for it (all output above is synchronous).
process.exit(0);
