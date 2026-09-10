/**
 * Smoke tests for dsh-plugin-task-coordinator.
 * Runs outside the host process: all harness objects are mocked.
 * Execute with: node --test test/
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { resolveConfig, DEFAULTS, WORKSPACE_POLICIES } from '../config.mjs';
import { checkCaller, checkTarget, SendLimiter, excerpt, blocksToText } from '../safety.mjs';
import { createOps } from '../ops.mjs';
import { registerTools } from '../tools.mjs';
import { buildSpawnTitle, mmdd, truncateTopic, firstLine, resolveTitleType, DEFAULT_TITLE_TYPES } from '../title.mjs';
import { buildSkillsConfig, SKILL_PROVIDER_NAME, SKILLS_DIR } from '../skills.mjs';
import { SpawnRegistry } from '../registry.mjs';
import { parseTasksCommand, registerCommands, renderTaskList, renderProgress, callerFromInvocation } from '../commands.mjs';
import { resolveUiLocale, uiStrings, UI_LOCALES } from '../i18n.mjs';
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
  assert.equal(config.titleFallbackTopic, '新任务');
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
  assert.throws(() => resolveConfig({ titleFallbackTopic: 42 }), TypeError);
  assert.throws(() => resolveConfig({ titleTypes: '功能' }), TypeError);
  assert.throws(() => resolveConfig({ titleTypes: [] }), TypeError);
  assert.throws(() => resolveConfig({ titleTypes: ['功能', ''] }), TypeError);
  assert.throws(() => resolveConfig({ titleMaxTopicChars: -1 }), TypeError);
  assert.throws(() => resolveConfig({ maxBatchSpawn: 'six' }), TypeError);
  assert.throws(() => resolveConfig({ confirmBeforeBatch: 'yes' }), TypeError);
  assert.throws(() => resolveConfig({ confirmBatchThreshold: -1 }), TypeError);
  assert.throws(() => resolveConfig({ maxSpawnDepth: null }), TypeError);
});

test('config: workspacePolicy enum — default ancestor, grouping reserved (0.19.0)', () => {
  assert.equal(DEFAULTS.workspacePolicy, 'ancestor');
  assert.deepEqual(WORKSPACE_POLICIES, ['exact', 'ancestor']);
  assert.equal(resolveConfig().workspacePolicy, 'ancestor');
  assert.equal(resolveConfig({ workspacePolicy: 'exact' }).workspacePolicy, 'exact');
  assert.equal(resolveConfig({ workspacePolicy: 'ancestor' }).workspacePolicy, 'ancestor');
  // the reserved future tier is rejected as an invalid value, like every other bad input
  for (const bad of ['grouping', 'GROUPING', 'aggressive', '', 42, null, true]) {
    assert.throws(() => resolveConfig({ workspacePolicy: bad }), TypeError, `workspacePolicy: ${JSON.stringify(bad)}`);
  }
  const error = (() => { try { resolveConfig({ workspacePolicy: 'grouping' }); } catch (e) { return e; } })();
  assert.match(error.message, /workspacePolicy/);
  assert.match(error.message, /'exact' \| 'ancestor'/);
  assert.match(error.message, /grouping.*reserved/);
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
  // English aliases normalize to the canonical set, case-insensitively
  assert.equal(
    buildSpawnTitle({ title: 'fix｜登录报错', prompt: 'x' }, config, SH_AFTER_MIDNIGHT),
    '0904｜修复｜登录报错',
  );
  assert.equal(
    buildSpawnTitle({ title: 'Feature｜export report', prompt: 'x' }, config, SH_AFTER_MIDNIGHT),
    '0904｜功能｜export report',
  );
  assert.equal(resolveTitleType('DOCS', DEFAULT_TITLE_TYPES), '文档');
  assert.equal(resolveTitleType('deploy', DEFAULT_TITLE_TYPES), null);
  assert.equal(resolveTitleType('constructor', DEFAULT_TITLE_TYPES), null);
  // custom English sets match their own members case-insensitively (third resolution tier)
  assert.equal(resolveTitleType('FIX', ['Feature', 'Fix']), 'Fix');
  const enConfig = resolveConfig({ titleTypes: ['Feature', 'Fix'], titleFallbackType: 'Explore' });
  assert.equal(
    buildSpawnTitle({ title: 'fix｜reconciliation', prompt: 'x' }, enConfig, SH_AFTER_MIDNIGHT),
    '0904｜Fix｜reconciliation',
  );
});

test('title: bare topic never guesses a type (fallback 探索)', () => {
  const config = resolveConfig();
  assert.equal(
    buildSpawnTitle({ title: 'Migration', prompt: 'migrate' }, config, SH_AFTER_MIDNIGHT),
    '0904｜探索｜Migration',
  );
  // an unmapped English word is a topic, not a type — it never leaks as one
  assert.equal(
    buildSpawnTitle({ title: 'deploy｜支付网关', prompt: 'x' }, config, SH_AFTER_MIDNIGHT),
    '0904｜探索｜deploy｜支付网关',
  );
});

test('title: stale date prefix is re-stamped from createdAt', () => {
  const config = resolveConfig();
  assert.equal(
    buildSpawnTitle({ title: '0901｜设计｜旧日期标题', prompt: 'x' }, config, SH_AFTER_MIDNIGHT),
    '0904｜设计｜旧日期标题',
  );
  // aliases work in the dated shape too
  assert.equal(
    buildSpawnTitle({ title: '0901｜docs｜API 参考', prompt: 'x' }, config, SH_AFTER_MIDNIGHT),
    '0904｜文档｜API 参考',
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
  // titleFallbackTopic makes the empty-topic fallback configurable for English deployments
  const enConfig = resolveConfig({ titleFallbackTopic: ' New task ', titleFallbackType: 'Explore' });
  assert.equal(buildSpawnTitle({ title: '   ' }, enConfig, SH_AFTER_MIDNIGHT), '0904｜Explore｜New task');
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
  // aliases never override a custom set: fix -> 修复 is canonical but not allowed here
  assert.equal(
    buildSpawnTitle({ title: 'fix｜登录崩溃' }, config, SH_AFTER_MIDNIGHT),
    '0904｜需求｜fix｜登录崩溃',
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
    ...(overrides.readUiLocale ? { readUiLocale: overrides.readUiLocale } : {}),
    ...(overrides.readSpawnDefaults ? { readSpawnDefaults: overrides.readSpawnDefaults } : {}),
    ...(overrides.readSessionSnapshot ? { readSessionSnapshot: overrides.readSessionSnapshot } : {}),
    ...(overrides.createSeededSession ? { createSeededSession: overrides.createSeededSession } : {}),
    ...(overrides.archiveSession ? { archiveSession: overrides.archiveSession } : {}),
    ...(Object.hasOwn(overrides, 'probeWorktree') ? { probeWorktree: overrides.probeWorktree } : {}),
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
    // 0.24.1: the REAL host Session entity exposes seq + snapshotEvents(from, to)
    // (dsh-session lib L1331/L1342) — the plain `.events` array below is the
    // legacy test-host fallback only; ops.progress prefers snapshotEvents.
    session: {
      id: sessionId,
      seq: events.length,
      events,
      header: { id: sessionId },
      snapshotEvents: () => events,
    },
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

test('ops.progress: recent reads the REAL session API (0.24.1 regression)', async () => {
  // The production bug class: the live host Session entity exposes seq +
  // ranged snapshotEvents() — NOT a plain .events array. Reading the imaginary
  // .events made recent silently EMPTY in production since inception, and the
  // mocks carried the same imaginary shape so nothing caught it (mock≠real,
  // the 0.18.4 envelope class).
  const harness = makeHarness();
  addRow(harness, { sessionId: 'session-real', projections: { asOfSeq: 1, values: { title: 'R' } } });
  const events = [
    { type: 'user/message', seq: 0, time: 1, data: { content: [{ type: 'text', text: 'real kickoff' }], source: { kind: 'user' } } },
    { type: 'assistant/message', seq: 1, time: 2, data: { message: { content: [{ type: 'text', text: 'real reply' }] } } },
  ];
  const agent = addLiveAgent(harness, 'session-real', { status: 'idle', events: [] });
  // Real-entity shape: ranged snapshotEvents and NO .events property at all.
  let snapshotCalls = 0;
  agent.session = {
    id: 'session-real',
    seq: 2,
    header: { id: 'session-real' },
    snapshotEvents: (from = 0, to = 2) => { snapshotCalls += 1; return events.filter((event) => event.seq >= from && event.seq < to); },
  };
  const result = await harness.ops.progress('session-real', SUPERVISOR);
  assert.equal(result.ok, true);
  assert.equal(snapshotCalls, 1, 'the recent projection must go through snapshotEvents');
  assert.deepEqual(result.recent.map((entry) => entry.text), ['real kickoff', 'real reply']);
  // A hostile snapshotEvents degrades recent to empty — never breaks progress.
  agent.session = { id: 'session-real', seq: 2, snapshotEvents: () => { throw new Error('snapshot boom'); } };
  const hostile = await harness.ops.progress('session-real', SUPERVISOR);
  assert.equal(hostile.ok, true);
  assert.deepEqual(hostile.recent, []);
  // The legacy/test-host fallback (plain .events) still projects.
  agent.session = { id: 'session-real', seq: 2, events };
  const legacy = await harness.ops.progress('session-real', SUPERVISOR);
  assert.deepEqual(legacy.recent.map((entry) => entry.text), ['real kickoff', 'real reply']);
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
  const agent = addLiveAgent(harness, 'session-a', { nextTurn: [{}, {}] });
  const result = await harness.ops.sendMessage({ targetId: 'session-a', text: 'adjust the plan' }, SUPERVISOR);
  assert.equal(result.ok, true);
  assert.equal(result.placement.startsWith('next-turn'), true);
  assert.deepEqual(result.queueDepth, { nextTurn: 2, nextStep: 0 });
  assert.match(result.hint, /read after ~2 rounds; if this message changes the target's next step, consider steer/);
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
  assert.deepEqual(result.queueDepth, { nextTurn: 0, nextStep: 0 });
  assert.match(result.hint, /extends the current round/);
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

test('normalizeWorkspacePath: pure "." segments are stripped on every platform (0.19.0)', async () => {
  const { normalizeWorkspacePath, findWorkspaceByPath } = await import('../ops.mjs');
  // win32: trailing/inner '.' segments, bare drive root via 'D:\.', UNC prefix survives
  assert.equal(normalizeWorkspacePath('D:\\git\\Proj\\.', 'win32'), 'd:\\git\\proj');
  assert.equal(normalizeWorkspacePath('D:\\git\\.\\Proj\\.\\', 'win32'), 'd:\\git\\proj');
  assert.equal(normalizeWorkspacePath('D:\\.', 'win32'), 'd:\\');
  assert.equal(normalizeWorkspacePath('\\\\srv\\share\\dir\\.', 'win32'), '\\\\srv\\share\\dir');
  assert.equal(normalizeWorkspacePath('.', 'win32'), '.');
  // posix: rooted and relative forms
  assert.equal(normalizeWorkspacePath('/git/./proj', 'linux'), '/git/proj');
  assert.equal(normalizeWorkspacePath('/./', 'linux'), '/');
  assert.equal(normalizeWorkspacePath('.', 'linux'), '.');
  // darwin folds case on top of the stripping
  assert.equal(normalizeWorkspacePath('/Git/./Proj/.', 'darwin'), '/git/proj');
  // the lexical/physical canon gap (research S21): a cwd with a trailing '.'
  // segment now exact-matches the workspace path, like the host's realpath would
  const list = () => [{ id: 'ws', path: '/git/dhs-tool' }];
  assert.equal(findWorkspaceByPath('/git/dhs-tool/.', list)?.id, 'ws');
  assert.equal(findWorkspaceByPath('/git/dhs-tool/./web-search', list), undefined); // still not exact
});

test('matchWorkspacePaths: exact vs nearest strict ancestor (0.19.0)', async () => {
  const { matchWorkspacePaths, WORKSPACE_PLACEMENTS } = await import('../ops.mjs');
  assert.deepEqual([...WORKSPACE_PLACEMENTS], ['exact-match', 'caller-inherited', 'ancestor-normalized', 'ungrouped-worktree', 'ungrouped']);
  // exact tier (normalized), never counted as its own ancestor
  const single = () => [{ id: 'ws', path: '/a/b/' }];
  assert.deepEqual(matchWorkspacePaths('/a/b', single), { exact: { id: 'ws', path: '/a/b/' }, ancestor: undefined });
  assert.equal(matchWorkspacePaths('/a/b/c', single).ancestor?.id, 'ws'); // strict subdirectory
  assert.equal(matchWorkspacePaths('/a/bc', single).ancestor, undefined); // sibling prefix without separator
  // nearest ancestor wins between nested workspaces
  const nested = () => [{ id: 'ws-a', path: '/a' }, { id: 'ws-ab', path: '/a/b' }, { id: 'ws-other', path: '/z' }];
  assert.equal(matchWorkspacePaths('/a/b/c/d', nested).ancestor?.id, 'ws-ab');
  assert.equal(matchWorkspacePaths('/a/x', nested).ancestor?.id, 'ws-a');
  // win32 drive-root workspace is an ancestor of everything on the drive (prefix already ends in the separator)
  const drive = () => [{ id: 'ws-d', path: 'D:\\' }, { id: 'ws-repo', path: 'D:\\repo' }];
  assert.equal(matchWorkspacePaths('D:\\repo\\sub', drive, 'win32').ancestor?.id, 'ws-repo');
  assert.equal(matchWorkspacePaths('D:\\other', drive, 'win32').ancestor?.id, 'ws-d');
  // failure-tolerant contract: bad input, missing/throwing snapshot, non-array
  assert.deepEqual(matchWorkspacePaths(undefined, single), { exact: undefined, ancestor: undefined });
  assert.deepEqual(matchWorkspacePaths('  ', single), { exact: undefined, ancestor: undefined });
  assert.deepEqual(matchWorkspacePaths('/a/b', undefined), { exact: undefined, ancestor: undefined });
  assert.deepEqual(matchWorkspacePaths('/a/b', () => { throw new Error('boom'); }), { exact: undefined, ancestor: undefined });
  assert.deepEqual(matchWorkspacePaths('/a/b', () => 'not-an-array'), { exact: undefined, ancestor: undefined });
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

/* ------------------------------------------------------------------ */
/* workspace placement chain + observability (0.19.0)                  */
/*                                                                     */
/* The block below ports the research matrix of                        */
/* research/workspace-placement-fallback.md §2 (18 spawn scenarios)    */
/* into regression assertions against the real createOps, using        */
/* portable path fixtures (case folding is covered per-platform in the */
/* pure-function tests, keeping the suite green on POSIX CI).          */
/* ------------------------------------------------------------------ */

test('ops.spawnTask: workspace placement matrix — 18 scenarios (0.19.0)', async () => {
  const WS_DHS = { id: 'ws-dhs', path: '/git/dhs-tool', title: 'DHS', sessionIds: ['session-super'] };
  const WS_UPIPE = { id: 'ws-upipe', path: '/unity-pipe', sessionIds: [] };
  const WS_ROOT = { id: 'ws-root', path: '/git', sessionIds: ['caller-root'] };
  const single = () => [{ ...WS_DHS }];
  const double = () => [{ ...WS_DHS }, { ...WS_UPIPE }];
  const nested = () => [{ ...WS_ROOT }, { ...WS_DHS, sessionIds: [] }];
  const none = () => [];
  const member = { sessionId: 'session-super', cwd: '/git/dhs-tool' };

  // scenario runner: fresh harness + capturing registry per scenario
  const scenarios = [
    { id: 'S01', workspaces: single, caller: member, cwd: undefined,
      expect: { placement: 'caller-inherited', workspace: { id: 'ws-dhs', title: 'DHS' }, workspaceId: 'ws-dhs', expectedWorkspace: '/git/dhs-tool' } },
    { id: 'S02', workspaces: single, caller: member, cwd: '/git/dhs-tool',
      expect: { placement: 'exact-match', workspace: { id: 'ws-dhs', title: 'DHS' }, workspaceId: 'ws-dhs', expectedWorkspace: '/git/dhs-tool' } },
    { id: 'S03', workspaces: single, caller: member, cwd: '/git/dhs-tool/',
      expect: { placement: 'exact-match', workspace: { id: 'ws-dhs', title: 'DHS' }, workspaceId: 'ws-dhs', expectedWorkspace: '/git/dhs-tool/' } },
    { id: 'S04', workspaces: single, caller: member, cwd: '/git/dhs-tool/web-search',
      expect: { placement: 'ancestor-normalized', workspace: { id: 'ws-dhs', title: 'DHS' }, workspaceId: 'ws-dhs', resultCwd: '/git/dhs-tool', normalizedFrom: '/git/dhs-tool/web-search', kickoffSuffix: true, expectedWorkspace: '/git/dhs-tool/web-search' } },
    { id: 'S05', workspaces: single, caller: member, cwd: '/worktrees/feat-x/dhs-tool', probe: () => true,
      expect: { placement: 'ungrouped-worktree', workspace: null, createCwd: '/worktrees/feat-x/dhs-tool', warning: /git worktree/, expectedWorkspace: '/worktrees/feat-x/dhs-tool' } },
    { id: 'S06', workspaces: single, caller: member, cwd: '/unrelated/proj', probe: () => false,
      expect: { placement: 'ungrouped', workspace: null, createCwd: '/unrelated/proj', warning: /ungrouped placement/, expectedWorkspace: '/unrelated/proj' } },
    { id: 'S07', workspaces: single, caller: member, cwd: '',
      expect: { placement: 'caller-inherited', workspace: { id: 'ws-dhs', title: 'DHS' }, workspaceId: 'ws-dhs', expectedWorkspace: '/git/dhs-tool' } },
    { id: 'S08', workspaces: single, caller: { sessionId: 'session-ungrouped-sub', cwd: '/git/dhs-tool/web-search' }, cwd: undefined,
      expect: { placement: 'ancestor-normalized', workspace: { id: 'ws-dhs', title: 'DHS' }, workspaceId: 'ws-dhs', resultCwd: '/git/dhs-tool', normalizedFrom: '/git/dhs-tool/web-search', kickoffSuffix: true, expectedWorkspace: '/git/dhs-tool/web-search' } },
    { id: 'S09', workspaces: single, caller: { sessionId: 'session-ungrouped-root', cwd: '/git/dhs-tool' }, cwd: undefined,
      expect: { placement: 'caller-inherited', workspace: { id: 'ws-dhs', title: 'DHS' }, workspaceId: 'ws-dhs', expectedWorkspace: '/git/dhs-tool' } },
    { id: 'S10', workspaces: single, caller: { sessionId: 'session-far', cwd: '/elsewhere' }, cwd: undefined, probe: () => false,
      expect: { placement: 'ungrouped', workspace: null, createCwd: '/elsewhere', warning: /ungrouped placement/, expectedWorkspace: '/elsewhere' } },
    { id: 'S11', workspaces: single, caller: { sessionId: 'session-far', cwd: '/elsewhere' }, cwd: '/git/dhs-tool',
      expect: { placement: 'exact-match', workspace: { id: 'ws-dhs', title: 'DHS' }, workspaceId: 'ws-dhs', expectedWorkspace: '/git/dhs-tool' } },
    { id: 'S12', workspaces: single, caller: { sessionId: 'session-deep-child', cwd: '/git/dhs-tool' }, cwd: undefined,
      registryGet: { 'session-deep-child': { parentSessionId: 'session-super', depth: 1 } },
      expect: { placement: 'caller-inherited', workspace: { id: 'ws-dhs', title: 'DHS' }, workspaceId: 'ws-dhs', expectedWorkspace: '/git/dhs-tool' } },
    { id: 'S13', workspaces: double, caller: member, cwd: '/unity-pipe',
      expect: { placement: 'exact-match', workspace: { id: 'ws-upipe', title: null }, workspaceId: 'ws-upipe', expectedWorkspace: '/unity-pipe' } },
    { id: 'S14', workspaces: double, caller: member, cwd: '/unity-pipe/',
      expect: { placement: 'exact-match', workspace: { id: 'ws-upipe', title: null }, workspaceId: 'ws-upipe', expectedWorkspace: '/unity-pipe/' } },
    { id: 'S15', workspaces: nested, caller: { sessionId: 'caller-root', cwd: '/git' }, cwd: '/git/dhs-tool/plugin',
      expect: { placement: 'ancestor-normalized', workspace: { id: 'ws-dhs', title: 'DHS' }, workspaceId: 'ws-dhs', resultCwd: '/git/dhs-tool', normalizedFrom: '/git/dhs-tool/plugin', kickoffSuffix: true, expectedWorkspace: '/git/dhs-tool/plugin' } },
    { id: 'S16', workspaces: double, caller: member, cwd: '/worktrees/feat-x/dhs-tool/', probe: () => true,
      expect: { placement: 'ungrouped-worktree', workspace: null, createCwd: '/worktrees/feat-x/dhs-tool/', warning: /git worktree/, expectedWorkspace: '/worktrees/feat-x/dhs-tool/' } },
    { id: 'S17', workspaces: none, caller: { sessionId: 'caller-x', cwd: '/git/dhs-tool' }, cwd: '/git/dhs-tool',
      expect: { placement: 'ungrouped', workspace: null, createCwd: '/git/dhs-tool', warning: /ungrouped placement/, expectedWorkspace: '/git/dhs-tool' } },
    { id: 'S18', workspaces: none, caller: { sessionId: 'caller-x', cwd: '/git/dhs-tool' }, cwd: undefined,
      expect: { placement: 'ungrouped', workspace: null, createCwd: '/git/dhs-tool', warning: /ungrouped placement/, expectedWorkspace: '/git/dhs-tool' } },
    { id: 'S21', workspaces: single, caller: member, cwd: '/git/dhs-tool/.',
      expect: { placement: 'exact-match', workspace: { id: 'ws-dhs', title: 'DHS' }, workspaceId: 'ws-dhs', expectedWorkspace: '/git/dhs-tool/.' } },
  ];

  for (const scenario of scenarios) {
    const recorded = new Map();
    const registry = {
      get: (id) => scenario.registryGet?.[id],
      record: (id, entry) => { recorded.set(id, entry); },
    };
    const workspaces = scenario.workspaces();
    const harness = makeHarness({
      listWorkspaces: () => workspaces,
      registry,
      ...(scenario.probe !== undefined ? { probeWorktree: scenario.probe } : {}),
    });
    const result = await harness.ops.spawnTask(
      { prompt: `placement ${scenario.id}`, title: `修复｜${scenario.id}`, cwd: scenario.cwd },
      scenario.caller,
    );
    assert.equal(result.ok, true, `${scenario.id}: spawn failed: ${result.error}`);
    const request = harness.calls.create.at(-1);
    const e = scenario.expect;
    // create shape: workspaceId XOR cwd (or none)
    if (e.workspaceId !== undefined) {
      assert.equal(request.workspaceId, e.workspaceId, `${scenario.id}: expected workspaceId`);
      assert.equal(request.cwd, undefined, `${scenario.id}: workspaceId and cwd are mutually exclusive`);
    } else if (e.createCwd !== undefined) {
      assert.equal(request.cwd, e.createCwd, `${scenario.id}: expected plain cwd`);
      assert.equal(request.workspaceId, undefined, `${scenario.id}: expected no workspaceId`);
    } else {
      assert.equal(request.workspaceId, undefined, `${scenario.id}`);
      assert.equal(request.cwd, undefined, `${scenario.id}`);
    }
    // observability fields on every receipt
    assert.equal(result.placement, e.placement, `${scenario.id}: placement`);
    assert.deepEqual(result.workspace, e.workspace, `${scenario.id}: workspace projection`);
    if (e.warning !== undefined) {
      assert.match(result.warning, e.warning, `${scenario.id}: ungrouped warning`);
      assert.match(result.warning, /task_workspace/, `${scenario.id}: remediation hint`);
      assert.match(result.hint, /task_progress/, `${scenario.id}: hint`);
    } else {
      assert.equal(result.warning, undefined, `${scenario.id}: no warning expected`);
    }
    if (e.resultCwd !== undefined) assert.equal(result.cwd, e.resultCwd, `${scenario.id}: receipt cwd`);
    if (e.normalizedFrom !== undefined) {
      assert.equal(result.normalizedFrom, e.normalizedFrom, `${scenario.id}: normalizedFrom`);
      assert.match(result.note, /ancestor normalization/, `${scenario.id}: receipt note`);
    }
    // kickoff: ancestor normalization appends the i18n suffix (zh default)
    const kickoff = harness.calls.prompt.at(-1).content[0].text;
    if (e.kickoffSuffix) {
      assert.match(kickoff, /工作目录提示（工作区归一）/, `${scenario.id}: kickoff suffix present`);
      assert.match(kickoff, new RegExp(e.normalizedFrom.replaceAll('/', '[/\\\\]')), `${scenario.id}: suffix names the target directory`);
      assert.match(kickoff, /汇报约定/, `${scenario.id}: report-back suffix still present`);
    } else {
      assert.doesNotMatch(kickoff, /工作目录提示/, `${scenario.id}: no normalization suffix`);
    }
    // registry: expectedWorkspace records the caller's intended directory
    assert.equal(recorded.get(result.sessionId)?.expectedWorkspace, e.expectedWorkspace, `${scenario.id}: expectedWorkspace`);
  }
});

test('ops.spawnTask: workspacePolicy exact keeps the pre-0.19 exact-only behavior (0.19.0)', async () => {
  const workspaces = [{ id: 'ws-dhs', path: '/git/dhs-tool', title: 'DHS', sessionIds: ['session-super'] }];
  const harness = makeHarness({ listWorkspaces: () => workspaces, config: { workspacePolicy: 'exact' } });
  const member = { sessionId: 'session-super', cwd: '/git/dhs-tool' };
  // explicit subdirectory: no upgrade under 'exact' — plain cwd, ungrouped + warning
  const sub = await harness.ops.spawnTask({ prompt: 'exact tier', cwd: '/git/dhs-tool/web-search' }, member);
  assert.equal(sub.ok, true);
  assert.equal(harness.calls.create[0].cwd, '/git/dhs-tool/web-search');
  assert.equal(harness.calls.create[0].workspaceId, undefined);
  assert.equal(sub.placement, 'ungrouped');
  assert.match(sub.warning, /ungrouped placement/);
  // exact matches still upgrade under 'exact'
  const exact = await harness.ops.spawnTask({ prompt: 'exact tier hit', cwd: '/git/dhs-tool/' }, member);
  assert.equal(exact.placement, 'exact-match');
  assert.equal(harness.calls.create[1].workspaceId, 'ws-dhs');
  // inherited caller cwd that is a subdirectory also stays plain under 'exact'
  const inherited = await harness.ops.spawnTask(
    { prompt: 'exact tier inherit' },
    { sessionId: 'session-ungrouped-sub', cwd: '/git/dhs-tool/web-search' },
  );
  assert.equal(inherited.placement, 'ungrouped');
  assert.equal(harness.calls.create[2].cwd, '/git/dhs-tool/web-search');
  // and the caller-inherited exact fallback keeps working
  const inheritedExact = await harness.ops.spawnTask(
    { prompt: 'exact tier inherit hit' },
    { sessionId: 'session-ungrouped-root', cwd: '/git/dhs-tool' },
  );
  assert.equal(inheritedExact.placement, 'caller-inherited');
  assert.equal(harness.calls.create[3].workspaceId, 'ws-dhs');
});

test('ops.spawnTask: worktree probe degradation — throwing or absent probe is not a worktree (0.19.0)', async () => {
  const workspaces = [{ id: 'ws-dhs', path: '/git/dhs-tool', sessionIds: ['session-super'] }];
  const member = { sessionId: 'session-super', cwd: '/git/dhs-tool' };
  // throwing probe degrades to plain ungrouped
  const throwing = makeHarness({ listWorkspaces: () => workspaces, probeWorktree: () => { throw new Error('fs gone'); } });
  const degraded = await throwing.ops.spawnTask({ prompt: 'probe throws', cwd: '/worktrees/feat-x/dhs-tool' }, member);
  assert.equal(degraded.ok, true);
  assert.equal(degraded.placement, 'ungrouped');
  assert.match(degraded.warning, /ungrouped placement/);
  assert.doesNotMatch(degraded.warning, /linked git worktree/); // degraded probe → plain ungrouped warning, not the worktree one
  // absent probe (hosts / tests without the dependency) behaves the same
  const bare = makeHarness({ listWorkspaces: () => workspaces });
  const noProbe = await bare.ops.spawnTask({ prompt: 'no probe', cwd: '/worktrees/feat-x/dhs-tool' }, member);
  assert.equal(noProbe.placement, 'ungrouped');
  // a directory-.git (plain checkout) is NOT a worktree — probe sees a directory
  const plain = makeHarness({ listWorkspaces: () => workspaces, probeWorktree: () => false });
  const checkout = await plain.ops.spawnTask({ prompt: 'plain checkout', cwd: '/git/other-checkout' }, member);
  assert.equal(checkout.placement, 'ungrouped');
});

test('ops.spawnTask: ancestor normalization kickoff suffix follows uiLocale (0.19.0)', async () => {
  const workspaces = [{ id: 'ws-dhs', path: '/git/dhs-tool', sessionIds: ['session-super'] }];
  const member = { sessionId: 'session-super', cwd: '/git/dhs-tool' };
  const en = makeHarness({ listWorkspaces: () => workspaces, readUiLocale: () => 'en' });
  const spawned = await en.ops.spawnTask({ prompt: 'subdir work', cwd: '/git/dhs-tool/web-search' }, member);
  assert.equal(spawned.ok, true);
  const kickoff = en.calls.prompt.at(-1).content[0].text;
  assert.match(kickoff, /Working-directory note \(workspace normalization\): .*workspace root \/git\/dhs-tool/);
  assert.match(kickoff, /target directory is \/git\/dhs-tool\/web-search/);
  assert.match(kickoff, /Use explicit paths/);
  // reportBack opt-out keeps the normalization note (it is a working-directory fact, not a convention)
  const quiet = makeHarness({ listWorkspaces: () => workspaces });
  const muted = await quiet.ops.spawnTask({ prompt: 'quiet subdir', cwd: '/git/dhs-tool/web-search', reportBack: false }, member);
  assert.equal(muted.placement, 'ancestor-normalized');
  const quietKickoff = quiet.calls.prompt.at(-1).content[0].text;
  assert.match(quietKickoff, /工作目录提示（工作区归一）/);
  assert.doesNotMatch(quietKickoff, /汇报约定/);
});

test('ops.spawnBatch: per-item receipts carry workspace placement + ungrouped warnings (0.19.0)', async () => {
  const workspaces = [{ id: 'ws-dhs', path: '/git/dhs-tool', title: 'DHS', sessionIds: ['session-super'] }];
  const harness = makeHarness({ listWorkspaces: () => workspaces, config: { confirmBeforeBatch: false } });
  const batch = await harness.ops.spawnBatch({
    tasks: [
      { prompt: 'inside the tree', cwd: '/git/dhs-tool/sub' },
      { prompt: 'outside the tree', cwd: '/elsewhere' },
      { prompt: 'inherits the caller workspace' },
    ],
  }, SUPERVISOR);
  assert.equal(batch.ok, true);
  assert.equal(batch.startedCount, 3);
  const [inside, outside, inherited] = batch.results;
  assert.equal(inside.placement, 'ancestor-normalized');
  assert.deepEqual(inside.workspace, { id: 'ws-dhs', title: 'DHS' });
  assert.equal(inside.warning, undefined);
  assert.equal(outside.placement, 'ungrouped');
  assert.equal(outside.workspace, null);
  assert.match(outside.warning, /ungrouped placement/);
  assert.equal(inherited.placement, 'caller-inherited');
  assert.deepEqual(inherited.workspace, { id: 'ws-dhs', title: 'DHS' });
});

test('ops.listTasks: ungrouped filter mirrors the host bucket via the shared resolver (0.19.0)', async () => {
  const workspaces = [{ id: 'ws-dhs', path: '/git/dhs-tool', title: 'DHS', sessionIds: [] }];
  const harness = makeHarness({ listWorkspaces: () => workspaces });
  addRow(harness, { sessionId: 'session-in', cwd: '/git/dhs-tool' });
  addRow(harness, { sessionId: 'session-in-trailing', cwd: '/git/dhs-tool/' }); // same path, trailing separator
  addRow(harness, { sessionId: 'session-sub', cwd: '/git/dhs-tool/web-search' }); // subdirectory = ungrouped in the GUI
  addRow(harness, { sessionId: 'session-out', cwd: '/elsewhere' });
  addRow(harness, { sessionId: 'session-nocwd' }); // no cwd -> cannot belong to anything
  addRow(harness, { sessionId: 'session-sub-agent', cwd: '/git/dhs-tool', origin: 'subagent' });
  const view = await harness.ops.listTasks({ ungrouped: true }, SUPERVISOR);
  assert.equal(view.ok, true);
  assert.equal(view.ungrouped, true);
  assert.deepEqual(view.tasks.map((task) => task.sessionId), ['session-sub', 'session-out', 'session-nocwd']);
  assert.match(view.hint, /task_workspace/);
  // filter composes with the default subagent fence and filter/limit
  const filtered = await harness.ops.listTasks({ ungrouped: true, filter: 'elsewhere' }, SUPERVISOR);
  assert.deepEqual(filtered.tasks.map((task) => task.sessionId), ['session-out']);
  // no workspace registry at all: nothing can belong, every session shows up
  const bare = makeHarness();
  addRow(bare, { sessionId: 'session-anywhere', cwd: '/anywhere' });
  const bareView = await bare.ops.listTasks({ ungrouped: true }, SUPERVISOR);
  assert.deepEqual(bareView.tasks.map((task) => task.sessionId), ['session-anywhere']);
  // a throwing registry snapshot degrades to the same "nothing belongs" view
  const broken = makeHarness({ listWorkspaces: () => { throw new Error('registry gone'); } });
  addRow(broken, { sessionId: 'session-anywhere', cwd: '/anywhere' });
  const brokenView = await broken.ops.listTasks({ ungrouped: true }, SUPERVISOR);
  assert.equal(brokenView.tasks.length, 1);
  // unfiltered listing is unchanged
  const all = await harness.ops.listTasks({}, SUPERVISOR);
  assert.equal(all.count, 5);
});

test('registry: expectedWorkspace is recorded by spawn, persists, and is whitelisted on load (0.19.0)', async () => {
  const file = tempRegistryPath();
  const workspaces = [{ id: 'ws-dhs', path: '/git/dhs-tool', sessionIds: [] }];
  const registry = new SpawnRegistry(file);
  const harness = makeHarness({ listWorkspaces: () => workspaces, registry });
  const member = { sessionId: 'session-super', cwd: '/git/dhs-tool' };
  // ungrouped explicit cwd: expectedWorkspace keeps the caller's intent for remediation
  const stray = await harness.ops.spawnTask({ prompt: 'stray task', cwd: '/worktrees/feat-x/tool' }, member);
  assert.equal(stray.placement, 'ungrouped');
  assert.equal(registry.get(stray.sessionId).expectedWorkspace, '/worktrees/feat-x/tool');
  // ancestor-normalized: the requested subdirectory is preserved (cwd actually became the root)
  const normalized = await harness.ops.spawnTask({ prompt: 'normalized task', cwd: '/git/dhs-tool/web-search' }, member);
  assert.equal(normalized.placement, 'ancestor-normalized');
  assert.equal(registry.get(normalized.sessionId).expectedWorkspace, '/git/dhs-tool/web-search');
  // survives a reload (durable file round-trip)
  const reloaded = new SpawnRegistry(file);
  assert.equal(reloaded.get(stray.sessionId).expectedWorkspace, '/worktrees/feat-x/tool');
  assert.equal(reloaded.get(normalized.sessionId).expectedWorkspace, '/git/dhs-tool/web-search');
  // whitelist: malformed values are dropped on load instead of poisoning entries
  const corrupt = JSON.parse(readFileSync(file, 'utf8'));
  corrupt.entries[stray.sessionId].expectedWorkspace = 42;
  corrupt.entries[normalized.sessionId].expectedWorkspace = '';
  writeFileSync(file, JSON.stringify(corrupt), 'utf8');
  const sanitized = new SpawnRegistry(file);
  assert.equal(sanitized.get(stray.sessionId).expectedWorkspace, undefined);
  assert.equal(sanitized.get(normalized.sessionId).expectedWorkspace, undefined);
});

/* ------------------------------------------------------------------ */
/* externalRef: end-to-end external caller correspondence (0.25.0)     */
/* Wire contract C1 (research/dshq-ledger-mailbox-spec.md Part C):     */
/* string, optional, <=200 chars after trim; empty/whitespace = absent;*/
/* non-string or over-length = bad-request. Stored/echoed, never parsed*/
/* ------------------------------------------------------------------ */

test('ops.spawnTask: externalRef validation triad — accept/absent/reject (0.25.0)', async () => {
  const registry = new SpawnRegistry(tempRegistryPath());
  const harness = makeHarness({ registry });
  // ① valid: accepted, TRIMMED, echoed on the receipt and recorded durably
  const ok1 = await harness.ops.spawnTask({ prompt: 'ref task', externalRef: '  thread-abc:wave-1  ' }, SUPERVISOR);
  assert.equal(ok1.ok, true);
  assert.equal(ok1.externalRef, 'thread-abc:wave-1', 'receipt echoes the trimmed ref');
  assert.equal(registry.get(ok1.sessionId).externalRef, 'thread-abc:wave-1');
  // boundary: exactly 200 chars after trim is accepted
  const ref200 = 'r'.repeat(200);
  const ok2 = await harness.ops.spawnTask({ prompt: 'boundary task', externalRef: ` ${ref200} ` }, SUPERVISOR);
  assert.equal(ok2.ok, true);
  assert.equal(ok2.externalRef, ref200);
  // ② absent: undefined / null / empty / whitespace-only all mean ABSENT —
  // spawn succeeds and NEITHER receipt nor registry carries the key
  for (const [index, absent] of [[0, undefined], [1, null], [2, ''], [3, '   \t\n ']]) {
    const result = await harness.ops.spawnTask({ prompt: `absent task ${index}`, externalRef: absent }, SUPERVISOR);
    assert.equal(result.ok, true, `absent form ${index} must not fail the spawn`);
    assert.equal('externalRef' in result, false, `absent form ${index} must not appear on the receipt`);
    assert.equal('externalRef' in (registry.get(result.sessionId) ?? {}), false, `absent form ${index} must not be recorded`);
  }
  // ③ reject: any other non-string or an over-length value is bad-request —
  // and rejection happens BEFORE creation (zero orphans)
  const createdBefore = harness.calls.create.length;
  for (const invalid of [42, true, { ref: 'x' }, ['x'], 'x'.repeat(201)]) {
    const result = await harness.ops.spawnTask({ prompt: 'invalid ref task', externalRef: invalid }, SUPERVISOR);
    assert.equal(result.ok, false, `invalid ref ${JSON.stringify(invalid)?.slice(0, 20)} must be rejected`);
    assert.equal(result.code, 'bad-request');
    assert.match(result.error, /externalRef/);
  }
  assert.equal(harness.calls.create.length, createdBefore, 'rejected externalRef must not create any session');
});

test('registry: externalRef round-trips through disk and is whitelisted on load (0.25.0)', async () => {
  const file = tempRegistryPath();
  const registry = new SpawnRegistry(file);
  const harness = makeHarness({ registry });
  const spawned = await harness.ops.spawnTask({ prompt: 'durable ref task', externalRef: 'thread-def:wave-2' }, SUPERVISOR);
  assert.equal(registry.get(spawned.sessionId).externalRef, 'thread-def:wave-2');
  // survives a reload (durable file round-trip)
  const reloaded = new SpawnRegistry(file);
  assert.equal(reloaded.get(spawned.sessionId).externalRef, 'thread-def:wave-2');
  // whitelist: malformed values are dropped on load instead of poisoning entries
  // (same discipline as expectedWorkspace, 0.19.0 precedent)
  const corrupt = JSON.parse(readFileSync(file, 'utf8'));
  corrupt.entries[spawned.sessionId].externalRef = 42;
  writeFileSync(file, JSON.stringify(corrupt), 'utf8');
  const sanitized = new SpawnRegistry(file);
  assert.equal(sanitized.get(spawned.sessionId).externalRef, undefined);
  assert.equal(sanitized.get(spawned.sessionId).promptExcerpt, 'durable ref task', 'the rest of the entry survives sanitization');
  // empty-string values are dropped too
  const corrupt2 = JSON.parse(readFileSync(file, 'utf8'));
  corrupt2.entries[spawned.sessionId].externalRef = '';
  writeFileSync(file, JSON.stringify(corrupt2), 'utf8');
  assert.equal(new SpawnRegistry(file).get(spawned.sessionId).externalRef, undefined);
});

test('ops.listTasks + progress: externalRef surfaces from the registry (0.25.0)', async () => {
  const registry = new SpawnRegistry(tempRegistryPath());
  const harness = makeHarness({ registry });
  const withRef = await harness.ops.spawnTask({ prompt: 'surfaced task', externalRef: 'thread-ghi:wave-3' }, SUPERVISOR);
  const withoutRef = await harness.ops.spawnTask({ prompt: 'plain task' }, SUPERVISOR);
  // list rows merge the registry field exactly like team
  const listing = await harness.ops.listTasks({}, SUPERVISOR);
  const refRow = listing.tasks.find((task) => task.sessionId === withRef.sessionId);
  const plainRow = listing.tasks.find((task) => task.sessionId === withoutRef.sessionId);
  assert.equal(refRow.externalRef, 'thread-ghi:wave-3');
  assert.equal('externalRef' in plainRow, false, 'rows without a recorded ref must not carry the key');
  // progress surfaces it too (recorded?.externalRef)
  const refProgress = await harness.ops.progress(withRef.sessionId, SUPERVISOR);
  assert.equal(refProgress.externalRef, 'thread-ghi:wave-3');
  const plainProgress = await harness.ops.progress(withoutRef.sessionId, SUPERVISOR);
  assert.equal('externalRef' in plainProgress, false);
});

test('ops.spawnBatch: externalRef is NOT accepted in this version (0.25.0)', async () => {
  // Scope note: the bridge MVP has no batch endpoint, so batch dispatch stays
  // out of the externalRef contract for 0.25.0 — an item-level externalRef is
  // ignored (never forwarded to spawnTask, never recorded, never echoed).
  const registry = new SpawnRegistry(tempRegistryPath());
  const harness = makeHarness({ registry });
  const confirmed = await harness.ops.confirmPlan({ plan: '# 派发计划' }, SUPERVISOR);
  const batch = await harness.ops.spawnBatch({
    tasks: [{ prompt: 'batch ref probe', externalRef: 'thread-batch:should-ignore' }],
    confirmationId: confirmed.confirmationId,
  }, SUPERVISOR);
  assert.equal(batch.ok, true);
  assert.equal(batch.startedCount, 1);
  const item = batch.results[0];
  assert.equal(item.ok, true);
  assert.equal('externalRef' in item, false, 'per-item receipts must not carry externalRef');
  assert.equal('externalRef' in (registry.get(item.sessionId) ?? {}), false, 'batch spawns must not record externalRef');
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

test('ops.workspaceOp: migrate — clone + attach + archive across workspaces (0.16.0)', async () => {
  const workspaces = [
    { id: 'ws-src', path: '/proj/src', sessionIds: ['session-old'] },
    { id: 'ws-dst', path: '/proj/dst', sessionIds: [] },
  ];
  const calls = [];
  const entity = { attachSession: async (id) => { calls.push(['attach', id]); } };
  const snapshot = {
    header: { id: 'session-old', cwd: '/proj/src', createdAt: 12345, agentPreset: 'preset-a' },
    events: [{ type: 'turn/start', seq: 0 }, { type: 'turn/end', seq: 1 }],
  };
  const fakeRegistry = {
    records: new Map([['session-old', { team: 'mission', createdAt: 12345, depth: 1, parentSessionId: 'session-super', title: 'T' }]]),
    get(id) { return this.records.get(id); },
    record(id, entry) { this.records.set(id, { ...entry }); calls.push(['record', id]); },
  };
  const harness = makeHarness({
    listWorkspaces: () => workspaces,
    getWorkspace: (id) => (id === 'ws-dst' ? entity : undefined),
    registry: fakeRegistry,
    readSessionSnapshot: async (id) => { calls.push(['read', id]); return id === 'session-old' ? snapshot : undefined; },
    createSeededSession: async ({ seed, meta }) => { calls.push(['create', meta.cwd, meta.createdAt, meta.agentPreset, seed.length]); return { id: 'session-clone' }; },
    archiveSession: async (id) => { calls.push(['archive', id]); },
  });
  const moved = await harness.ops.workspaceOp({ action: 'migrate', sessionId: 'session-old', workspaceId: 'ws-dst' }, SUPERVISOR);
  assert.equal(moved.ok, true);
  assert.equal(moved.action, 'migrate');
  assert.equal(moved.sessionId, 'session-clone');
  assert.equal(moved.migratedFrom, 'session-old');
  assert.equal(moved.workspaceId, 'ws-dst');
  assert.equal(moved.archived, true);
  assert.equal(moved.team, 'mission');
  assert.match(moved.note, /NEW id 'session-clone'/);
  // the clone is born with the TARGET cwd, the original createdAt and preset, seeded with the full log
  assert.deepEqual(calls.find(([op]) => op === 'create'), ['create', '/proj/dst', 12345, 'preset-a', 2]);
  // ordering: read → create → attach → archive → registry retarget
  assert.deepEqual(calls.map(([op]) => op), ['read', 'create', 'attach', 'archive', 'record']);
  // the registry record carries over verbatim (team/depth/parent/title/createdAt)
  assert.deepEqual(fakeRegistry.records.get('session-clone'), { team: 'mission', createdAt: 12345, depth: 1, parentSessionId: 'session-super', title: 'T' });
});

test('ops.workspaceOp: migrate guards and partial failures (0.16.0)', async () => {
  const workspaces = [
    { id: 'ws-src', path: '/proj/src', sessionIds: [] },
    { id: 'ws-dst', path: '/proj/dst', sessionIds: [] },
  ];
  const baseSnapshot = { header: { id: 'session-old', cwd: '/proj/src', createdAt: 1 }, events: [{ type: 'turn/end', seq: 0 }] };
  const base = {
    listWorkspaces: () => workspaces,
    getWorkspace: (id) => (id === 'ws-dst' ? { attachSession: async () => {} } : undefined),
    readSessionSnapshot: async () => baseSnapshot,
    createSeededSession: async () => ({ id: 'session-clone' }),
    archiveSession: async () => {},
  };
  const MIGRATE = { action: 'migrate', sessionId: 'session-old', workspaceId: 'ws-dst' };
  // 1. a running source is rejected before any read/clone
  const busyHarness = makeHarness(base);
  addLiveAgent(busyHarness, 'session-old', { status: 'running' });
  const busy = await busyHarness.ops.workspaceOp(MIGRATE, SUPERVISOR);
  assert.equal(busy.code, 'migrate-busy');
  assert.match(busy.error, /task_wait/);
  // 2. source cwd already equals the target path → bad-request with an attach hint
  const sameCwd = makeHarness({ ...base, readSessionSnapshot: async () => ({ header: { ...baseSnapshot.header, cwd: '/proj/dst' }, events: [] }) });
  const noop = await sameCwd.ops.workspaceOp(MIGRATE, SUPERVISOR);
  assert.equal(noop.code, 'bad-request');
  assert.match(noop.error, /use action 'attach'/);
  // 3. host without the snapshot service → migrate-unavailable, never a crash
  const noService = makeHarness({ listWorkspaces: () => workspaces });
  assert.equal((await noService.ops.workspaceOp(MIGRATE, SUPERVISOR)).code, 'migrate-unavailable');
  // 4. clone failure → migrate-failed, nothing attached, nothing archived
  let archived = false;
  const cloneFail = makeHarness({ ...base, createSeededSession: async () => { throw new Error('store full'); }, archiveSession: async () => { archived = true; } });
  const failed = await cloneFail.ops.workspaceOp(MIGRATE, SUPERVISOR);
  assert.equal(failed.code, 'migrate-failed');
  assert.match(failed.error, /store full/);
  assert.equal(archived, false);
  // 5. attach failure reports the orphaned clone id; the original is NOT archived
  const attachFail = makeHarness({
    ...base,
    getWorkspace: (id) => (id === 'ws-dst' ? { attachSession: async () => { throw new Error('attach denied'); } } : undefined),
    archiveSession: async () => { archived = true; },
  });
  const orphan = await attachFail.ops.workspaceOp(MIGRATE, SUPERVISOR);
  assert.equal(orphan.code, 'migrate-failed');
  assert.match(orphan.error, /session-clone/);
  assert.match(orphan.error, /NOT archived/);
  assert.equal(archived, false);
  // 6. archive failure → still ok, archived:false + warning (the move itself succeeded)
  const archiveFail = makeHarness({ ...base, archiveSession: async () => { throw new Error('archive locked'); } });
  const partial = await archiveFail.ops.workspaceOp(MIGRATE, SUPERVISOR);
  assert.equal(partial.ok, true);
  assert.equal(partial.archived, false);
  assert.match(partial.warning, /archive locked/);
  // 7. snapshot read throws → migrate-failed
  const readFail = makeHarness({ ...base, readSessionSnapshot: async () => { throw new Error('log corrupt'); } });
  const corrupt = await readFail.ops.workspaceOp(MIGRATE, SUPERVISOR);
  assert.equal(corrupt.code, 'migrate-failed');
  assert.match(corrupt.error, /log corrupt/);
  // 8. the unknown-action message now lists migrate
  const badAction = await makeHarness(base).ops.workspaceOp({ action: 'teleport' }, SUPERVISOR);
  assert.match(badAction.error, /list \| attach \| detach \| migrate/);
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

/* ------------------------------------------------------------------ */
/* spawn-model defaults (0.18.0)                                       */
/* ------------------------------------------------------------------ */

test('settings: normalizeSpawnRoute rules (0.18.0)', async () => {
  const { normalizeSpawnRoute } = await import('../settings.mjs');
  // absent / non-object / empty pair -> no default route
  assert.equal(normalizeSpawnRoute(undefined), null);
  assert.equal(normalizeSpawnRoute(null), null);
  assert.equal(normalizeSpawnRoute('prov-a'), null);
  assert.equal(normalizeSpawnRoute([]), null);
  assert.equal(normalizeSpawnRoute({}), null);
  assert.equal(normalizeSpawnRoute({ provider: '', model: '', reasoningEffort: '' }), null);
  // valid pair, trimmed; empty effort dropped
  assert.deepEqual(normalizeSpawnRoute({ provider: ' prov-a ', model: ' model-x ', reasoningEffort: '  ' }), { provider: 'prov-a', model: 'model-x' });
  assert.deepEqual(normalizeSpawnRoute({ provider: 'prov-a', model: 'model-x', reasoningEffort: 'high' }), { provider: 'prov-a', model: 'model-x', reasoningEffort: 'high' });
  // half pair -> malformed (throws)
  assert.throws(() => normalizeSpawnRoute({ provider: 'prov-a', model: '' }), /provider and model together/);
  assert.throws(() => normalizeSpawnRoute({ provider: '', model: 'model-x' }), /provider and model together/);
});

test('settings: validateSpawnModelsSection boundary (0.18.0, relaxed 0.18.5)', async () => {
  const { validateSpawnModelsSection } = await import('../settings.mjs');
  // absent + empty + well-formed pass
  validateSpawnModelsSection(undefined);
  validateSpawnModelsSection(null);
  validateSpawnModelsSection({ provider: '', model: '', reasoningEffort: '' });
  validateSpawnModelsSection({ provider: 'prov-a', model: 'model-x' });
  // 0.18.5: half pairs PASS the write boundary — rejecting them there broke
  // GUI saves (the scope's write channel silently recovers on a rejected
  // mutation, so provider/model never landed while the UI reported saved).
  // The pair rule is enforced by the UI (Save disabled) and by consumption
  // (normalizeSpawnRoute throws → readSpawnDefaults degrades to unset).
  validateSpawnModelsSection({ provider: 'prov-a', model: '' });
  validateSpawnModelsSection({ provider: '', model: 'model-x' });
  // malformed shapes still rejected at the write boundary
  assert.throws(() => validateSpawnModelsSection('prov-a'), /must be an object/);
  assert.throws(() => validateSpawnModelsSection({ provider: 1, model: 'model-x' }), /"provider" must be a string/);
});

test('settings: normalizeQueueCap rules (0.23.0)', async () => {
  const { normalizeQueueCap, MAX_QUEUE_PER_TASK_CAP, SPAWN_MODELS_BASE } = await import('../settings.mjs');
  assert.equal(MAX_QUEUE_PER_TASK_CAP, 50);
  assert.equal(SPAWN_MODELS_BASE.maxQueuePerTask, 0, 'base sentinel 0 = follow the patch config');
  // absent / sentinel / junk -> null (follow config)
  assert.equal(normalizeQueueCap(undefined), null);
  assert.equal(normalizeQueueCap(null), null);
  assert.equal(normalizeQueueCap('12'), null);
  assert.equal(normalizeQueueCap({}), null);
  assert.equal(normalizeQueueCap({ maxQueuePerTask: 0 }), null);
  assert.equal(normalizeQueueCap({ maxQueuePerTask: -3 }), null);
  assert.equal(normalizeQueueCap({ maxQueuePerTask: 2.5 }), null);
  assert.equal(normalizeQueueCap({ maxQueuePerTask: '7' }), null);
  assert.equal(normalizeQueueCap({ maxQueuePerTask: Number.NaN }), null);
  // valid integers pass through; above the cap clamps (hand-edited yaml honesty)
  assert.equal(normalizeQueueCap({ maxQueuePerTask: 1 }), 1);
  assert.equal(normalizeQueueCap({ maxQueuePerTask: 7 }), 7);
  assert.equal(normalizeQueueCap({ maxQueuePerTask: 50 }), 50);
  assert.equal(normalizeQueueCap({ maxQueuePerTask: 51 }), 50);
  assert.equal(normalizeQueueCap({ maxQueuePerTask: 9999 }), 50);
});

test('settings: validateSpawnModelsSection queue-cap type check (0.23.0)', async () => {
  const { validateSpawnModelsSection } = await import('../settings.mjs');
  // numbers pass (range is clamped at consumption, not at the write boundary —
  // the 0.18.5 silent-rollback lesson)
  validateSpawnModelsSection({ maxQueuePerTask: 0 });
  validateSpawnModelsSection({ maxQueuePerTask: 12 });
  validateSpawnModelsSection({ maxQueuePerTask: 9999 });
  validateSpawnModelsSection({ provider: 'prov-a', model: 'model-x', maxQueuePerTask: 8 });
  // wrong type rejected
  assert.throws(() => validateSpawnModelsSection({ maxQueuePerTask: '8' }), /"maxQueuePerTask" must be a number/);
});

test('safety: SendLimiter honors a live maxQueuePerTask getter (0.23.0)', async () => {
  const { SendLimiter } = await import('../safety.mjs');
  // The plugin wires limiterConfig.maxQueuePerTask as a getter reading the
  // settings section per check() — a GUI edit applies without a restart.
  let cap = 5;
  const liveConfig = { minSendIntervalMs: 0, get maxQueuePerTask() { return cap; } };
  const limiter = new SendLimiter(liveConfig, () => 5, () => 1000);
  assert.equal(limiter.check('t1').code, 'queue-full', 'depth 5 >= cap 5 denies');
  cap = 10;
  assert.equal(limiter.check('t1'), null, 'raising the cap live re-admits the same depth');
  cap = 3;
  assert.equal(limiter.check('t1').code, 'queue-full', 'lowering the cap live denies again');
});

test('ops.spawnTask: plugin-default fallback chain (0.18.0)', async () => {
  // omitted provider+model -> the configured default route is installed
  const withDefault = makeHarness({ readSpawnDefaults: () => ({ provider: 'prov-a', model: 'model-x', reasoningEffort: 'high' }) });
  const defaulted = await withDefault.ops.spawnTask({ prompt: 'follow the default' }, SUPERVISOR);
  assert.equal(defaulted.ok, true);
  assert.deepEqual(defaulted.model, { provider: 'prov-a', model: 'model-x', reasoningEffort: 'high' });
  assert.equal(defaulted.modelSource, 'plugin-default');
  assert.deepEqual(withDefault.calls.selectModel[0], { sessionId: defaulted.sessionId, provider: 'prov-a', model: 'model-x', reasoningEffort: 'high' });
  // explicit args win over the configured default
  const explicit = await withDefault.ops.spawnTask({ prompt: 'explicit wins', provider: 'prov-a', model: 'model-y' }, SUPERVISOR);
  assert.equal(explicit.ok, true);
  assert.deepEqual(explicit.model, { provider: 'prov-a', model: 'model-y' });
  assert.equal(explicit.modelSource, 'explicit');
  // unset default -> host default behavior (no selectModel call at all)
  const noDefault = makeHarness({ readSpawnDefaults: () => null });
  const plain = await noDefault.ops.spawnTask({ prompt: 'host default' }, SUPERVISOR);
  assert.equal(plain.ok, true);
  assert.equal(plain.model, undefined);
  assert.equal(noDefault.calls.selectModel.length, 0);
  // a malformed stored section degrades to unset instead of breaking spawns
  const broken = makeHarness({ readSpawnDefaults: () => { throw new Error('malformed stored section'); } });
  const survived = await broken.ops.spawnTask({ prompt: 'survives bad storage' }, SUPERVISOR);
  assert.equal(survived.ok, true);
  assert.equal(broken.calls.selectModel.length, 0);
});

test('ops.spawnTask: default route still prechecks, caller effort rides (0.18.0)', async () => {
  // the fallback route goes through the same catalog precheck (zero orphans)
  const rejected = makeHarness({
    readSpawnDefaults: () => ({ provider: 'prov-a', model: 'ghost' }),
    resolveModelConfig: () => Promise.reject(new Error('no such model "ghost"')),
    listProviderModels: async (id) => (id === 'prov-a' ? [{ id: 'model-x' }] : []),
    listModelProviders: () => [{ id: 'prov-a' }],
  });
  const result = await rejected.ops.spawnTask({ prompt: 'should not create' }, SUPERVISOR);
  assert.equal(result.code, 'model-unavailable');
  assert.match(result.error, /models served by provider "prov-a": model-x/);
  // a lone reasoningEffort arg rides on top of the defaulted pair
  const riding = makeHarness({ readSpawnDefaults: () => ({ provider: 'prov-a', model: 'model-x', reasoningEffort: 'low' }) });
  const rode = await riding.ops.spawnTask({ prompt: 'effort override', reasoningEffort: 'max' }, SUPERVISOR);
  assert.equal(rode.ok, true);
  assert.deepEqual(rode.model, { provider: 'prov-a', model: 'model-x', reasoningEffort: 'max' });
  assert.equal(rode.modelSource, 'plugin-default');
});

test('ops.spawnBatch: items inherit the plugin default (0.18.0)', async () => {
  const harness = makeHarness({ readSpawnDefaults: () => ({ provider: 'prov-a', model: 'model-x' }) });
  const result = await harness.ops.spawnBatch({ tasks: [{ prompt: 'batch default' }], team: 'defaults' }, SUPERVISOR);
  assert.equal(result.ok, true);
  assert.equal(result.results[0].ok, true);
  assert.equal(harness.calls.selectModel.length, 1);
  assert.deepEqual(harness.calls.selectModel[0].provider, 'prov-a');
  assert.deepEqual(harness.calls.selectModel[0].model, 'model-x');
});

test('ops.models: pluginDefault surfaced beside the host default (0.18.0)', async () => {
  const harness = makeHarness({ readSpawnDefaults: () => ({ provider: 'prov-a', model: 'model-x' }) });
  const result = await harness.ops.models({}, SUPERVISOR);
  assert.equal(result.ok, true);
  assert.deepEqual(result.pluginDefault, { provider: 'prov-a', model: 'model-x' });
  assert.match(result.hint, /pluginDefault/);
  // absent reader -> no field; throwing reader -> degraded to absent
  const bare = makeHarness();
  assert.equal((await bare.ops.models({}, SUPERVISOR)).pluginDefault, undefined);
  const broken = makeHarness({ readSpawnDefaults: () => { throw new Error('bad'); } });
  assert.equal((await broken.ops.models({}, SUPERVISOR)).pluginDefault, undefined);
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
  assert.match(result.hint, /consider ending your turn/);
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
/* i18n: host-side UI strings follow the locale preference (0.15.0)     */
/* ------------------------------------------------------------------ */

test('i18n: resolveUiLocale never guesses an unshipped language', () => {
  assert.deepEqual(UI_LOCALES, ['zh', 'en']);
  assert.equal(resolveUiLocale('en'), 'en');
  assert.equal(resolveUiLocale('zh'), 'zh');
  assert.equal(resolveUiLocale(undefined), 'zh');
  assert.equal(resolveUiLocale('fr'), 'zh');
  assert.equal(resolveUiLocale(42), 'zh');
});

test('i18n: dictionaries carry the exact card labels and interpolate', () => {
  assert.equal(uiStrings('en').confirmApproveLabel, 'Dispatch as planned (Recommended)');
  assert.equal(uiStrings('en').confirmDeclineLabel, 'Not now');
  assert.equal(uiStrings().confirmDeclineLabel, '暂不派发'); // default = historical zh
  assert.equal(uiStrings('zh').confirmApproveLabel, '按计划派发（推荐）');
  assert.match(uiStrings('en').reportBackSuffix('session-x'), /^Reporting convention: .*session session-x via task_send/);
  assert.match(uiStrings('zh').reportBackSuffix('session-x'), /^汇报约定：.*发回会话 session-x/);
  assert.match(uiStrings('en').reportBackSuffix('session-x'), /End your turn right after sending/);
  assert.match(uiStrings('zh').reportBackSuffix('session-x'), /发送后即结束当前回合/);
  assert.match(uiStrings('en').selectQuestionDefault(3), /^3 proposed task\(s\)/);
  assert.match(uiStrings('zh').selectQuestionDefault(3), /^共 3 个任务/);
  // 0.19.0 ancestor-normalization kickoff suffix interpolates both paths, zh/en aligned
  assert.match(uiStrings('zh').workspaceNormalizedSuffix('/git/root', '/git/root/sub'), /^工作目录提示（工作区归一）：.*归一到工作区根 \/git\/root.*目标目录是 \/git\/root\/sub/);
  assert.match(uiStrings('zh').workspaceNormalizedSuffix('/git/root', '/git/root/sub'), /显式路径/);
  assert.match(uiStrings('en').workspaceNormalizedSuffix('/git/root', '/git/root/sub'), /^Working-directory note \(workspace normalization\): .*workspace root \/git\/root.*target directory is \/git\/root\/sub/);
  assert.match(uiStrings('en').workspaceNormalizedSuffix('/git/root', '/git/root/sub'), /Use explicit paths/);
});

test('i18n: report-back kickoff suffix follows uiLocale', async () => {
  const harness = makeHarness({ readUiLocale: () => 'en' });
  await harness.ops.spawnTask({ prompt: 'do the work' }, SUPERVISOR);
  const kickoff = harness.calls.prompt.at(-1).content[0].text;
  assert.match(kickoff, /^do the work\n\n---\nReporting convention: when done \(or confirmed blocked\), send a result summary back to session session-super via task_send/);
});

test('i18n: confirmPlan renders the en card and approves via the en label', async () => {
  let captured;
  const harness = makeHarness({
    readUiLocale: () => 'en',
    askUser: async (request) => {
      captured = request.questions[0];
      return { answers: [{ id: captured.id, selected: ['Dispatch as planned (Recommended)'] }] };
    },
  });
  const result = await harness.ops.confirmPlan({ plan: '# en plan' }, SUPERVISOR);
  assert.equal(captured.header, 'Dispatch confirmation');
  assert.equal(captured.question, 'Approve this decomposition and start dispatching?');
  assert.deepEqual(captured.options.map((option) => option.label), ['Dispatch as planned (Recommended)', 'Not now']);
  assert.equal(captured.intent.approve, 'Dispatch as planned (Recommended)');
  assert.equal(result.approved, true);
});

test('i18n: confirmPlan decline fallback uses the en label', async () => {
  const harness = makeHarness({
    readUiLocale: () => 'en',
    askUser: async (request) => ({ answers: request.questions.map((question) => ({ id: question.id, selected: [] })) }),
  });
  const declined = await harness.ops.confirmPlan({ plan: '# en plan' }, SUPERVISOR);
  assert.equal(declined.approved, false);
  assert.equal(declined.feedback, 'Not now');
});

test('i18n: confirmSelect en question and empty-selection feedback', async () => {
  let captured;
  const harness = makeHarness({
    readUiLocale: () => 'en',
    askUser: async (request) => {
      captured = request.questions[0];
      return { answers: [{ id: captured.id, selected: [] }] };
    },
  });
  const result = await harness.ops.confirmSelect({ tasks: [{ title: 'feat｜A' }, { title: 'feat｜B' }] }, SUPERVISOR);
  assert.match(captured.question, /^2 proposed task\(s\) — check the ones to dispatch/);
  assert.equal(result.approved, false);
  assert.equal(result.feedback, 'No task selected');
});

test('i18n: /tasks metadata follows the mounted strings', () => {
  const captured = [];
  const ctx = { commands: { register: (definition) => { captured.push(definition); return () => {}; } } };
  registerCommands(ctx, null, uiStrings('en'));
  assert.equal(captured[0].description, 'View coordination tasks and team groupings (direct query, no model turn)');
  assert.deepEqual(captured[0].input, { hint: '[team <name> | <sessionId>]' });
  registerCommands(ctx, null); // default stays the historical zh metadata
  assert.equal(captured[1].description, '查看协调任务与工作流编组（直接查询，不进模型）');
  assert.deepEqual(captured[1].input, { hint: '[team <名称> | <sessionId>]' });
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
  assert.ok(byName.task_list.parameters.ungrouped); // 0.19.0 ungrouped remediation filter
  assert.equal(byName.task_list.parameters.ungrouped.type, 'boolean');
  assert.equal(byName.task_send.parameters.sessionId.required, true);
  assert.deepEqual(byName.task_send.parameters.mode.enum, ['queue', 'steer']);
  assert.ok(byName.task_send.parameters.reference); // task_send correlation
  assert.ok(byName.task_spawn.parameters.team); // task_spawn workstream
  assert.ok(byName.task_spawn.parameters.externalRef); // 0.25.0 external caller reference
  assert.equal(byName.task_spawn.parameters.externalRef.type, 'string');
  assert.notEqual(byName.task_spawn.parameters.externalRef.required, true); // optional by contract C1
  assert.equal(byName.task_spawn_batch.parameters.tasks.items.properties.externalRef, undefined, 'batch items must NOT expose externalRef (out of scope, 0.25.0)');
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

/* ------------------------------------------------------------------ */
/* service seam: provide payload exposes the live ops (0.24.0)         */
/* ------------------------------------------------------------------ */

test('service seam: apply() provides a two-shaped taskCoordinator payload (0.24.0)', () => {
  // The repo carries no host peer packages, so index.mjs cannot be imported
  // here — pin the seam's source shape instead. verify-installed.mjs
  // re-verifies the RUNNING payload (enabled: ops present and callable;
  // disabled: ops absent) against the real installed copy.
  // NOTE: version-agnostic patterns on purpose — the lockstep with
  // package.json is asserted dynamically below (a hardcoded version pin
  // would fail on every bump, as 0.24.1 demonstrated).
  const src = readFileSync(new URL('../index.mjs', import.meta.url), 'utf8');
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  // disabled branch: the service still exists, but ops is ABSENT — the
  // bridge consumer's 503 degrade signal, never a missing service
  assert.match(src, /ctx\.provide\('taskCoordinator', \{ config, version: '[^']+' \}\);/, 'disabled branch must provide { config, version } with ops absent');
  // enabled branch: the full payload — the field name is exactly `ops`
  assert.match(src, /ctx\.provide\('taskCoordinator', \{ config, version: '[^']+', ops \}\);/, 'enabled branch must provide { config, version, ops }');
  // the ops-bearing provide must come after createOps (the instance only
  // exists once the factory has run on the enabled path)
  const opsAt = src.indexOf('const ops = createOps(');
  const fullProvideAt = src.indexOf(`ctx.provide('taskCoordinator', { config, version: '${pkg.version}', ops })`);
  assert.ok(opsAt >= 0 && fullProvideAt > opsAt, 'the ops-bearing provide must follow createOps');
  // exactly one provide per branch — cordis throws on a duplicate provide of
  // the same service, so there is no "provide early, provide again later"
  assert.equal((src.match(/ctx\.provide\(/g) ?? []).length, 2, 'apply() must call ctx.provide exactly twice (one per branch)');
  // the seam exposes the SAME instance the tools use: the factory runs once,
  // and registerTools receives that very variable
  assert.equal((src.match(/createOps\(/g) ?? []).length, 1, 'apply() must build the ops exactly once');
  assert.match(src, /const dispose = registerTools\(ctx, ops, \{ defineTool \}, config\);/, 'registerTools must receive the same ops variable the provide carries');
  // the version string stays in lockstep with package.json
  assert.match(src, new RegExp(`ctx\\.provide\\('taskCoordinator', \\{ config, version: '${pkg.version.replace(/\./g, '\\.')}', ops \\}\\);`), 'the enabled provide must carry the package version');
  assert.match(src, new RegExp(`ctx\\.provide\\('taskCoordinator', \\{ config, version: '${pkg.version.replace(/\./g, '\\.')}' \\}\\);`), 'the disabled provide must carry the package version too');
});

test('service seam: the provided ops is the 13-member createOps surface (0.24.0)', () => {
  const harness = makeHarness();
  // index.mjs provides the exact object createOps returns — the same instance
  // registerTools delegates to. The names below are ops.mjs's ACTUAL members
  // (pendingCount + 12 async capabilities), not the task_* tool names.
  const expected = ['pendingCount', 'listTasks', 'progress', 'sendMessage', 'spawnTask', 'confirmPlan', 'confirmSelect', 'consumeConfirmation', 'workspaceOp', 'models', 'spawnBatch', 'waitFor', 'cancelTask'];
  assert.deepEqual(Object.keys(harness.ops), expected, 'the createOps surface is exactly the 13 members the seam pins');
  for (const member of expected) {
    assert.equal(typeof harness.ops[member], 'function', `ops.${member} must be a function (bridge consumers call it)`);
  }
});
