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
let createCount = 0;
// The supervisor session is a member of exactly one workspace; every spawn it
// performs must therefore carry workspaceId (host create: workspaceId XOR cwd).
const verifyWorkspace = { id: 'ws-verify', path: '/proj', sessionIds: ['session-super'] };

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
  // workspace-registry stand-in: the supervisor lives in one workspace, so
  // spawned children must attach to it (workspaceId in the create request).
  get(name) {
    if (name === 'workspaceRegistry') return {
      list: () => [verifyWorkspace],
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
      } : undefined),
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
      // mirror workspace.attachSession on workspaceId-based creation
      if (request.workspaceId === verifyWorkspace.id) verifyWorkspace.sessionIds.push(id);
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
assert.equal(ctx.provides.taskCoordinator.version, '0.15.0');
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
assert.equal(createRequests[0].workspaceId, 'ws-verify', 'spawn must attach the caller workspace');
assert.equal(createRequests[0].cwd, undefined, 'session.create takes workspaceId XOR cwd');
assert.equal(spawnResult.cwd, '/proj', 'result cwd reflects the workspace path');
assert.ok(verifyWorkspace.sessionIds.includes(spawnResult.sessionId), 'created session attached to the workspace');

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
console.log('task_workspace     : OK -> list/attach/detach + spawn cwd-upgrade verified');

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
// mock host composes no settings service, so every card/kickoff in this run
// already proved the graceful zh default end-to-end (汇报约定 asserts above).
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
  useState: (initial) => [initial, () => {}],
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
assert.equal(slotInjections.length, 1);
assert.equal(slotInjections[0].name, 'conversation.session.header.utilities');
const occupation = slotInjections[0].thunk();
assert.equal(occupation.options.id, 'copy-session-id');
assert.equal(typeof occupation.component, 'function');

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
if (navDesc) Object.defineProperty(globalThis, 'navigator', navDesc);
else delete globalThis.navigator;
console.log('client module      : OK -> dsh.client declared, bundle loads, slot occupied, copy writes sessionId');

console.log('\nALL INTEGRATION CHECKS PASSED');
