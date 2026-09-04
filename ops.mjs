/**
 * Session operations for dsh-plugin-task-coordinator.
 *
 * Factory module: `createOps(deps)` receives every harness object through
 * dependency injection so the logic is unit-testable outside the host process.
 *
 * Expected deps (host wiring in index.mjs):
 *  - sessionController: ctx.sessionController (Remote-facade signatures:
 *    list(request, signal), search(request, signal), create(request),
 *    prompt(request, signal), cancel(request), rename(request),
 *    resolveAgent(sessionId), inspect(sessionId, signal))
 *  - agents: ctx.agents registry, `.get(sessionId) -> live agent | undefined`
 *  - createUserMessage: message factory from @deepseek-ai/dsh-llm
 *  - config: resolved plugin config (config.mjs)
 *  - limiter: SendLimiter instance (safety.mjs)
 *  - uuid: () => string unique request/session id source
 */

import { blocksToText, checkCaller, checkTarget, excerpt } from './safety.mjs';
import { buildSpawnTitle } from './title.mjs';

/**
 * @param {object} deps
 * @returns {TaskOps}
 */
export function createOps(deps) {
  const { sessionController, agents, createUserMessage, config, limiter, uuid } = deps;

  const fail = (message) => ({ ok: false, error: message });
  const shortId = (sessionId) => String(sessionId).replace(/^session-/, '').slice(0, 8);

  /** Locate one session row in the visible list without activating agents. */
  async function findRow(targetId, signal) {
    const rows = await sessionController.list({}, signal);
    const items = rows?.items ?? rows ?? [];
    return items.find((row) => row.sessionId === targetId);
  }

  /** Compact list row for model consumption. */
  function summarizeRow(row) {
    const projections = row.projections?.values ?? {};
    const todos = Array.isArray(projections.todos) ? projections.todos : null;
    const goal = projections.goal ?? null;
    const pending = todos === null ? 0 : todos.filter((todo) => todo.status !== 'completed').length;
    return {
      sessionId: row.sessionId,
      title: projections.title ?? null,
      status: row.running ? 'running' : row.blank ? 'blank' : 'idle',
      cwd: row.cwd ?? null,
      updatedAt: row.updatedAt,
      origin: row.origin ?? 'top-level',
      todos: todos === null ? null : `${todos.filter((todo) => todo.status === 'completed').length}/${todos.length} done`,
      goal: goal ? { objective: excerpt(goal.goal?.objective ?? '', 120), phase: goal.goal?.phase } : null,
      pendingTodos: pending,
    };
  }

  /** Extract the last surface-visible messages from a session event array. */
  function tailFromEvents(events, limit) {
    const picked = [];
    for (const event of events ?? []) {
      const data = event?.data;
      if (!data) continue;
      if (event.type === 'user/message') {
        const text = blocksToText(data.content);
        if (!text) continue;
        picked.push({
          role: 'user',
          source: data.source?.kind ?? 'user',
          text: excerpt(text, config.excerptChars),
        });
      } else if (event.type === 'assistant/message') {
        const text = blocksToText(data.message?.content);
        if (!text) continue;
        picked.push({
          role: 'assistant',
          text: excerpt(text, config.excerptChars),
        });
      }
    }
    return picked.slice(-limit);
  }

  /** Inbox depth probe used by the rate limiter. */
  function pendingCount(targetId) {
    const agent = agents.get(targetId);
    if (!agent) return 0;
    return (agent.inbox?.nextTurn?.length ?? 0) + (agent.inbox?.nextStep?.length ?? 0);
  }

  const ops = {
    pendingCount,

    /** Capability 1: discover tasks and their stable ids. */
    async listTasks({ filter, includeSubagents = false, limit = 50 } = {}, caller, signal) {
      const callerDeny = checkCaller(caller, config);
      if (callerDeny) return fail(callerDeny);
      const rows = await sessionController.list({}, signal);
      const items = rows?.items ?? rows ?? [];
      const wantedSubagents = includeSubagents || config.includeSubagentsInList;
      const needle = typeof filter === 'string' && filter.trim().length > 0 ? filter.trim().toLowerCase() : null;
      const tasks = [];
      for (const row of items) {
        if (row.origin === 'subagent' && !wantedSubagents) continue;
        if (needle) {
          const title = row.projections?.values?.title ?? '';
          const haystack = `${row.sessionId} ${title} ${row.cwd ?? ''}`.toLowerCase();
          if (!haystack.includes(needle)) continue;
        }
        tasks.push(summarizeRow(row));
      }
      tasks.sort((a, b) => b.updatedAt - a.updatedAt);
      const truncated = tasks.length > limit;
      return {
        ok: true,
        count: tasks.length,
        truncated,
        callerSessionId: caller.sessionId,
        tasks: tasks.slice(0, limit),
        hint: 'use task_progress to read one task in depth; task_send to message it',
      };
    },

    /** Capability 2: read one task's current progress without disturbing it. */
    async progress(targetId, caller, signal) {
      const callerDeny = checkCaller(caller, config);
      if (callerDeny) return fail(callerDeny);
      if (typeof targetId !== 'string' || targetId.length === 0) return fail('sessionId is required');
      const row = await findRow(targetId, signal);
      const targetDeny = checkTarget(caller, row && { sessionId: row.sessionId, origin: row.origin });
      if (targetDeny) return fail(targetDeny);
      const agent = agents.get(targetId);
      const result = {
        ok: true,
        sessionId: targetId,
        shortId: shortId(targetId),
        title: row?.projections?.values?.title ?? null,
        cwd: row?.cwd ?? null,
        updatedAt: row?.updatedAt ?? null,
        todos: row?.projections?.values?.todos ?? null,
        goal: row?.projections?.values?.goal ?? null,
      };
      if (agent) {
        result.agentState = agent.status; // 'idle' | 'running'
        result.queue = [
          ...(agent.inbox?.nextTurn ?? []).map((message) => ({
            placement: 'next-turn',
            source: message.source?.kind ?? 'unknown',
            text: excerpt(blocksToText(message.content), config.excerptChars),
          })),
          ...(agent.inbox?.nextStep ?? []).map((message) => ({
            placement: 'next-step',
            source: message.source?.kind ?? 'unknown',
            text: excerpt(blocksToText(message.content), config.excerptChars),
          })),
        ];
        result.recent = tailFromEvents(agent.session?.events, config.progressTailMessages);
        result.seq = agent.session?.seq ?? null;
      } else {
        result.agentState = 'cold-idle';
        result.queue = [];
        try {
          const observed = await sessionController.inspect(targetId, signal);
          result.recent = tailFromEvents(observed?.events, config.progressTailMessages);
        } catch (error) {
          result.recent = [];
          result.inspectError = error?.message ?? String(error);
        }
      }
      return result;
    },

    /** Capabilities 3+4: deliver a visible follow-up prompt to one task. */
    async sendMessage({ targetId, text, mode = 'queue' }, caller) {
      const callerDeny = checkCaller(caller, config);
      if (callerDeny) return fail(callerDeny);
      if (typeof targetId !== 'string' || targetId.length === 0) return fail('sessionId is required');
      if (typeof text !== 'string' || text.trim().length === 0) return fail('message text is required');
      if (mode !== 'queue' && mode !== 'steer') return fail("mode must be 'queue' or 'steer'");
      const row = await findRow(targetId);
      const targetDeny = checkTarget(caller, row && { sessionId: row.sessionId, origin: row.origin });
      if (targetDeny) return fail(targetDeny);
      const limitDeny = limiter.check(targetId);
      if (limitDeny) return fail(limitDeny);
      const resolved = await sessionController.resolveAgent(targetId);
      if (!resolved || resolved.error) {
        const code = resolved?.error?.code ?? 'internal';
        if (code === 'agent-busy') return fail('target task is briefly busy admitting other work; retry in a moment');
        if (code === 'session-not-found') return fail('target session vanished before delivery');
        return fail(`target task could not be resolved: ${resolved?.error?.message ?? code}`);
      }
      const message = createUserMessage({
        content: [{ type: 'text', text }],
        source: { kind: 'coordinator', form: 'relay', senderSessionId: caller.sessionId },
      });
      if (mode === 'steer') resolved.agent.steer(message);
      else resolved.agent.followup(message);
      limiter.accept(targetId);
      return {
        ok: true,
        delivered: true,
        targetId,
        mode,
        placement: mode === 'steer' ? 'next-step (mid-run steering)' : 'next-turn (queued; starts a new round when the task is idle)',
        targetStatus: resolved.agent.status,
      };
    },

    /** Capability 6: spawn a brand-new task; it appears in the session list. */
    async spawnTask({ title, prompt, cwd, sessionId, agentPreset }, caller, signal) {
      const callerDeny = checkCaller(caller, config);
      if (callerDeny) return fail(callerDeny);
      if (typeof prompt !== 'string' || prompt.trim().length === 0) return fail('prompt is required to start the new task');
      if (sessionId !== undefined) {
        const limitDeny = limiter.check(sessionId);
        if (limitDeny) return fail(limitDeny);
      }
      const request = {};
      if (typeof sessionId === 'string' && sessionId.length > 0) request.sessionId = sessionId;
      const resolvedCwd = typeof cwd === 'string' && cwd.length > 0 ? cwd : caller.cwd;
      if (resolvedCwd) request.cwd = resolvedCwd;
      if (typeof agentPreset === 'string' && agentPreset.length > 0) request.agentPreset = agentPreset;
      let created;
      try {
        created = await sessionController.create(request);
      } catch (error) {
        return fail(`session creation failed: ${error?.message ?? error}`);
      }
      const newId = created.sessionId;
      // Spawn-title rule: MMDD｜类型｜主题. The date prefix is stamped mechanically
      // from the creation time (Asia/Shanghai by default); the caller supplies the
      // semantic part (类型｜主题), and the topic falls back to the kickoff prompt's
      // first line when no title is given. Renaming is cosmetic — never fail the
      // spawn over it.
      let appliedTitle = null;
      const builtTitle = buildSpawnTitle({ title, prompt }, config, Date.now());
      try {
        const renamed = await sessionController.rename({ sessionId: newId, title: builtTitle });
        appliedTitle = renamed.title;
      } catch (error) {
        appliedTitle = null;
      }
      let started = false;
      try {
        // The Remote facade's prompt(request, signal) dereferences the signal
        // unconditionally (signal.throwIfAborted()), so a valid AbortSignal is
        // always supplied: the caller's when present, else a fresh one.
        await sessionController.prompt({
          requestId: uuid(),
          sessionId: newId,
          mode: 'queue',
          content: [{ type: 'text', text: prompt.trim() }],
        }, signal ?? new AbortController().signal);
        started = true;
        limiter.accept(newId);
      } catch (error) {
        return {
          ok: false,
          error: `session ${newId} was created but the kickoff prompt was rejected: ${error?.message ?? error}`,
          sessionId: newId,
        };
      }
      return {
        ok: true,
        sessionId: newId,
        shortId: shortId(newId),
        title: appliedTitle,
        cwd: resolvedCwd ?? null,
        started,
        hint: 'the new task is now visible in the session list; track it with task_progress',
      };
    },

    /** Capability 5 (wait): block until one task becomes idle, or time out. */
    async waitFor(targetId, { timeoutMs, signal } = {}, caller) {
      const callerDeny = checkCaller(caller, config);
      if (callerDeny) return fail(callerDeny);
      const requested = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : config.waitDefaultTimeoutMs;
      const clamped = Math.min(requested, config.waitMaxTimeoutMs);
      const startedAt = Date.now();
      const agent = agents.get(targetId);
      const finish = (settled, reason) => {
        const row = undefined;
        return {
          ok: true,
          sessionId: targetId,
          settled,
          reason,
          waitedMs: Date.now() - startedAt,
          agentState: agent ? agent.status : 'cold-idle',
        };
      };
      if (!agent) return finish(true, 'target has no live agent; it is cold-idle');
      if (agent.status === 'idle') return finish(true, 'target already idle');
      const timeout = new Promise((resolve) => {
        const timer = setTimeout(() => resolve('timeout'), clamped);
        if (typeof timer.unref === 'function') timer.unref();
      });
      const aborted = new Promise((resolve) => {
        if (!signal) return;
        if (signal.aborted) return resolve('aborted');
        signal.addEventListener('abort', () => resolve('aborted'), { once: true });
      });
      let woke;
      try {
        woke = await Promise.race([agent.whenIdle().then(() => 'idle'), timeout, aborted]);
      } catch (error) {
        return fail(`wait failed: ${error?.message ?? error}`);
      }
      if (woke === 'idle') return finish(true, 'target became idle');
      if (woke === 'aborted') return finish(false, 'wait aborted by caller');
      return finish(false, `timed out after ${clamped}ms; task still ${agent.status}`);
    },

    /** Capability 5 (hard stop): cancel the active turn, keep the inbox. */
    async cancelTask(targetId, caller) {
      const callerDeny = checkCaller(caller, config);
      if (callerDeny) return fail(callerDeny);
      const agent = agents.get(targetId);
      if (!agent) return fail('target has no live agent; nothing to cancel');
      try {
        await sessionController.cancel({ sessionId: targetId });
      } catch (error) {
        return fail(`cancel rejected: ${error?.message ?? error}`);
      }
      limiter.forget(targetId);
      return { ok: true, cancelled: true, sessionId: targetId, note: 'active turn cancelled; queued messages are kept' };
    },
  };

  return ops;
}
