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
});

test('config: overrides and clamps', () => {
  const config = resolveConfig({ maxQueuePerTask: 0, waitDefaultTimeoutMs: 90, waitMaxTimeoutMs: 10, titleMaxTopicChars: 0 });
  assert.equal(config.maxQueuePerTask, 1);
  assert.equal(config.waitDefaultTimeoutMs, 10);
  assert.equal(config.waitMaxTimeoutMs, 10);
  assert.equal(config.titleMaxTopicChars, 1);
  const custom = resolveConfig({ titleTypes: [' 功能 ', '研究'], titleFallbackType: '研究', titleTimeZone: 'UTC' });
  assert.deepEqual(custom.titleTypes, ['功能', '研究']);
  assert.equal(custom.titleFallbackType, '研究');
  assert.equal(custom.titleTimeZone, 'UTC');
});

test('config: wrong types throw', () => {
  assert.throws(() => resolveConfig({ enabled: 'yes' }), TypeError);
  assert.throws(() => resolveConfig({ maxQueuePerTask: -3 }), TypeError);
  assert.throws(() => resolveConfig({ titleFallbackType: 42 }), TypeError);
  assert.throws(() => resolveConfig({ titleTypes: '功能' }), TypeError);
  assert.throws(() => resolveConfig({ titleTypes: [] }), TypeError);
  assert.throws(() => resolveConfig({ titleTypes: ['功能', ''] }), TypeError);
  assert.throws(() => resolveConfig({ titleMaxTopicChars: -1 }), TypeError);
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
  assert.match(checkCaller({ sessionId: 'session-a', origin: 'subagent' }, config), /subagent/);
  assert.equal(checkCaller({ sessionId: 'session-a', origin: 'subagent' }, resolveConfig({ allowSubagentUse: true })), null);
  assert.match(checkCaller(null, config), /caller identity/);
});

test('safety: target gates', () => {
  const caller = { sessionId: 'session-a' };
  assert.match(checkTarget(caller, undefined), /not found/);
  assert.match(checkTarget(caller, { sessionId: 'session-a' }), /itself/);
  assert.match(checkTarget(caller, { sessionId: 'session-b', origin: 'subagent' }), /subagent-owned/);
  assert.equal(checkTarget(caller, { sessionId: 'session-b' }), null);
});

test('safety: limiter rate + depth', () => {
  let time = 1000;
  let depth = 0;
  const config = resolveConfig({ minSendIntervalMs: 5000, maxQueuePerTask: 2 });
  const limiter = new SendLimiter(config, () => depth, () => time);
  assert.equal(limiter.check('t1'), null);
  limiter.accept('t1');
  assert.match(limiter.check('t1'), /rate limited/);
  time += 5000;
  assert.equal(limiter.check('t1'), null);
  depth = 2;
  assert.match(limiter.check('t1'), /pending/);
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
  const calls = { create: [], prompt: [], rename: [], cancel: [], resolve: [], list: 0, inspect: [] };
  const sessions = new Map(); // sessionId -> row
  const liveAgents = new Map(); // sessionId -> mock agent

  const sessionController = {
    async list() {
      calls.list += 1;
      return { items: [...sessions.values()] };
    },
    async create(request) {
      calls.create.push(request);
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
  harness.ops = createOps({
    sessionController,
    agents,
    createUserMessage,
    config,
    limiter,
    uuid: () => 'req-test-1',
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
  assert.equal(harness.calls.prompt[0].content[0].text, 'migrate the module');
  assert.equal(harness.calls.prompt[0].sessionId, result.sessionId);
  // new session row exists -> visible in list
  const listing = await harness.ops.listTasks({}, SUPERVISOR);
  assert.ok(listing.tasks.some((task) => task.sessionId === result.sessionId));
});

test('ops.spawnTask: defaults cwd to caller; title derived from kickoff prompt', async () => {
  const harness = makeHarness();
  const result = await harness.ops.spawnTask({ prompt: 'go' }, SUPERVISOR);
  assert.equal(result.ok, true);
  assert.equal(harness.calls.create[0].cwd, '/work');
  // no explicit title -> MMDD｜fallback-type｜first-line-of-prompt
  assert.match(result.title, /^\d{4}｜探索｜go$/);
  assert.equal(harness.calls.rename.length, 1);
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
  assert.equal(result.sessionId, 'session-new');
  assert.match(result.error, /created but the kickoff prompt was rejected/);
});

test('ops.waitFor: already idle settles immediately', async () => {
  const harness = makeHarness();
  addLiveAgent(harness, 'session-a', { status: 'idle' });
  const result = await harness.ops.waitFor('session-a', {}, SUPERVISOR);
  assert.equal(result.settled, true);
  assert.match(result.reason, /already idle/);
});

test('ops.waitFor: cold session settles immediately', async () => {
  const harness = makeHarness();
  const result = await harness.ops.waitFor('session-ghost', {}, SUPERVISOR);
  assert.equal(result.settled, true);
  assert.match(result.reason, /cold-idle/);
});

test('ops.waitFor: times out on never-idle agent', async () => {
  const harness = makeHarness();
  const agent = addLiveAgent(harness, 'session-a', { status: 'running' });
  agent.idlePromise = new Promise(() => {}); // never resolves
  const result = await harness.ops.waitFor('session-a', { timeoutMs: 50 }, SUPERVISOR);
  assert.equal(result.settled, false);
  assert.match(result.reason, /timed out after 50ms/);
});

test('ops.waitFor: settles when agent goes idle', async () => {
  const harness = makeHarness();
  const agent = addLiveAgent(harness, 'session-a', { status: 'running' });
  let release;
  agent.idlePromise = new Promise((resolve) => {
    release = resolve;
  });
  const pending = harness.ops.waitFor('session-a', { timeoutMs: 5000 }, SUPERVISOR);
  setTimeout(release, 10);
  const result = await pending;
  assert.equal(result.settled, true);
  assert.match(result.reason, /became idle/);
});

test('ops.cancelTask: live cancel and cold refusal', async () => {
  const harness = makeHarness();
  addLiveAgent(harness, 'session-a');
  const ok = await harness.ops.cancelTask('session-a', SUPERVISOR);
  assert.equal(ok.ok, true);
  assert.equal(harness.calls.cancel.length, 1);
  const cold = await harness.ops.cancelTask('session-ghost', SUPERVISOR);
  assert.equal(cold.ok, false);
  assert.match(cold.error, /no live agent/);
});

/* ------------------------------------------------------------------ */
/* tools registration                                                  */
/* ------------------------------------------------------------------ */

test('registerTools: six tools with delegation', async () => {
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
  assert.deepEqual(registered.map((tool) => tool.name), ['task_list', 'task_progress', 'task_send', 'task_spawn', 'task_wait', 'task_cancel']);
  assert.deepEqual(registered[0].parameters.sessionId, undefined);
  assert.equal(registered[2].parameters.sessionId.required, true);
  assert.deepEqual(registered[2].parameters.mode.enum, ['queue', 'steer']);
  // delegation through execute()
  addRow(harness, { sessionId: 'session-a' });
  const listResult = await registered[0].execute({}, { agent: { id: 'session-super', session: { header: {} } } });
  assert.equal(listResult.ok, true);
  const denyResult = await registered[2].execute({ sessionId: 'session-super', message: 'hi' }, { agent: { id: 'session-super', session: { header: {} } } });
  assert.equal(denyResult.ok, false);
  assert.equal(registered.length, 6);
  dispose();
  assert.equal(registered.length, 0);
});
