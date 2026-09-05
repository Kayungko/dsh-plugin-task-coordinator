/**
 * Smoke tests for dsh-plugin-task-coordinator.
 * Runs outside the host process: all harness objects are mocked.
 * Execute with: node --test test/
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { resolveConfig, DEFAULTS } from '../config.mjs';
import { checkCaller, checkTarget, SendLimiter, excerpt, blocksToText } from '../safety.mjs';
import { createOps } from '../ops.mjs';
import { registerTools } from '../tools.mjs';
import { buildSpawnTitle, mmdd, truncateTopic, firstLine } from '../title.mjs';
import { buildSkillsConfig, SKILL_PROVIDER_NAME, SKILLS_DIR } from '../skills.mjs';
import { SpawnRegistry } from '../registry.mjs';
import { parseTasksCommand, registerCommands, renderTaskList, renderProgress, callerFromInvocation } from '../commands.mjs';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/* ------------------------------------------------------------------ */
/* config                                                              */
/* ------------------------------------------------------------------ */

test('config: defaults', () => {
  const config = resolveConfig();
  assert.equal(config.enabled, true);
  assert.equal(config.allowSubagentUse, false);
  assert.equal(config.maxQueuePerTask, DEFAULTS.maxQueuePerTask);
  assert.deepEqual(config.titleTypes, ['功能', '设计', '修复', '优化', '发布', '探索', '文档', '研究']);
  assert.equal(config.titleFallbackType, '探索');
  assert.equal(config.titleMaxTopicChars, 16);
  assert.equal(config.titleTimeZone, 'Asia/Shanghai');
  assert.equal(config.maxBatchSpawn, 6);
  assert.equal(config.confirmBeforeBatch, true);
  assert.equal(config.confirmBatchThreshold, 2);
  assert.equal(config.maxSpawnDepth, 2);
});

test('config: overrides and clamps', () => {
  const config = resolveConfig({ maxQueuePerTask: 0, waitDefaultTimeoutMs: 90, waitMaxTimeoutMs: 10, titleMaxTopicChars: 0, maxBatchSpawn: 0, maxSpawnDepth: 0 });
  assert.equal(config.maxQueuePerTask, 1);
  assert.equal(config.waitDefaultTimeoutMs, 10);
  assert.equal(config.waitMaxTimeoutMs, 10);
  assert.equal(config.titleMaxTopicChars, 1);
  assert.equal(config.maxBatchSpawn, 1);
  assert.equal(config.maxSpawnDepth, 1);
  const custom = resolveConfig({ titleTypes: [' 功能 ', '研究'], titleFallbackType: '研究', titleTimeZone: 'UTC', maxBatchSpawn: 3, maxSpawnDepth: 4 });
  assert.deepEqual(custom.titleTypes, ['功能', '研究']);
  assert.equal(custom.titleFallbackType, '研究');
  assert.equal(custom.titleTimeZone, 'UTC');
  assert.equal(custom.maxBatchSpawn, 3);
  assert.equal(custom.maxSpawnDepth, 4);
});

test('config: wrong types throw', () => {
  assert.throws(() => resolveConfig({ enabled: 'yes' }), TypeError);
  assert.throws(() => resolveConfig({ maxQueuePerTask: -3 }), TypeError);
  assert.throws(() => resolveConfig({ titleFallbackType: 42 }), TypeError);
  assert.throws(() => resolveConfig({ titleTypes: '功能' }), TypeError);
  assert.throws(() => resolveConfig({ titleTypes: [] }), TypeError);
  assert.throws(() => resolveConfig({ titleTypes: ['功能', ''] }), TypeError);
  assert.throws(() => resolveConfig({ titleMaxTopicChars: -1 }), TypeError);
  assert.throws(() => resolveConfig({ maxBatchSpawn: 'six' }), TypeError);
  assert.throws(() => resolveConfig({ confirmBeforeBatch: 'yes' }), TypeError);
  assert.throws(() => resolveConfig({ confirmBatchThreshold: -1 }), TypeError);
  assert.throws(() => resolveConfig({ maxSpawnDepth: null }), TypeError);
});

/* ------------------------------------------------------------------ */
/* spawn-title rule: MMDD｜类型｜主题                                    */
/* ------------------------------------------------------------------ */

// Fixed timestamps around the Asia/Shanghai day boundary (+08:00).
const SH_BEFORE_MIDNIGHT = Date.UTC(2026, 8, 3, 15, 59); // 2026-09-03 23:59 CST
const SH_AFTER_MIDNIGHT = Date.UTC(2026, 8, 3, 16, 1);   // 2026-09-04 00:01 CST

test('title: mmdd uses creation time in Asia/Shanghai, never updatedAt', () => {
  assert.equal(mmdd(SH_BEFORE_MIDNIGHT, 'Asia/Shanghai'), '0903');
  assert.equal(mmdd(SH_AFTER_MIDNIGHT, 'Asia/Shanghai'), '0904');
  // same instant, other zones resolve to their own local date
  assert.equal(mmdd(SH_AFTER_MIDNIGHT, 'UTC'), '0903');
});

test('title: 类型｜主题 gets the date stamped', () => {
  const config = resolveConfig();
  assert.equal(
    buildSpawnTitle({ title: '修复｜对账精度', prompt: 'x' }, config, SH_AFTER_MIDNIGHT),
    '0904｜修复｜对账精度',
  );
});

test('title: bare topic never guesses a type (fallback 探索)', () => {
  const config = resolveConfig();
  assert.equal(
    buildSpawnTitle({ title: 'Migration', prompt: 'migrate' }, config, SH_AFTER_MIDNIGHT),
    '0904｜探索｜Migration',
  );
});

test('title: stale date prefix is re-stamped from createdAt', () => {
  const config = resolveConfig();
  assert.equal(
    buildSpawnTitle({ title: '0901｜设计｜旧日期标题', prompt: 'x' }, config, SH_AFTER_MIDNIGHT),
    '0904｜设计｜旧日期标题',
  );
});

test('title: halfwidth separator and legacy bracket prefix are normalized', () => {
  const config = resolveConfig();
  assert.equal(
    buildSpawnTitle({ title: '功能|支付模块迁移', prompt: 'x' }, config, SH_AFTER_MIDNIGHT),
    '0904｜功能｜支付模块迁移',
  );
  assert.equal(
    buildSpawnTitle({ title: '[团队] 优化批次文字显示', prompt: 'x' }, config, SH_AFTER_MIDNIGHT),
    '0904｜探索｜优化批次文字显示',
  );
});

test('title: missing title derives topic from the kickoff prompt first line', () => {
  const config = resolveConfig();
  // topic truncated to 16 chars: 调研 DSH 插件能否实现跨任务
  assert.equal(
    buildSpawnTitle({ prompt: '调研 DSH 插件能否实现跨任务协调\n补充说明行' }, config, SH_AFTER_MIDNIGHT),
    '0904｜探索｜调研 DSH 插件能否实现跨任务',
  );
});

test('title: topic truncated for sidebar display', () => {
  const config = resolveConfig();
  const long = '这是一个非常长的主题描述超过十六个字符应该被截断';
  const built = buildSpawnTitle({ title: `文档｜${long}` }, config, SH_AFTER_MIDNIGHT);
  const topic = built.split('｜')[2];
  assert.equal(topic.length, 16);
  assert.equal(truncateTopic(long, 16), long.slice(0, 16));
});

test('title: empty topic falls back to 新任务', () => {
  const config = resolveConfig();
  assert.equal(buildSpawnTitle({ title: '   ' }, config, SH_AFTER_MIDNIGHT), '0904｜探索｜新任务');
  assert.equal(firstLine(''), '');
});

test('title: custom type list and fallback are honored', () => {
  const config = resolveConfig({ titleTypes: ['需求', '缺陷'], titleFallbackType: '需求' });
  assert.equal(
    buildSpawnTitle({ title: '缺陷｜登录崩溃' }, config, SH_AFTER_MIDNIGHT),
    '0904｜缺陷｜登录崩溃',
  );
  assert.equal(
    buildSpawnTitle({ title: '修复｜不在类型表' }, config, SH_AFTER_MIDNIGHT),
    '0904｜需求｜修复｜不在类型表',
  );
});

/* ------------------------------------------------------------------ */
/* bundled skill mount config                                          */
/* ------------------------------------------------------------------ */

test('skills: isolated provider config serves only the bundled dir', () => {
  assert.equal(SKILL_PROVIDER_NAME, 'task-coordinator');
  const config = buildSkillsConfig();
  assert.equal(config.providerName, 'task-coordinator');
  assert.equal(config.includeDefaultRoots, false);
  assert.deepEqual(config.customSkillDirs, [SKILLS_DIR]);
  assert.match(SKILLS_DIR.replace(/\\/g, '/'), /skills$/);
});

/* ------------------------------------------------------------------ */
/* safety                                                              */
/* ------------------------------------------------------------------ */

test('safety: caller gates', () => {
  const config = resolveConfig();
  assert.equal(checkCaller({ sessionId: 'session-a' }, config), null);
  const subagentDeny = checkCaller({ sessionId: 'session-a', origin: 'subagent' }, config);
  assert.equal(subagentDeny.code, 'subagent-caller-denied');
  assert.match(subagentDeny.message, /subagent/);
  assert.equal(checkCaller({ sessionId: 'session-a', origin: 'subagent' }, resolveConfig({ allowSubagentUse: true })), null);
  const unknownDeny = checkCaller(null, config);
  assert.equal(unknownDeny.code, 'caller-unknown');
  assert.match(unknownDeny.message, /caller identity/);
});

test('safety: target gates', () => {
  const caller = { sessionId: 'session-a' };
  assert.equal(checkTarget(caller, undefined).code, 'target-not-found');
  assert.equal(checkTarget(caller, { sessionId: 'session-a' }).code, 'self-send-denied');
  assert.equal(checkTarget(caller, { sessionId: 'session-b', origin: 'subagent' }).code, 'subagent-target-denied');
  assert.equal(checkTarget(caller, { sessionId: 'session-b' }), null);
});

test('safety: limiter rate + depth', () => {
  let time = 1000;
  let depth = 0;
  const config = resolveConfig({ minSendIntervalMs: 5000, maxQueuePerTask: 2 });
  const limiter = new SendLimiter(config, () => depth, () => time);
  assert.equal(limiter.check('t1'), null);
  limiter.accept('t1');
  assert.equal(limiter.check('t1').code, 'rate-limited');
  time += 5000;
  assert.equal(limiter.check('t1'), null);
  depth = 2;
  assert.equal(limiter.check('t1').code, 'queue-full');
  limiter.forget('t1');
  depth = 0;
  assert.equal(limiter.check('t1'), null);
});

test('safety: excerpt and blocksToText', () => {
  assert.equal(excerpt('abcdef', 3), 'abc… (+3 chars)');
  assert.equal(excerpt('  ok  ', 10), 'ok');
  assert.equal(
    blocksToText([{ type: 'text', text: 'a' }, { type: 'tool-call', name: 'bash' }, { type: 'image' }, { type: 'text', text: 'b' }]),
    'a\n[tool-call: bash]\n[image]\nb',
  );
});

/* ------------------------------------------------------------------ */
/* ops mocks                                                           */
/* ------------------------------------------------------------------ */

function makeHarness(overrides = {}) {
  const calls = { create: [], prompt: [], rename: [], cancel: [], resolve: [], list: 0, inspect: [], selectModel: [], order: [] };
  const sessions = new Map(); // sessionId -> row
  const liveAgents = new Map(); // sessionId -> mock agent

  const sessionController = {
    async list() {
      calls.list += 1;
      return { items: [...sessions.values()] };
    },
    async create(request) {
      calls.create.push(request);
      calls.order.push('create');
      const id = request.sessionId ?? `session-created-${calls.create.length}`;
      sessions.set(id, {
        sessionId: id,
        updatedAt: Date.now(),
        running: false,
        blank: true,
        cwd: request.cwd,
        projections: { asOfSeq: 0, values: {} },
      });
      return { sessionId: id };
    },
    async rename(request) {
      calls.rename.push(request);
      const row = sessions.get(request.sessionId);
      if (row) row.projections.values.title = request.title;
      return { title: request.title, seq: 1 };
    },
    async prompt(request, signal) {
      // mirror the real Remote facade: signal is dereferenced unconditionally
      signal.throwIfAborted();
      calls.prompt.push(request);
      calls.order.push('prompt');
      const row = sessions.get(request.sessionId);
      if (row) {
        row.blank = false;
        row.running = true;
      }
      return { accepted: true };
    },
    async cancel(request) {
      calls.cancel.push(request);
      return { accepted: true };
    },
    async selectModel(request) {
      calls.selectModel.push(request);
      calls.order.push('selectModel');
      // mirror the host: an unknown model is rejected as session/model-unavailable
      if (request.model === 'model-bad') {
        throw new Error(`model "${request.model}" is not served by provider "${request.provider}"`);
      }
      return {
        selected: {
          provider: request.provider,
          model: request.model,
          ...(request.reasoningEffort === undefined ? {} : { reasoningEffort: request.reasoningEffort }),
        },
      };
    },
    async modelCatalog() {
      calls.modelCatalog = (calls.modelCatalog ?? 0) + 1;
      if (overrides.catalogError) throw new Error('catalog backend down');
      return overrides.catalog ?? {
        default: { provider: 'prov-a', model: 'model-x' },
        routableProviders: ['prov-a'],
        groups: [
          {
            id: 'prov-a',
            name: 'Provider A',
            models: [
              { id: 'model-x', name: 'Model X', reasoning: { efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }], defaultEffort: 'high' } },
              { id: 'model-y', name: 'model-y' },
            ],
          },
        ],
        failures: [{ id: 'prov-broken', name: 'Broken', message: 'unreachable' }],
      };
    },
    async resolveAgent(sessionId) {
      calls.resolve.push(sessionId);
      const agent = liveAgents.get(sessionId);
      if (!agent) return { error: { code: 'session-not-found', message: 'gone' } };
      if (agent.rejectResolve) return { error: { code: 'agent-busy', message: 'busy' } };
      return { agent };
    },
    async inspect(sessionId) {
      calls.inspect.push(sessionId);
      return {
        meta: { id: sessionId },
        events: [
          { type: 'user/message', seq: 1, time: 1, data: { content: [{ type: 'text', text: 'cold question' }], source: { kind: 'user' } } },
          { type: 'assistant/message', seq: 2, time: 2, data: { message: { content: [{ type: 'text', text: 'cold answer' }] } } },
        ],
      };
    },
  };
  if (overrides.catalogMissing) delete sessionController.modelCatalog; // simulate a host build without the catalog method

  const agents = { get: (id) => liveAgents.get(id) };
  const created = [];
  const createUserMessage = ({ content, source }) => {
    const message = Object.freeze({ id: `msg-${created.length + 1}`, role: 'user', content, source });
    created.push(message);
    return message;
  };

  const harness = {
    calls,
    sessions,
    liveAgents,
    created,
    ops: null,
    ...overrides,
  };
  const config = resolveConfig(overrides.config ?? {});
  const limiter = new SendLimiter(config, (id) => harness.ops.pendingCount(id));
  // Default confirmation channel: auto-approve the first option (the approve
  // label is always options[0]); tests can override or pass null to simulate
  // a missing channel.
  const askUser = Object.hasOwn(overrides, 'askUser')
    ? overrides.askUser
    : async (request) => ({ answers: request.questions.map((question) => ({ id: question.id, selected: [question.options[0].label] })) });
  harness.ops = createOps({
    sessionController,
    agents,
    createUserMessage,
    config,
    limiter,
    ...(overrides.registry ? { registry: overrides.registry } : {}),
    ...(overrides.listWorkspaces ? { listWorkspaces: overrides.listWorkspaces } : {}),
    ...(overrides.getWorkspace ? { getWorkspace: overrides.getWorkspace } : {}),
    ...(overrides.resolveModelConfig ? { resolveModelConfig: overrides.resolveModelConfig } : {}),
    ...(overrides.listModelProviders ? { listModelProviders: overrides.listModelProviders } : {}),
    ...(overrides.listProviderModels ? { listProviderModels: overrides.listProviderModels } : {}),
    uuid: () => 'req-test-1',
    askUser,
  });
  return harness;
}

function addRow(harness, row) {
  harness.sessions.set(row.sessionId, {
    updatedAt: Date.now(),
    running: false,
    blank: false,
    projections: { asOfSeq: 0, values: {} },
    ...row,
  });
}

function addLiveAgent(harness, sessionId, { status = 'running', events = [], nextTurn = [], nextStep = [] } = {}) {
  const agent = {
    id: sessionId,
    status,
    followups: [],
    steers: [],
    followup(message) {
      this.followups.push(message);
    },
    steer(message) {
      this.steers.push(message);
    },
    whenIdle() {
      return this.idlePromise ?? Promise.resolve();
    },
    inbox: { nextTurn, nextStep },
    session: { id: sessionId, seq: events.length, events, header: { id: sessionId } },
  };
  harness.liveAgents.set(sessionId, agent);
  return agent;
}

const SUPERVISOR = { sessionId: 'session-super', cwd: '/work' };

/* ------------------------------------------------------------------ */
/* ops                                                                 */
/* ------------------------------------------------------------------ */

test('ops.listTasks: hides subagents, filters, summarizes', async () => {
  const harness = makeHarness();
  addRow(harness, { sessionId: 'session-a', projections: { asOfSeq: 1, values: { title: 'Migrate payments', todos: [{ content: 'x', status: 'completed' }, { content: 'y', status: 'in_progress' }] } }, running: true });
  addRow(harness, { sessionId: 'session-child', origin: 'subagent' });
  addRow(harness, { sessionId: 'session-b', cwd: '/other' });
  const all = await harness.ops.listTasks({}, SUPERVISOR);
  assert.equal(all.ok, true);
  assert.equal(all.count, 2);
  assert.deepEqual(all.tasks.map((task) => task.sessionId), ['session-a', 'session-b']);
  assert.equal(all.tasks[0].title, 'Migrate payments');
  assert.equal(all.tasks[0].status, 'running');
  assert.equal(all.tasks[0].todos, '1/2 done');
  const filtered = await harness.ops.listTasks({ filter: 'payments' }, SUPERVISOR);
  assert.equal(filtered.count, 1);
  const withSubagents = await harness.ops.listTasks({ includeSubagents: true }, SUPERVISOR);
  assert.equal(withSubagents.count, 3);
});

test('ops.progress: live agent with queue and tail', async () => {
  const harness = makeHarness();
  addRow(harness, { sessionId: 'session-a', projections: { asOfSeq: 1, values: { title: 'A' } } });
  addLiveAgent(harness, 'session-a', {
    status: 'running',
    events: [
      { type: 'user/message', seq: 1, time: 1, data: { content: [{ type: 'text', text: 'do the thing' }], source: { kind: 'user' } } },
      { type: 'assistant/message', seq: 2, time: 2, data: { message: { content: [{ type: 'text', text: 'doing it now' }] } } },
    ],
    nextTurn: [{ content: [{ type: 'text', text: 'queued note' }], source: { kind: 'coordinator' } }],
  });
  const result = await harness.ops.progress('session-a', SUPERVISOR);
  assert.equal(result.ok, true);
  assert.equal(result.agentState, 'running');
  assert.equal(result.queue.length, 1);
  assert.equal(result.queue[0].placement, 'next-turn');
  assert.equal(result.queue[0].text, 'queued note');
  assert.equal(result.recent.length, 2);
  assert.equal(result.recent[1].text, 'doing it now');
});

test('ops.progress: cold session falls back to inspect', async () => {
  const harness = makeHarness();
  addRow(harness, { sessionId: 'session-cold' });
  const result = await harness.ops.progress('session-cold', SUPERVISOR);
  assert.equal(result.agentState, 'cold-idle');
  assert.deepEqual(result.recent.map((entry) => entry.text), ['cold question', 'cold answer']);
  assert.equal(harness.calls.inspect.length, 1);
});

test('ops.sendMessage: self-address rejected', async () => {
  const harness = makeHarness();
  addRow(harness, { sessionId: 'session-super' });
  const result = await harness.ops.sendMessage({ targetId: 'session-super', text: 'hi' }, SUPERVISOR);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'self-send-denied');
  assert.match(result.error, /itself/);
});

test('ops.sendMessage: queue delivery with coordinator source', async () => {
  const harness = makeHarness();
  addRow(harness, { sessionId: 'session-a' });
  const agent = addLiveAgent(harness, 'session-a');
  const result = await harness.ops.sendMessage({ targetId: 'session-a', text: 'adjust the plan' }, SUPERVISOR);
  assert.equal(result.ok, true);
  assert.equal(result.placement.startsWith('next-turn'), true);
  assert.equal(agent.followups.length, 1);
  assert.equal(agent.steers.length, 0);
  const message = harness.created[0];
  assert.equal(message.source.kind, 'coordinator');
  assert.equal(message.source.form, 'relay');
  assert.equal(message.source.senderSessionId, 'session-super');
  assert.equal(message.content[0].text, 'adjust the plan');
});

test('ops.sendMessage: steer delivery', async () => {
  const harness = makeHarness();
  addRow(harness, { sessionId: 'session-a' });
  const agent = addLiveAgent(harness, 'session-a');
  const result = await harness.ops.sendMessage({ targetId: 'session-a', text: 'keep compat', mode: 'steer' }, SUPERVISOR);
  assert.equal(result.ok, true);
  assert.equal(agent.steers.length, 1);
  assert.equal(agent.followups.length, 0);
});

test('ops.sendMessage: busy target maps to retryable error', async () => {
  const harness = makeHarness();
  addRow(harness, { sessionId: 'session-a' });
  addLiveAgent(harness, 'session-a', {}).rejectResolve = true;
  const result = await harness.ops.sendMessage({ targetId: 'session-a', text: 'x' }, SUPERVISOR);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'target-busy');
  assert.match(result.error, /retry/);
});

test('ops.spawnTask: create + rename + kickoff', async () => {
  const harness = makeHarness();
  const result = await harness.ops.spawnTask({ title: '功能｜迁移支付模块', prompt: 'migrate the module', cwd: '/proj' }, SUPERVISOR);
  assert.equal(result.ok, true);
  assert.equal(result.started, true);
  assert.match(result.title, /^\d{4}｜功能｜迁移支付模块$/);
  assert.equal(harness.calls.create.length, 1);
  assert.equal(harness.calls.create[0].cwd, '/proj');
  assert.equal(harness.calls.rename[0].title, result.title);
  assert.equal(harness.calls.prompt[0].mode, 'queue');
  // report-back convention (default on): original prompt first, then the
  // push-back instruction naming the caller session.
  const kickoff = harness.calls.prompt[0].content[0].text;
  assert.ok(kickoff.startsWith('migrate the module'));
  assert.match(kickoff, /汇报约定/);
  assert.match(kickoff, /task_send/);
  assert.match(kickoff, /session-super/);
  assert.equal(harness.calls.prompt[0].sessionId, result.sessionId);
  // new session row exists -> visible in list
  const listing = await harness.ops.listTasks({}, SUPERVISOR);
  assert.ok(listing.tasks.some((task) => task.sessionId === result.sessionId));
});

test('ops.spawnTask/spawnBatch: reportBack toggle', async () => {
  const harness = makeHarness();
  // opt out: kickoff is exactly the user prompt
  const quiet = await harness.ops.spawnTask({ prompt: 'solo work', reportBack: false }, SUPERVISOR);
  assert.equal(quiet.ok, true);
  assert.equal(harness.calls.prompt[0].content[0].text, 'solo work');
  // batch applies the convention to every item by default
  const confirmed = await harness.ops.confirmPlan({ plan: '# 派发计划' }, SUPERVISOR);
  const batch = await harness.ops.spawnBatch({
    tasks: [{ prompt: 'item one' }, { prompt: 'item two' }],
    confirmationId: confirmed.confirmationId,
  }, SUPERVISOR);
  assert.equal(batch.ok, true);
  const batchTexts = harness.calls.prompt.slice(1).map((request) => request.content[0].text);
  assert.equal(batchTexts.length, 2);
  for (const text of batchTexts) {
    assert.match(text, /汇报约定/);
    assert.match(text, /session-super/);
  }
  // batch opt-out
  const confirmed2 = await harness.ops.confirmPlan({ plan: '# 派发计划' }, SUPERVISOR);
  const quietBatch = await harness.ops.spawnBatch({
    tasks: [{ prompt: 'item three' }, { prompt: 'item four' }],
    confirmationId: confirmed2.confirmationId,
    reportBack: false,
  }, SUPERVISOR);
  assert.equal(quietBatch.ok, true);
  const quietTexts = harness.calls.prompt.slice(3).map((request) => request.content[0].text);
  assert.deepEqual(quietTexts, ['item three', 'item four']);
});

test('ops.spawnTask: defaults cwd to caller; title derived from kickoff prompt', async () => {
  const harness = makeHarness();
  const result = await harness.ops.spawnTask({ prompt: 'go' }, SUPERVISOR);
  assert.equal(result.ok, true);
  assert.equal(harness.calls.create[0].cwd, '/work');
  // no explicit title -> MMDD｜fallback-type｜first-line-of-prompt
  assert.match(result.title, /^\d{4}｜探索｜go$/);
  assert.equal(harness.calls.rename.length, 1);
  assert.ok(String(result.correlationId).length > 0);
});

test('ops.spawnTask: workspace inheritance — child attaches to caller workspace', async () => {
  const workspaces = [{ id: 'ws-1', path: '/ws/proj', sessionIds: ['session-super'] }];
  const harness = makeHarness({ listWorkspaces: () => workspaces });
  const result = await harness.ops.spawnTask({ prompt: 'in-workspace work' }, SUPERVISOR);
  assert.equal(result.ok, true);
  assert.equal(harness.calls.create[0].workspaceId, 'ws-1');
  assert.equal(harness.calls.create[0].cwd, undefined); // host derives cwd from the workspace path
  // an explicit cwd intentionally overrides workspace inheritance
  const overridden = await harness.ops.spawnTask({ prompt: 'elsewhere', cwd: '/other' }, SUPERVISOR);
  assert.equal(overridden.ok, true);
  assert.equal(harness.calls.create[1].cwd, '/other');
  assert.equal(harness.calls.create[1].workspaceId, undefined);
});

test('ops.spawnTask: workspace inheritance — ancestor chain and degradation', async () => {
  // caller is not a direct member, but its recorded spawn parent is
  const workspaces = [{ id: 'ws-2', path: '/ws2', sessionIds: ['session-root'] }];
  const fakeRegistry = {
    get: (id) => (id === 'session-super' ? { parentSessionId: 'session-root' } : undefined),
    record: () => {},
  };
  const harness = makeHarness({ listWorkspaces: () => workspaces, registry: fakeRegistry });
  const result = await harness.ops.spawnTask({ prompt: 'grandchild work' }, SUPERVISOR);
  assert.equal(result.ok, true);
  assert.equal(harness.calls.create[0].workspaceId, 'ws-2');
  // a throwing registry snapshot degrades to caller cwd — spawn never fails on it
  const broken = makeHarness({ listWorkspaces: () => { throw new Error('registry gone'); } });
  const fallback = await broken.ops.spawnTask({ prompt: 'plain work' }, SUPERVISOR);
  assert.equal(fallback.ok, true);
  assert.equal(broken.calls.create[0].cwd, '/work');
  assert.equal(broken.calls.create[0].workspaceId, undefined);
});

test('ops.spawnBatch: workspace inheritance applies to every item', async () => {
  const workspaces = [{ id: 'ws-3', path: '/ws3', sessionIds: ['session-super'] }];
  const harness = makeHarness({ listWorkspaces: () => workspaces, config: { confirmBeforeBatch: false } });
  const batch = await harness.ops.spawnBatch({ tasks: [{ prompt: 'a' }, { prompt: 'b' }] }, SUPERVISOR);
  assert.equal(batch.ok, true);
  assert.equal(harness.calls.create.length, 2);
  for (const request of harness.calls.create) assert.equal(request.workspaceId, 'ws-3');
});

test('resolveCallerWorkspaceId: pure-function edge cases', async () => {
  const { resolveCallerWorkspaceId } = await import('../ops.mjs');
  assert.equal(resolveCallerWorkspaceId('session-x', null, undefined), undefined);
  assert.equal(resolveCallerWorkspaceId('session-x', null, () => []), undefined);
  assert.equal(resolveCallerWorkspaceId('session-x', null, () => [{ id: 'ws', sessionIds: ['other'] }]), undefined);
  assert.equal(resolveCallerWorkspaceId('session-x', null, () => [{ id: 'ws', sessionIds: ['session-x'] }]), 'ws');
  assert.equal(resolveCallerWorkspaceId('session-x', null, () => [{ sessionIds: ['session-x'] }]), undefined); // no id
  assert.equal(resolveCallerWorkspaceId('session-x', null, () => { throw new Error('boom'); }), undefined);
  assert.equal(resolveCallerWorkspaceId('', null, () => [{ id: 'ws', sessionIds: [''] }]), undefined);
});

test('normalizeWorkspacePath / findWorkspaceByPath: pure-function edge cases (0.12.0)', async () => {
  const { findWorkspaceByPath } = await import('../ops.mjs');
  assert.equal(findWorkspaceByPath(undefined, () => [{ id: 'ws', path: '/a' }]), undefined);
  assert.equal(findWorkspaceByPath('/a', undefined), undefined);
  assert.equal(findWorkspaceByPath('/b', () => [{ id: 'ws', path: '/a' }]), undefined);
  assert.equal(findWorkspaceByPath('/a/', () => [{ id: 'ws', path: '/a' }])?.id, 'ws'); // trailing-sep normalization is portable
  assert.equal(findWorkspaceByPath('/a', () => { throw new Error('boom'); }), undefined);
});

test('normalizeWorkspacePath: platform branches (0.12.1)', async () => {
  const { normalizeWorkspacePath, findWorkspaceByPath } = await import('../ops.mjs');
  // win32: separators unified, case folded, drive root kept
  assert.equal(normalizeWorkspacePath('D:/git/Proj/', 'win32'), 'd:\\git\\proj');
  assert.equal(normalizeWorkspacePath('  d:\\git\\PROJ ', 'win32'), 'd:\\git\\proj');
  assert.equal(normalizeWorkspacePath('D:\\', 'win32'), 'd:\\');
  // darwin: case folded (default volumes are case-insensitive), separators untouched
  assert.equal(normalizeWorkspacePath('/Git/Proj/', 'darwin'), '/git/proj');
  // linux: case preserved, backslash is a regular filename character
  assert.equal(normalizeWorkspacePath('/Git/Proj/', 'linux'), '/Git/Proj');
  assert.equal(normalizeWorkspacePath('/Git\\Proj', 'linux'), '/Git\\Proj');
  // case-variant directories only collide on case-insensitive platforms
  const list = () => [{ id: 'ws', path: '/Git/Proj' }];
  assert.equal(findWorkspaceByPath('/git/proj', list, 'darwin')?.id, 'ws');
  assert.equal(findWorkspaceByPath('/git/proj', list, 'linux'), undefined);
  assert.equal(findWorkspaceByPath('/Git/Proj/', list, 'linux')?.id, 'ws');
  // win32 cross-separator + case variance matches
  assert.equal(findWorkspaceByPath('d:/GIT/proj/', () => [{ id: 'ws', path: 'D:\\git\\PROJ' }], 'win32')?.id, 'ws');
});

test('ops.spawnTask: cwd→workspace upgrade — exact path match attaches (0.12.0)', async () => {
  const workspaces = [{ id: 'ws-proj', path: '/git/proj', sessionIds: [] }];
  const harness = makeHarness({ listWorkspaces: () => workspaces });
  // explicit cwd with a trailing separator still matches (portable form;
  // case/separator variance is covered per-platform in the pure-function test)
  const spawned = await harness.ops.spawnTask({ prompt: 'work', cwd: '/git/proj/' }, SUPERVISOR);
  assert.equal(spawned.ok, true);
  assert.equal(harness.calls.create[0].workspaceId, 'ws-proj');
  assert.equal(harness.calls.create[0].cwd, undefined); // host derives cwd from the workspace path
  // a non-matching explicit cwd keeps legacy ungrouped semantics
  const plain = await harness.ops.spawnTask({ prompt: 'work', cwd: '/git/other' }, SUPERVISOR);
  assert.equal(plain.ok, true);
  assert.equal(harness.calls.create[1].cwd, '/git/other');
  assert.equal(harness.calls.create[1].workspaceId, undefined);
});

test('ops.spawnTask: ungrouped supervisor upgrades children by its own cwd (0.12.0)', async () => {
  // caller is not a member of any workspace, but its cwd IS a workspace path
  const workspaces = [{ id: 'ws-home', path: '/work', sessionIds: ['someone-else'] }];
  const harness = makeHarness({ listWorkspaces: () => workspaces });
  const spawned = await harness.ops.spawnTask({ prompt: 'child work' }, SUPERVISOR);
  assert.equal(spawned.ok, true);
  assert.equal(harness.calls.create[0].workspaceId, 'ws-home');
  assert.equal(harness.calls.create[0].cwd, undefined);
});

test('ops.workspaceOp: list / attach / detach through the live entity (0.12.0)', async () => {
  const workspaces = [{ id: 'ws-proja', path: '/proj/a', title: 'ProjA', sessionIds: ['session-old'] }];
  const entityCalls = [];
  const entity = {
    attachSession: async (sessionId) => {
      entityCalls.push(['attach', sessionId]);
      workspaces[0].sessionIds = [sessionId, ...workspaces[0].sessionIds];
    },
    detachSession: async (sessionId) => {
      entityCalls.push(['detach', sessionId]);
      workspaces[0].sessionIds = workspaces[0].sessionIds.filter((id) => id !== sessionId);
    },
  };
  const harness = makeHarness({ listWorkspaces: () => workspaces, getWorkspace: (id) => (id === 'ws-proja' ? entity : undefined) });
  const listed = await harness.ops.workspaceOp({ action: 'list' }, SUPERVISOR);
  assert.equal(listed.ok, true);
  assert.deepEqual(listed.workspaces[0], { id: 'ws-proja', path: '/proj/a', title: 'ProjA', sessionIds: ['session-old'] });
  // attach by path with a trailing-separator variance
  const attached = await harness.ops.workspaceOp({ action: 'attach', sessionId: 'session-new', workspacePath: '/proj/a/' }, SUPERVISOR);
  assert.equal(attached.ok, true);
  assert.equal(attached.workspaceId, 'ws-proja');
  assert.deepEqual(entityCalls[0], ['attach', 'session-new']);
  // attach by explicit id; then detach (undo path)
  const byId = await harness.ops.workspaceOp({ action: 'attach', sessionId: 'session-x', workspaceId: 'ws-proja' }, SUPERVISOR);
  assert.equal(byId.ok, true);
  const detached = await harness.ops.workspaceOp({ action: 'detach', sessionId: 'session-x', workspaceId: 'ws-proja' }, SUPERVISOR);
  assert.equal(detached.ok, true);
  assert.deepEqual(entityCalls.map(([op]) => op), ['attach', 'attach', 'detach']);
  // default action is list
  const implicit = await harness.ops.workspaceOp({}, SUPERVISOR);
  assert.equal(implicit.action, 'list');
});

test('ops.workspaceOp: failure modes (0.12.0)', async () => {
  const workspaces = [{ id: 'ws-1', path: '/ws1', sessionIds: [] }];
  const strict = {
    attachSession: async () => { throw new Error("cannot attach session 'session-bad' to workspace '/ws1': its cwd resolves to '/elsewhere'"); },
    detachSession: async () => {},
  };
  const harness = makeHarness({ listWorkspaces: () => workspaces, getWorkspace: (id) => (id === 'ws-1' ? strict : undefined) });
  assert.equal((await harness.ops.workspaceOp({ action: 'teleport' }, SUPERVISOR)).code, 'bad-request');
  assert.equal((await harness.ops.workspaceOp({ action: 'attach' }, SUPERVISOR)).code, 'bad-request'); // no sessionId
  assert.equal((await harness.ops.workspaceOp({ action: 'attach', sessionId: 's', workspacePath: '/nope' }, SUPERVISOR)).code, 'workspace-not-found');
  assert.equal((await harness.ops.workspaceOp({ action: 'attach', sessionId: 's', workspaceId: 'ws-ghost' }, SUPERVISOR)).code, 'workspace-not-found');
  const rejected = await harness.ops.workspaceOp({ action: 'attach', sessionId: 'session-bad', workspaceId: 'ws-1' }, SUPERVISOR);
  assert.equal(rejected.code, 'workspace-op-failed');
  assert.match(rejected.error, /cwd resolves to/); // host validation message preserved
  // no registry service at all -> not-found, never a crash
  const bare = makeHarness({ listWorkspaces: () => workspaces });
  assert.equal((await bare.ops.workspaceOp({ action: 'attach', sessionId: 's', workspaceId: 'ws-1' }, SUPERVISOR)).code, 'workspace-not-found');
});

test('ops.spawnTask: model selection — pair validation and effort-only ignored (0.13.0)', async () => {
  const harness = makeHarness();
  assert.equal((await harness.ops.spawnTask({ prompt: 'x', provider: 'p' }, SUPERVISOR)).code, 'bad-request');
  assert.equal((await harness.ops.spawnTask({ prompt: 'x', model: 'm' }, SUPERVISOR)).code, 'bad-request');
  assert.equal(harness.calls.create.length, 0);
  // reasoningEffort without provider+model is ignored, not an error
  const plain = await harness.ops.spawnTask({ prompt: 'x', reasoningEffort: 'high' }, SUPERVISOR);
  assert.equal(plain.ok, true);
  assert.equal(harness.calls.selectModel.length, 0);
});

test('ops.spawnTask: model selection — catalog pre-validation prevents orphans (0.13.0)', async () => {
  const harness = makeHarness({ resolveModelConfig: () => Promise.reject(new Error('no such model "ghost"')) });
  const result = await harness.ops.spawnTask({ prompt: 'x', provider: 'p', model: 'ghost' }, SUPERVISOR);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'model-unavailable');
  assert.match(result.error, /no such model/);
  assert.equal(harness.calls.create.length, 0); // nothing was created
});

test('ops.spawnTask: model selection — installed between create and kickoff (0.13.0)', async () => {
  const harness = makeHarness({ resolveModelConfig: () => Promise.resolve({}) });
  const result = await harness.ops.spawnTask({ prompt: 'model work', provider: 'prov-a', model: 'model-x', reasoningEffort: 'high' }, SUPERVISOR);
  assert.equal(result.ok, true);
  assert.deepEqual(result.model, { provider: 'prov-a', model: 'model-x', reasoningEffort: 'high' });
  assert.deepEqual(harness.calls.selectModel[0], { sessionId: result.sessionId, provider: 'prov-a', model: 'model-x', reasoningEffort: 'high' });
  // ordering: the model is installed BEFORE the first turn is kicked off
  assert.deepEqual(harness.calls.order, ['create', 'selectModel', 'prompt']);
});

test('ops.spawnTask: model selection — install failure reports the orphan, no kickoff (0.13.0)', async () => {
  const harness = makeHarness(); // no catalog pre-check available; selectModel mock rejects 'model-bad'
  const result = await harness.ops.spawnTask({ prompt: 'x', provider: 'p', model: 'model-bad' }, SUPERVISOR);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'model-select-failed');
  assert.ok(result.sessionId, 'the created orphan stays traceable');
  assert.equal(harness.calls.prompt.length, 0); // never kicked off on the wrong model
});

test('ops.spawnTask: model selection — degrades when the catalog service is absent (0.13.0)', async () => {
  const harness = makeHarness({ resolveModelConfig: () => undefined });
  const result = await harness.ops.spawnTask({ prompt: 'x', provider: 'p', model: 'model-x' }, SUPERVISOR);
  assert.equal(result.ok, true); // selectModel is the authoritative validation then
  assert.deepEqual(harness.calls.order, ['create', 'selectModel', 'prompt']);
});

test('ops.spawnBatch: per-item model selections are forwarded (0.13.0)', async () => {
  const harness = makeHarness({ config: { confirmBeforeBatch: false } });
  const batch = await harness.ops.spawnBatch({
    tasks: [
      { prompt: 'heavy', provider: 'prov-a', model: 'model-big' },
      { prompt: 'light', provider: 'prov-b', model: 'model-small', reasoningEffort: 'low' },
    ],
  }, SUPERVISOR);
  assert.equal(batch.ok, true);
  assert.equal(harness.calls.selectModel.length, 2);
  assert.deepEqual(harness.calls.selectModel.map((request) => request.model), ['model-big', 'model-small']);
  assert.equal(harness.calls.selectModel[1].reasoningEffort, 'low');
});

test('ops.models: live catalog projection (0.14.0)', async () => {
  const harness = makeHarness();
  const result = await harness.ops.models({}, SUPERVISOR);
  assert.equal(result.ok, true);
  assert.deepEqual(result.default, { provider: 'prov-a', model: 'model-x' });
  assert.deepEqual(result.providers, [
    {
      id: 'prov-a',
      name: 'Provider A',
      models: [
        { id: 'model-x', name: 'Model X', efforts: ['low', 'high'], defaultEffort: 'high' },
        { id: 'model-y' }, // name equal to id omitted; no reasoning -> no efforts field
      ],
    },
  ]);
  assert.deepEqual(result.failedProviders, [{ id: 'prov-broken', message: 'unreachable' }]);
  assert.match(result.hint, /task_spawn/);
});

test('ops.models: degradation on old or broken hosts (0.14.0)', async () => {
  const missing = makeHarness({ catalogMissing: true });
  assert.equal((await missing.ops.models({}, SUPERVISOR)).code, 'catalog-unavailable');
  const broken = makeHarness({ catalogError: true });
  const result = await broken.ops.models({}, SUPERVISOR);
  assert.equal(result.code, 'catalog-unavailable');
  assert.match(result.error, /catalog backend down/);
});

test('describeModelRoutes: actionable hints, failure-tolerant (0.14.0)', async () => {
  const { describeModelRoutes } = await import('../ops.mjs');
  const providers = () => [{ id: 'prov-a' }, { id: 'prov-b' }];
  const models = async (id) => (id === 'prov-a' ? [{ id: 'model-x' }, { id: 'model-y' }] : []);
  assert.match(await describeModelRoutes('prov-a', providers, models), /models served by provider "prov-a": model-x, model-y/);
  // unknown provider -> falls back to the routable provider list
  assert.match(await describeModelRoutes('ghost', providers, models), /routable providers in this deployment: prov-a, prov-b/);
  // throwing or missing deps -> empty hint, never throws
  assert.equal(await describeModelRoutes('prov-a', () => { throw new Error('x'); }, undefined), '');
  assert.equal(await describeModelRoutes('prov-a', undefined, undefined), '');
});

test('ops.spawnTask: model-unavailable error carries the route hint (0.14.0)', async () => {
  const harness = makeHarness({
    resolveModelConfig: () => Promise.reject(new Error('no such model "ghost"')),
    listProviderModels: async (id) => (id === 'prov-a' ? [{ id: 'model-x' }] : []),
    listModelProviders: () => [{ id: 'prov-a' }],
  });
  const result = await harness.ops.spawnTask({ prompt: 'x', provider: 'prov-a', model: 'ghost' }, SUPERVISOR);
  assert.equal(result.code, 'model-unavailable');
  assert.match(result.error, /models served by provider "prov-a": model-x/);
  assert.match(result.error, /task_models/);
  assert.equal(harness.calls.create.length, 0);
});

test('ops.spawnTask: kickoff failure reports the orphan', async () => {
  const harness = makeHarness();
  const { ops } = harness;
  const original = harness.ops.spawnTask;
  assert.equal(typeof original, 'function');
  // break prompt
  harness.sessions.set('session-break', { sessionId: 'session-break', updatedAt: 0, running: false, blank: true, projections: { asOfSeq: 0, values: {} } });
  const brokenOps = createOps({
    sessionController: {
      list: async () => ({ items: [...harness.sessions.values()] }),
      create: async () => ({ sessionId: 'session-new' }),
      rename: async () => ({ title: 't', seq: 1 }),
      prompt: async () => {
        throw new Error('model-unavailable');
      },
      resolveAgent: async () => ({ error: { code: 'internal', message: 'x' } }),
      cancel: async () => ({ accepted: true }),
      inspect: async () => ({ events: [] }),
    },
    agents: { get: () => undefined },
    createUserMessage: () => ({}),
    config: resolveConfig(),
    limiter: new SendLimiter(resolveConfig(), () => 0),
    uuid: () => 'r',
  });
  const result = await brokenOps.spawnTask({ prompt: 'go' }, SUPERVISOR);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'kickoff-rejected');
  assert.equal(result.sessionId, 'session-new');
  assert.match(result.error, /created but the kickoff prompt was rejected/);
});

test('ops.spawnBatch: creates the whole plan under one team (with confirmation)', async () => {
  const registry = new SpawnRegistry(tempRegistryPath());
  const harness = makeHarness({ registry });
  const confirmed = await harness.ops.confirmPlan({ plan: '# 拆成两个独立模块' }, SUPERVISOR);
  assert.equal(confirmed.ok, true);
  assert.equal(confirmed.approved, true);
  assert.ok(confirmed.confirmationId.startsWith('confirm-'));
  const result = await harness.ops.spawnBatch({
    tasks: [
      { title: '功能｜模块A', prompt: 'do A' },
      { title: '功能｜模块B', prompt: 'do B' },
    ],
    team: '支付重构',
    confirmationId: confirmed.confirmationId,
  }, SUPERVISOR);
  assert.equal(result.ok, true);
  assert.equal(result.startedCount, 2);
  assert.equal(result.failedCount, 0);
  assert.equal(result.team, '支付重构');
  assert.equal(result.results.length, 2);
  for (const item of result.results) {
    assert.equal(item.ok, true);
    assert.equal(item.depth, 1);
    assert.equal(registry.get(item.sessionId).team, '支付重构');
  }
  const grouped = await harness.ops.listTasks({ team: '支付重构' }, SUPERVISOR);
  assert.equal(grouped.count, 2);
  // confirmation is single-use
  const reuse = await harness.ops.spawnBatch({ tasks: [{ prompt: 'x' }, { prompt: 'y' }], confirmationId: confirmed.confirmationId }, SUPERVISOR);
  assert.equal(reuse.code, 'confirmation-required');
});

test('ops.confirmPlan: decline, cancel and channel errors', async () => {
  const harness = makeHarness();
  // decline with custom feedback
  const declineChannel = async (request) => ({ answers: request.questions.map((question) => ({ id: question.id, selected: ['暂不派发'], custom: '先只做模块A' })) });
  const harnessDecline = makeHarness({ askUser: declineChannel });
  const declined = await harnessDecline.ops.confirmPlan({ plan: '# 派发计划' }, SUPERVISOR);
  assert.equal(declined.ok, true);
  assert.equal(declined.approved, false);
  assert.equal(declined.feedback, '先只做模块A');
  // decline without custom text falls back to the selected label
  const harnessPlainDecline = makeHarness({ askUser: async (request) => ({ answers: request.questions.map((question) => ({ id: question.id, selected: ['暂不派发'] })) }) });
  assert.equal((await harnessPlainDecline.ops.confirmPlan({ plan: '# 派发计划' }, SUPERVISOR)).feedback, '暂不派发');
  // user closed the card
  const harnessCancel = makeHarness({ askUser: async () => { throw Object.assign(new Error('closed'), { code: 'ASK_CANCELLED' }); } });
  const cancelled = await harnessCancel.ops.confirmPlan({ plan: '# 派发计划' }, SUPERVISOR);
  assert.equal(cancelled.code, 'confirm-cancelled');
  assert.match(cancelled.error, /wait for the user/);
  // no UI connected
  const harnessNoProvider = makeHarness({ askUser: async () => { throw Object.assign(new Error('none'), { code: 'NO_PROVIDER' }); } });
  assert.equal((await harnessNoProvider.ops.confirmPlan({ plan: '# 派发计划' }, SUPERVISOR)).code, 'no-question-channel');
  // subagent caller cannot ask a human
  const harnessDelegated = makeHarness({ askUser: async () => { throw Object.assign(new Error('owned'), { code: 'DELEGATED_CALLER' }); } });
  assert.equal((await harnessDelegated.ops.confirmPlan({ plan: '# 派发计划' }, SUPERVISOR)).code, 'delegated-caller');
  // channel missing entirely
  const harnessNoChannel = makeHarness({ askUser: null });
  assert.equal((await harnessNoChannel.ops.confirmPlan({ plan: '# 派发计划' }, SUPERVISOR)).code, 'no-question-channel');
  // invalid plan
  assert.equal((await harness.ops.confirmPlan({ plan: '  ' }, SUPERVISOR)).code, 'bad-request');
  // host plan-review convention: body must be markdown starting with a # heading
  const noHeading = await harness.ops.confirmPlan({ plan: '拆成两个独立模块' }, SUPERVISOR);
  assert.equal(noHeading.code, 'bad-request');
  assert.match(noHeading.error, /# heading/);
  assert.equal((await harness.ops.confirmPlan({ plan: '## 二级标题开头' }, SUPERVISOR)).code, 'bad-request');
});

test('ops.confirmSelect: multi-select subset approval + batch subset enforcement (0.10.0)', async () => {
  const registry = new SpawnRegistry(tempRegistryPath());
  const harness = makeHarness({ registry });
  // validation
  assert.equal((await harness.ops.confirmSelect({ tasks: [] }, SUPERVISOR)).code, 'bad-request');
  assert.equal((await harness.ops.confirmSelect({ tasks: [{ title: '功能｜甲' }, { title: '功能｜甲' }] }, SUPERVISOR)).code, 'bad-request');
  assert.equal((await harness.ops.confirmSelect({ tasks: [{ scope: '没有标题' }] }, SUPERVISOR)).code, 'bad-request');
  // default mock channel approves the FIRST option only → subset of 1 out of 3
  const confirmed = await harness.ops.confirmSelect({
    tasks: [{ title: '功能｜模块A', scope: '独立甲' }, { title: '功能｜模块B' }, '功能｜模块C'],
  }, SUPERVISOR);
  assert.equal(confirmed.ok, true);
  assert.equal(confirmed.approved, true);
  assert.deepEqual(confirmed.selected, ['功能｜模块A']);
  assert.ok(confirmed.confirmationId.startsWith('confirm-'));
  // the generic question carries multiSelect so the UI renders checkboxes
  // (asserted through the request the channel received)
  // batch containing an unapproved title → confirmation-mismatch
  const mismatch = await harness.ops.spawnBatch({
    tasks: [{ title: '功能｜模块A', prompt: 'do A' }, { title: '功能｜模块B', prompt: 'do B' }],
    confirmationId: confirmed.confirmationId,
  }, SUPERVISOR);
  assert.equal(mismatch.code, 'confirmation-mismatch');
  assert.match(mismatch.error, /功能｜模块B/);
  // untitled batch item cannot be matched to the approved subset either
  const untitled = await harness.ops.spawnBatch({
    tasks: [{ prompt: 'no title' }],
    confirmationId: confirmed.confirmationId,
  }, SUPERVISOR);
  assert.equal(untitled.code, 'confirmation-mismatch');
  // exact subset passes (size 1 < threshold → gate not fired, credential survives)
  const okBatch = await harness.ops.spawnBatch({
    tasks: [{ title: '功能｜模块A', prompt: 'do A' }],
    confirmationId: confirmed.confirmationId,
  }, SUPERVISOR);
  assert.equal(okBatch.ok, true);
  assert.equal(okBatch.startedCount, 1);
});

test('ops.confirmSelect: feedback, empty selection, cancel, channel errors (0.10.0)', async () => {
  const harness = makeHarness();
  // nothing selected but custom feedback given
  const harnessCustomOnly = makeHarness({ askUser: async (request) => ({ answers: request.questions.map((question) => ({ id: question.id, selected: [], custom: '把 B 和 C 合并成一个' })) }) });
  const customOnly = await harnessCustomOnly.ops.confirmSelect({ tasks: [{ title: '功能｜甲' }] }, SUPERVISOR);
  assert.equal(customOnly.approved, false);
  assert.equal(customOnly.feedback, '把 B 和 C 合并成一个');
  // nothing selected at all
  const harnessEmpty = makeHarness({ askUser: async (request) => ({ answers: request.questions.map((question) => ({ id: question.id, selected: [] })) }) });
  assert.equal((await harnessEmpty.ops.confirmSelect({ tasks: [{ title: '功能｜甲' }] }, SUPERVISOR)).feedback, '未选择任何任务');
  // user closed the card
  const harnessCancel = makeHarness({ askUser: async () => { throw Object.assign(new Error('closed'), { code: 'ASK_CANCELLED' }); } });
  assert.equal((await harnessCancel.ops.confirmSelect({ tasks: [{ title: '功能｜甲' }] }, SUPERVISOR)).code, 'confirm-cancelled');
  // no channel / no UI
  const harnessNoChannel = makeHarness({ askUser: null });
  assert.equal((await harnessNoChannel.ops.confirmSelect({ tasks: [{ title: '功能｜甲' }] }, SUPERVISOR)).code, 'no-question-channel');
  const harnessNoProvider = makeHarness({ askUser: async () => { throw Object.assign(new Error('none'), { code: 'NO_PROVIDER' }); } });
  assert.equal((await harnessNoProvider.ops.confirmSelect({ tasks: [{ title: '功能｜甲' }] }, SUPERVISOR)).code, 'no-question-channel');
  // subagent caller cannot ask a human
  const harnessDelegated = makeHarness({ askUser: async () => { throw Object.assign(new Error('owned'), { code: 'DELEGATED_CALLER' }); } });
  assert.equal((await harnessDelegated.ops.confirmSelect({ tasks: [{ title: '功能｜甲' }] }, SUPERVISOR)).code, 'delegated-caller');
});

test('ops.confirmSelect: gated batch consumes a subset credential (0.10.0)', async () => {
  const registry = new SpawnRegistry(tempRegistryPath());
  const harness = makeHarness({
    registry,
    askUser: async (request) => ({ answers: request.questions.map((question) => ({ id: question.id, selected: question.options.slice(0, 2).map((option) => option.label) })) }),
  });
  const confirmed = await harness.ops.confirmSelect({
    tasks: [{ title: '功能｜甲' }, { title: '功能｜乙' }, { title: '功能｜丙' }],
  }, SUPERVISOR);
  assert.deepEqual(confirmed.selected, ['功能｜甲', '功能｜乙']);
  // batch at the confirmation threshold consumes the credential on success
  const batch = await harness.ops.spawnBatch({
    tasks: [{ title: '功能｜甲', prompt: 'do 甲' }, { title: '功能｜乙', prompt: 'do 乙' }],
    confirmationId: confirmed.confirmationId,
  }, SUPERVISOR);
  assert.equal(batch.ok, true);
  assert.equal(batch.startedCount, 2);
  // single-use: the same credential no longer passes the gate
  const reuse = await harness.ops.spawnBatch({
    tasks: [{ title: '功能｜甲', prompt: 'do 甲 again' }, { title: '功能｜乙', prompt: 'do 乙 again' }],
    confirmationId: confirmed.confirmationId,
  }, SUPERVISOR);
  assert.equal(reuse.code, 'confirmation-required');
});

test('ops.confirmPlan reusable: mission-scoped credential survives successful batches (0.11.0)', async () => {
  const registry = new SpawnRegistry(tempRegistryPath());
  const harness = makeHarness({ registry });
  const confirmed = await harness.ops.confirmPlan({ plan: '# 长线方案', reusable: true }, SUPERVISOR);
  assert.equal(confirmed.approved, true);
  assert.equal(confirmed.reusable, true);
  // first gated batch succeeds...
  const first = await harness.ops.spawnBatch({
    tasks: [{ prompt: '里程碑一甲' }, { prompt: '里程碑一乙' }],
    confirmationId: confirmed.confirmationId,
  }, SUPERVISOR);
  assert.equal(first.ok, true);
  // ...and the SAME credential still covers the next milestone's batch
  const second = await harness.ops.spawnBatch({
    tasks: [{ prompt: '里程碑二甲' }, { prompt: '里程碑二乙' }],
    confirmationId: confirmed.confirmationId,
  }, SUPERVISOR);
  assert.equal(second.ok, true);
  // foreign caller cannot borrow the mission credential
  const foreign = await harness.ops.spawnBatch({
    tasks: [{ prompt: 'x' }, { prompt: 'y' }],
    confirmationId: confirmed.confirmationId,
  }, { sessionId: 'session-other' });
  assert.equal(foreign.code, 'confirmation-required');
});

test('ops.confirmSelect reusable: subset credential survives, enforcement persists (0.11.0)', async () => {
  const registry = new SpawnRegistry(tempRegistryPath());
  const harness = makeHarness({
    registry,
    askUser: async (request) => ({ answers: request.questions.map((question) => ({ id: question.id, selected: question.options.slice(0, 2).map((option) => option.label) })) }),
  });
  const confirmed = await harness.ops.confirmSelect({
    tasks: [{ title: '功能｜甲' }, { title: '功能｜乙' }, { title: '功能｜丙' }],
    reusable: true,
  }, SUPERVISOR);
  assert.equal(confirmed.reusable, true);
  assert.deepEqual(confirmed.selected, ['功能｜甲', '功能｜乙']);
  const batchTasks = [{ title: '功能｜甲', prompt: 'do 甲' }, { title: '功能｜乙', prompt: 'do 乙' }];
  assert.equal((await harness.ops.spawnBatch({ tasks: batchTasks, confirmationId: confirmed.confirmationId }, SUPERVISOR)).ok, true);
  // reusable: the same credential still passes the gate for a later batch
  assert.equal((await harness.ops.spawnBatch({ tasks: batchTasks, confirmationId: confirmed.confirmationId }, SUPERVISOR)).ok, true);
  // subset enforcement still applies on every reuse
  const mismatch = await harness.ops.spawnBatch({
    tasks: [{ title: '功能｜甲', prompt: 'do 甲' }, { title: '功能｜丙', prompt: 'do 丙' }],
    confirmationId: confirmed.confirmationId,
  }, SUPERVISOR);
  assert.equal(mismatch.code, 'confirmation-mismatch');
});

test('ops.spawnBatch: confirmation gate', async () => {
  const harness = makeHarness();
  // missing confirmationId on a gated batch
  const gated = await harness.ops.spawnBatch({ tasks: [{ prompt: 'a' }, { prompt: 'b' }] }, SUPERVISOR);
  assert.equal(gated.code, 'confirmation-required');
  assert.match(gated.error, /task_confirm/);
  // confirmation minted for another caller is not usable
  const other = { sessionId: 'session-other', cwd: '/work' };
  const foreignConfirm = await harness.ops.confirmPlan({ plan: '# 派发计划' }, other);
  const foreign = await harness.ops.spawnBatch({ tasks: [{ prompt: 'a' }, { prompt: 'b' }], confirmationId: foreignConfirm.confirmationId }, SUPERVISOR);
  assert.equal(foreign.code, 'confirmation-required');
  // below the threshold the gate does not engage
  const single = await harness.ops.spawnBatch({ tasks: [{ prompt: 'solo' }] }, SUPERVISOR);
  assert.equal(single.ok, true);
  // gate disabled by config
  const harnessOpen = makeHarness({ config: { confirmBeforeBatch: false } });
  const open = await harnessOpen.ops.spawnBatch({ tasks: [{ prompt: 'a' }, { prompt: 'b' }] }, SUPERVISOR);
  assert.equal(open.ok, true);
});

test('ops.spawnBatch: input validation', async () => {
  const harness = makeHarness({ registry: new SpawnRegistry(tempRegistryPath()) });
  assert.equal((await harness.ops.spawnBatch({}, SUPERVISOR)).code, 'bad-request');
  assert.equal((await harness.ops.spawnBatch({ tasks: [] }, SUPERVISOR)).code, 'bad-request');
  assert.equal((await harness.ops.spawnBatch({ tasks: [{ prompt: '' }] }, SUPERVISOR)).code, 'bad-request');
  const tooMany = { tasks: Array.from({ length: 7 }, (_, i) => ({ prompt: `task ${i}` })) };
  const overCap = await harness.ops.spawnBatch(tooMany, SUPERVISOR);
  assert.equal(overCap.code, 'bad-request');
  assert.match(overCap.error, /maxBatchSpawn/);
});

test('ops.spawnBatch: one failed item does not abort the rest', async () => {
  const sessions = new Map();
  let createdCount = 0;
  const config = resolveConfig({ confirmBeforeBatch: false }); // gate is not the subject of this test
  const failingOps = createOps({
    sessionController: {
      list: async () => ({ items: [...sessions.values()] }),
      create: async (request) => {
        createdCount += 1;
        if (request.cwd === '/bad') throw new Error('disk full');
        const id = `session-created-${createdCount}`;
        sessions.set(id, { sessionId: id, updatedAt: Date.now(), running: false, blank: true, cwd: request.cwd, projections: { asOfSeq: 0, values: {} } });
        return { sessionId: id };
      },
      rename: async (request) => ({ title: request.title, seq: 1 }),
      prompt: async (request, signal) => { signal.throwIfAborted(); return { accepted: true }; },
      resolveAgent: async () => ({ error: { code: 'session-not-found', message: 'no' } }),
      inspect: async () => ({ events: [] }),
      cancel: async () => ({ accepted: true }),
    },
    agents: { get: () => undefined },
    createUserMessage: () => ({}),
    config,
    limiter: new SendLimiter(config, () => 0),
    registry: new SpawnRegistry(tempRegistryPath()),
    uuid: () => 'r',
  });
  const result = await failingOps.spawnBatch({
    tasks: [
      { prompt: 'good', cwd: '/good' },
      { prompt: 'bad', cwd: '/bad' },
    ],
  }, SUPERVISOR);
  assert.equal(result.ok, true);
  assert.equal(result.startedCount, 1);
  assert.equal(result.failedCount, 1);
  assert.equal(result.results[0].ok, true);
  assert.equal(result.results[1].ok, false);
  assert.equal(result.results[1].code, 'spawn-create-failed');
  // all-failed batch reports batch-all-failed with per-item detail
  const allBad = await failingOps.spawnBatch({ tasks: [{ prompt: 'x', cwd: '/bad' }] }, SUPERVISOR);
  assert.equal(allBad.ok, false);
  assert.equal(allBad.code, 'batch-all-failed');
  assert.equal(allBad.results[0].code, 'spawn-create-failed');
});

test('ops.spawnTask: recursion depth is tracked and capped', async () => {
  const registry = new SpawnRegistry(tempRegistryPath());
  const harness = makeHarness({ registry });
  // root session (never spawned) -> children at depth 1
  const first = await harness.ops.spawnTask({ prompt: 'level 1' }, SUPERVISOR);
  assert.equal(first.ok, true);
  assert.equal(first.depth, 1);
  assert.equal(registry.get(first.sessionId).parentSessionId, 'session-super');
  // depth-1 coordinator -> children at depth 2
  const depth1Caller = { sessionId: first.sessionId, cwd: '/work' };
  const second = await harness.ops.spawnTask({ prompt: 'level 2' }, depth1Caller);
  assert.equal(second.ok, true);
  assert.equal(second.depth, 2);
  assert.equal(registry.get(second.sessionId).parentSessionId, first.sessionId);
  // depth-2 coordinator -> rejected, pointed at subagents
  const depth2Caller = { sessionId: second.sessionId, cwd: '/work' };
  const third = await harness.ops.spawnTask({ prompt: 'level 3' }, depth2Caller);
  assert.equal(third.ok, false);
  assert.equal(third.code, 'spawn-depth-exceeded');
  assert.match(third.error, /subagents/);
  // batch spawning obeys the same cap (confirmation acquired first)
  const depthConfirm = await harness.ops.confirmPlan({ plan: '# 派发计划' }, depth2Caller);
  const batchThird = await harness.ops.spawnBatch({ tasks: [{ prompt: 'x' }, { prompt: 'y' }], confirmationId: depthConfirm.confirmationId }, depth2Caller);
  assert.equal(batchThird.ok, false);
  assert.equal(batchThird.code, 'batch-all-failed');
  assert.equal(batchThird.results[0].code, 'spawn-depth-exceeded');
});

test('ops.waitFor: already idle settles immediately', async () => {
  const harness = makeHarness();
  addLiveAgent(harness, 'session-a', { status: 'idle' });
  const result = await harness.ops.waitFor({ sessionId: 'session-a' }, SUPERVISOR);
  assert.equal(result.settled, true);
  assert.match(result.reason, /already idle/);
  assert.equal(result.targets[0].idle, true);
});

test('ops.waitFor: cold session settles immediately', async () => {
  const harness = makeHarness();
  const result = await harness.ops.waitFor({ sessionId: 'session-ghost' }, SUPERVISOR);
  assert.equal(result.settled, true);
  assert.match(result.reason, /already idle/);
  assert.equal(result.targets[0].agentState, 'cold-idle');
});

test('ops.waitFor: times out on never-idle agent', async () => {
  const harness = makeHarness();
  const agent = addLiveAgent(harness, 'session-a', { status: 'running' });
  agent.idlePromise = new Promise(() => {}); // never resolves
  const result = await harness.ops.waitFor({ sessionId: 'session-a', timeoutMs: 50 }, SUPERVISOR);
  assert.equal(result.settled, false);
  assert.match(result.reason, /timed out after 50ms/);
  assert.match(result.reason, /session-a/);
});

test('ops.waitFor: settles when agent goes idle', async () => {
  const harness = makeHarness();
  const agent = addLiveAgent(harness, 'session-a', { status: 'running' });
  let release;
  agent.idlePromise = new Promise((resolve) => {
    release = resolve;
  });
  const pending = harness.ops.waitFor({ sessionId: 'session-a', timeoutMs: 5000 }, SUPERVISOR);
  setTimeout(release, 10);
  const result = await pending;
  assert.equal(result.settled, true);
  assert.match(result.reason, /became idle/);
});

test('ops.waitFor: bad input is rejected with codes', async () => {
  const harness = makeHarness();
  const noTarget = await harness.ops.waitFor({}, SUPERVISOR);
  assert.equal(noTarget.code, 'bad-request');
  const badMode = await harness.ops.waitFor({ sessionId: 'session-a', mode: 'some' }, SUPERVISOR);
  assert.equal(badMode.code, 'bad-request');
});

test('ops.waitFor: multi-target mode all settles only when every target is idle', async () => {
  const harness = makeHarness();
  const agentA = addLiveAgent(harness, 'session-a', { status: 'running' });
  const agentB = addLiveAgent(harness, 'session-b', { status: 'running' });
  let releaseA;
  let releaseB;
  agentA.idlePromise = new Promise((resolve) => { releaseA = resolve; });
  agentB.idlePromise = new Promise((resolve) => { releaseB = resolve; });
  const pending = harness.ops.waitFor({ sessionIds: ['session-a', 'session-b'], timeoutMs: 5000 }, SUPERVISOR);
  setTimeout(releaseA, 5);
  setTimeout(releaseB, 15);
  const result = await pending;
  assert.equal(result.settled, true);
  assert.equal(result.count, 2);
  assert.match(result.reason, /all targets became idle/);
  assert.deepEqual(result.targets.map((target) => target.idle), [true, true]);
});

test('ops.waitFor: multi-target mode any settles on the first idle', async () => {
  const harness = makeHarness();
  const agentA = addLiveAgent(harness, 'session-a', { status: 'running' });
  const agentB = addLiveAgent(harness, 'session-b', { status: 'running' });
  let releaseA;
  agentA.idlePromise = new Promise((resolve) => { releaseA = resolve; });
  agentB.idlePromise = new Promise(() => {}); // never idle
  const pending = harness.ops.waitFor({ sessionIds: ['session-a', 'session-b'], mode: 'any', timeoutMs: 5000 }, SUPERVISOR);
  setTimeout(releaseA, 5);
  const result = await pending;
  assert.equal(result.settled, true);
  assert.match(result.reason, /session-a became idle/);
});

test('ops.waitFor: multi-target timeout lists the still-running targets', async () => {
  const harness = makeHarness();
  const agentA = addLiveAgent(harness, 'session-a', { status: 'running' });
  const agentB = addLiveAgent(harness, 'session-b', { status: 'running' });
  agentA.idlePromise = new Promise(() => {});
  agentB.idlePromise = new Promise(() => {});
  const result = await harness.ops.waitFor({ sessionIds: ['session-a', 'session-b'], timeoutMs: 30 }, SUPERVISOR);
  assert.equal(result.settled, false);
  assert.match(result.reason, /session-a, session-b/);
});

test('ops.cancelTask: live cancel and cold refusal', async () => {
  const harness = makeHarness();
  addLiveAgent(harness, 'session-a');
  const ok = await harness.ops.cancelTask('session-a', SUPERVISOR);
  assert.equal(ok.ok, true);
  assert.equal(harness.calls.cancel.length, 1);
  const cold = await harness.ops.cancelTask('session-ghost', SUPERVISOR);
  assert.equal(cold.ok, false);
  assert.equal(cold.code, 'target-cold');
  assert.match(cold.error, /no live agent/);
});

/* ------------------------------------------------------------------ */
/* spawn registry (workstream memory)                                  */
/* ------------------------------------------------------------------ */

function tempRegistryPath() {
  return join(mkdtempSync(join(tmpdir(), 'task-coord-test-')), 'registry.json');
}

test('registry: record, get, listTeam, teams', () => {
  const registry = new SpawnRegistry(tempRegistryPath(), { now: () => 1000 });
  registry.record('session-a', { team: '重构', title: '0904｜功能｜模块A', promptExcerpt: 'do A' });
  registry.record('session-b', { team: '重构', promptExcerpt: 'do B' });
  registry.record('session-c', { promptExcerpt: 'solo' });
  assert.equal(registry.get('session-a').team, '重构');
  assert.equal(registry.get('session-a').title, '0904｜功能｜模块A');
  assert.deepEqual(registry.listTeam('重构'), ['session-a', 'session-b']);
  assert.deepEqual(registry.teams(), ['重构']);
  assert.equal(registry.get('session-x'), undefined);
});

test('registry: persists to disk and reloads', () => {
  const file = tempRegistryPath();
  const first = new SpawnRegistry(file, { now: () => 1000 });
  first.record('session-a', { team: '迁移' });
  const second = new SpawnRegistry(file);
  assert.equal(second.get('session-a').team, '迁移');
  const payload = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(payload.version, 1);
});

test('registry: corrupt file degrades to empty and is preserved', () => {
  const file = tempRegistryPath();
  writeFileSync(file, '{ this is not json', 'utf8');
  const registry = new SpawnRegistry(file, { now: () => 42 });
  assert.equal(registry.get('session-a'), undefined);
  registry.record('session-a', { team: 'x' });
  assert.equal(registry.get('session-a').team, 'x');
  const reread = new SpawnRegistry(file);
  assert.equal(reread.get('session-a').team, 'x');
});

test('registry: prunes oldest beyond maxEntries', () => {
  const registry = new SpawnRegistry(tempRegistryPath(), { maxEntries: 2, now: () => 1000 });
  registry.record('session-1', { createdAt: 1 });
  registry.record('session-2', { createdAt: 2 });
  registry.record('session-3', { createdAt: 3 });
  assert.equal(registry.get('session-1'), undefined);
  assert.equal(registry.get('session-2').createdAt, 2);
  assert.equal(registry.get('session-3').createdAt, 3);
});

test('ops.spawnTask: records team durably; list filters by team', async () => {
  const harness = makeHarness({ registry: new SpawnRegistry(tempRegistryPath()) });
  const spawned = await harness.ops.spawnTask({ title: '功能｜模块A', prompt: 'do A', team: '支付重构' }, SUPERVISOR);
  assert.equal(spawned.ok, true);
  assert.equal(spawned.team, '支付重构');
  const all = await harness.ops.listTasks({}, SUPERVISOR);
  const row = all.tasks.find((task) => task.sessionId === spawned.sessionId);
  assert.equal(row.team, '支付重构');
  const grouped = await harness.ops.listTasks({ team: '支付重构' }, SUPERVISOR);
  assert.equal(grouped.team, '支付重构');
  assert.deepEqual(grouped.tasks.map((task) => task.sessionId), [spawned.sessionId]);
  const empty = await harness.ops.listTasks({ team: '不存在' }, SUPERVISOR);
  assert.equal(empty.count, 0);
});

test('ops.progress: annotates team from the registry', async () => {
  const registry = new SpawnRegistry(tempRegistryPath());
  const harness = makeHarness({ registry });
  addRow(harness, { sessionId: 'session-a' });
  addLiveAgent(harness, 'session-a', { status: 'idle' });
  registry.record('session-a', { team: '迁移' });
  const result = await harness.ops.progress('session-a', SUPERVISOR);
  assert.equal(result.team, '迁移');
});

test('ops.sendMessage: reference is quoted visibly and messageId returned', async () => {
  const harness = makeHarness();
  addRow(harness, { sessionId: 'session-a' });
  const agent = addLiveAgent(harness, 'session-a');
  const result = await harness.ops.sendMessage({ targetId: 'session-a', text: '改成方案 B', reference: 'msg-1' }, SUPERVISOR);
  assert.equal(result.ok, true);
  assert.equal(result.reference, 'msg-1');
  assert.equal(result.messageId, 'msg-1'); // first created message in this harness
  const delivered = agent.followups[0];
  assert.ok(delivered.content[0].text.startsWith('[reference: msg-1]'));
  assert.match(delivered.content[0].text, /改成方案 B/);
});

/* ------------------------------------------------------------------ */
/* /tasks slash command                                                */
/* ------------------------------------------------------------------ */

test('commands: parseTasksCommand grammar', () => {
  assert.deepEqual(parseTasksCommand(''), { kind: 'list' });
  assert.deepEqual(parseTasksCommand('  '), { kind: 'list' });
  assert.deepEqual(parseTasksCommand('team 支付重构'), { kind: 'team', team: '支付重构' });
  assert.deepEqual(parseTasksCommand('team'), { kind: 'invalid' });
  assert.deepEqual(parseTasksCommand('team '), { kind: 'invalid' });
  assert.deepEqual(parseTasksCommand('session-abc'), { kind: 'inspect', target: 'session-abc' });
  assert.deepEqual(parseTasksCommand('abc123'), { kind: 'inspect', target: 'abc123' });
});

test('commands: callerFromInvocation mirrors tool caller derivation', () => {
  const caller = callerFromInvocation({ agent: { id: 'session-x', session: { header: { origin: 'subagent', cwd: '/w' } } } });
  assert.deepEqual(caller, { sessionId: 'session-x', origin: 'subagent', cwd: '/w' });
  assert.equal(callerFromInvocation({}).sessionId, '');
});

test('commands: renderers map ops results', () => {
  const list = renderTaskList({
    ok: true, count: 2, truncated: false,
    tasks: [
      { sessionId: 'session-a', status: 'running', title: 'A', team: '迁移', todos: '1/2 done' },
      { sessionId: 'session-b', status: 'idle', title: null },
    ],
  });
  assert.equal(list.kind, 'success');
  assert.match(list.text, /● session-a/);
  assert.match(list.text, /team=迁移/);
  assert.match(list.text, /○ session-b/);
  const failure = renderTaskList({ ok: false, code: 'rate-limited', error: 'slow down' });
  assert.equal(failure.kind, 'error');
  assert.match(failure.text, /rate-limited/);
  const progress = renderProgress({
    ok: true, sessionId: 'session-a', title: 'A', agentState: 'running', team: '迁移', cwd: '/w',
    todos: [{ content: 'x', status: 'completed' }, { content: 'y', status: 'in_progress' }],
    goal: { goal: { objective: 'finish it' } },
    queue: [{ placement: 'next-turn', text: 'note' }],
    recent: [{ role: 'assistant', text: 'doing it' }],
  });
  assert.equal(progress.kind, 'success');
  assert.match(progress.text, /todos: 1\/2 done/);
  assert.match(progress.text, /goal: finish it/);
  assert.match(progress.text, /doing it/);
});

test('commands: registerCommands registers, executes and degrades', async () => {
  const harness = makeHarness({ registry: new SpawnRegistry(tempRegistryPath()) });
  addRow(harness, { sessionId: 'session-a', projections: { asOfSeq: 1, values: { title: 'Alpha' } } });
  addRow(harness, { sessionId: 'session-b', projections: { asOfSeq: 1, values: { title: 'Beta' } } });
  const registered = [];
  const ctx = { commands: { register(definition) { registered.push(definition); return () => registered.splice(registered.indexOf(definition), 1); } }, logger: null };
  const dispose = registerCommands(ctx, harness.ops);
  assert.equal(registered.length, 1);
  assert.equal(registered[0].name, 'tasks');
  const invocation = { commandId: 'c', agent: { id: 'session-super' }, attachments: [], rawInput: '' };
  const listed = await registered[0].handler(invocation);
  assert.equal(listed.kind, 'success');
  assert.match(listed.text, /session-a/);
  // inspect with short id prefix resolves to the unique match
  const shortId = 'session-a'.replace(/^session-/, '').slice(0, 4);
  const inspected = await registered[0].handler({ ...invocation, rawInput: shortId });
  assert.equal(inspected.kind, 'success');
  assert.match(inspected.text, /Alpha/);
  // unknown id reports a helpful error
  const missing = await registered[0].handler({ ...invocation, rawInput: 'session-nope' });
  assert.equal(missing.kind, 'error');
  assert.match(missing.text, /not found/);
  dispose();
  assert.equal(registered.length, 0);
  // graceful no-op without a commands registry
  const noop = registerCommands({ logger: null }, harness.ops);
  assert.equal(typeof noop, 'function');
  noop();
});

/* ------------------------------------------------------------------ */
/* tools registration                                                  */
/* ------------------------------------------------------------------ */

test('registerTools: eleven tools with delegation', async () => {
  const harness = makeHarness();
  const registered = [];
  const ctx = {
    tools: {
      register(definition) {
        registered.push(definition);
        return () => registered.splice(registered.indexOf(definition), 1);
      },
    },
    logger: null,
  };
  // stub defineTool: minimal contract mirror (name/description/parameters/output/execute)
  const defineTool = (options) => options;
  const dispose = registerTools(ctx, harness.ops, { defineTool }, resolveConfig());
  assert.deepEqual(registered.map((tool) => tool.name), ['task_list', 'task_progress', 'task_send', 'task_spawn', 'task_confirm', 'task_confirm_select', 'task_spawn_batch', 'task_wait', 'task_cancel', 'task_workspace', 'task_models']);
  const byName = Object.fromEntries(registered.map((tool) => [tool.name, tool]));
  assert.deepEqual(byName.task_list.parameters.sessionId, undefined);
  assert.ok(byName.task_list.parameters.team); // task_list team filter
  assert.equal(byName.task_send.parameters.sessionId.required, true);
  assert.deepEqual(byName.task_send.parameters.mode.enum, ['queue', 'steer']);
  assert.ok(byName.task_send.parameters.reference); // task_send correlation
  assert.ok(byName.task_spawn.parameters.team); // task_spawn workstream
  assert.ok(byName.task_spawn.parameters.reportBack); // result push-back convention
  assert.equal(byName.task_confirm.parameters.plan.required, true);
  assert.ok(byName.task_confirm.parameters.reusable); // 0.11.0 mission-scoped approval
  assert.ok(byName.task_confirm_select.parameters.reusable);
  assert.ok(byName.task_spawn.parameters.provider && byName.task_spawn.parameters.model && byName.task_spawn.parameters.reasoningEffort); // 0.13.0 per-child model
  assert.ok(byName.task_spawn_batch.parameters.tasks.items.properties.model);
  assert.equal(byName.task_confirm_select.parameters.tasks.required, true); // 0.10.0 multi-select confirmation
  assert.ok(byName.task_confirm_select.parameters.question);
  assert.equal(byName.task_confirm_select.parameters.tasks.items.additionalProperties, false); // host schema compiler requires explicit
  assert.equal(byName.task_spawn_batch.parameters.tasks.required, true);
  assert.deepEqual(byName.task_spawn_batch.parameters.tasks.items.type, 'object');
  assert.equal(byName.task_spawn_batch.parameters.tasks.items.additionalProperties, false);
  assert.equal(byName.task_spawn_batch.parameters.tasks.items.properties.prompt.required, true);
  assert.ok(byName.task_spawn_batch.parameters.confirmationId); // dispatch confirmation gate
  assert.ok(byName.task_spawn_batch.parameters.reportBack);
  assert.deepEqual(byName.task_wait.parameters.sessionIds.items, { type: 'string' });
  assert.deepEqual(byName.task_wait.parameters.mode.enum, ['all', 'any']);
  assert.notEqual(byName.task_wait.parameters.sessionId.required, true); // optional (sessionIds alternative)
  // delegation through execute()
  addRow(harness, { sessionId: 'session-a' });
  addRow(harness, { sessionId: 'session-super' });
  const exec = { agent: { id: 'session-super', session: { header: {} } } };
  const listResult = await byName.task_list.execute({}, exec);
  assert.equal(listResult.ok, true);
  const denyResult = await byName.task_send.execute({ sessionId: 'session-super', message: 'hi' }, exec);
  assert.equal(denyResult.ok, false);
  assert.equal(denyResult.code, 'self-send-denied');
  const waitBad = await byName.task_wait.execute({}, exec);
  assert.equal(waitBad.ok, false);
  assert.equal(waitBad.code, 'bad-request');
  const batchBad = await byName.task_spawn_batch.execute({ tasks: [] }, exec);
  assert.equal(batchBad.ok, false);
  assert.equal(batchBad.code, 'bad-request');
  const confirmBad = await byName.task_confirm.execute({ plan: ' ' }, exec);
  assert.equal(confirmBad.ok, false);
  assert.equal(confirmBad.code, 'bad-request');
  const selectBad = await byName.task_confirm_select.execute({ tasks: [] }, exec);
  assert.equal(selectBad.ok, false);
  assert.equal(selectBad.code, 'bad-request');
  const wsList = await byName.task_workspace.execute({}, exec);
  assert.equal(wsList.ok, true);
  assert.equal(wsList.action, 'list');
  const modelsResult = await byName.task_models.execute({}, exec);
  assert.equal(modelsResult.ok, true);
  assert.ok(Array.isArray(modelsResult.providers));
  assert.equal(registered.length, 11);
  dispose();
  assert.equal(registered.length, 0);
});
