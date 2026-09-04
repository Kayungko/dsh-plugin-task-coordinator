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
 *  - registry: SpawnRegistry instance (registry.mjs), optional
 *  - uuid: () => string unique request/session id source
 *
 * Failure shape is `{ ok: false, code, error }` with stable machine-readable
 * codes (absorbed from SCDP's typed-error idea), so callers can branch
 * programmatically instead of parsing prose.
 */

import { blocksToText, checkCaller, checkTarget, excerpt } from './safety.mjs';
import { buildSpawnTitle } from './title.mjs';

/** Operation-level failure codes (guard denials carry their own codes). */
export const OP_CODES = Object.freeze({
  BAD_REQUEST: 'bad-request',
  SPAWN_CREATE_FAILED: 'spawn-create-failed',
  KICKOFF_REJECTED: 'kickoff-rejected',
  TARGET_BUSY: 'target-busy',
  TARGET_VANISHED: 'target-vanished',
  RESOLVE_FAILED: 'resolve-failed',
  TARGET_COLD: 'target-cold',
  WAIT_FAILED: 'wait-failed',
  CANCEL_REJECTED: 'cancel-rejected',
});

/**
 * @param {object} deps
 * @returns {TaskOps}
 */
export function createOps(deps) {
  const { sessionController, agents, createUserMessage, config, limiter, registry, uuid } = deps;

  const fail = (code, message) => ({ ok: false, code, error: message });
  const failDeny = (denial) => fail(denial.code, denial.message);
  const shortId = (sessionId) => String(sessionId).replace(/^session-/, '').slice(0, 8);

  /** Locate one session row in the visible list without activating agents. */
  async function findRow(targetId, signal) {
    const rows = await sessionController.list({}, signal);
    const items = rows?.items ?? rows ?? [];
    return items.find((row) => row.sessionId === targetId);
  }

  /** Compact list row for model consumption, enriched with registry team. */
  function summarizeRow(row) {
    const projections = row.projections?.values ?? {};
    const todos = Array.isArray(projections.todos) ? projections.todos : null;
    const goal = projections.goal ?? null;
    const pending = todos === null ? 0 : todos.filter((todo) => todo.status !== 'completed').length;
    const recorded = registry?.get(row.sessionId);
    return {
      sessionId: row.sessionId,
      title: projections.title ?? null,
      ...(recorded?.team !== undefined ? { team: recorded.team } : {}),
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

  /** Normalize the wait tool's target input to a clean id array. */
  function normalizeTargetIds({ sessionId, sessionIds }) {
    const raw = Array.isArray(sessionIds) && sessionIds.length > 0
      ? sessionIds
      : typeof sessionId === 'string' && sessionId.length > 0 ? [sessionId] : [];
    const cleaned = [];
    for (const id of raw) {
      if (typeof id === 'string' && id.trim().length > 0 && !cleaned.includes(id.trim())) {
        cleaned.push(id.trim());
      }
    }
    return cleaned;
  }

  const ops = {
    pendingCount,

    /** Capability 1: discover tasks and their stable ids. */
    async listTasks({ filter, team, includeSubagents = false, limit = 50 } = {}, caller, signal) {
      const callerDeny = checkCaller(caller, config);
      if (callerDeny) return failDeny(callerDeny);
      const rows = await sessionController.list({}, signal);
      const items = rows?.items ?? rows ?? [];
      const wantedSubagents = includeSubagents || config.includeSubagentsInList;
      const needle = typeof filter === 'string' && filter.trim().length > 0 ? filter.trim().toLowerCase() : null;
      const wantedTeam = typeof team === 'string' && team.trim().length > 0 ? team.trim() : null;
      const teamMembers = wantedTeam && registry ? new Set(registry.listTeam(wantedTeam)) : null;
      const tasks = [];
      for (const row of items) {
        if (row.origin === 'subagent' && !wantedSubagents) continue;
        if (teamMembers && !teamMembers.has(row.sessionId)) continue;
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
        ...(wantedTeam ? { team: wantedTeam } : {}),
        tasks: tasks.slice(0, limit),
        hint: 'use task_progress to read one task in depth; task_send to message it',
      };
    },

    /** Capability 2: read one task's current progress without disturbing it. */
    async progress(targetId, caller, signal) {
      const callerDeny = checkCaller(caller, config);
      if (callerDeny) return failDeny(callerDeny);
      if (typeof targetId !== 'string' || targetId.length === 0) {
        return fail(OP_CODES.BAD_REQUEST, 'sessionId is required');
      }
      const row = await findRow(targetId, signal);
      const targetDeny = checkTarget(caller, row && { sessionId: row.sessionId, origin: row.origin });
      if (targetDeny) return failDeny(targetDeny);
      const recorded = registry?.get(targetId);
      const agent = agents.get(targetId);
      const result = {
        ok: true,
        sessionId: targetId,
        shortId: shortId(targetId),
        ...(recorded?.team !== undefined ? { team: recorded.team } : {}),
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
    async sendMessage({ targetId, text, mode = 'queue', reference }, caller) {
      const callerDeny = checkCaller(caller, config);
      if (callerDeny) return failDeny(callerDeny);
      if (typeof targetId !== 'string' || targetId.length === 0) {
        return fail(OP_CODES.BAD_REQUEST, 'sessionId is required');
      }
      if (typeof text !== 'string' || text.trim().length === 0) {
        return fail(OP_CODES.BAD_REQUEST, 'message text is required');
      }
      if (mode !== 'queue' && mode !== 'steer') {
        return fail(OP_CODES.BAD_REQUEST, "mode must be 'queue' or 'steer'");
      }
      const row = await findRow(targetId);
      const targetDeny = checkTarget(caller, row && { sessionId: row.sessionId, origin: row.origin });
      if (targetDeny) return failDeny(targetDeny);
      const limitDeny = limiter.check(targetId);
      if (limitDeny) return failDeny(limitDeny);
      const resolved = await sessionController.resolveAgent(targetId);
      if (!resolved || resolved.error) {
        const code = resolved?.error?.code ?? 'internal';
        if (code === 'agent-busy') {
          return fail(OP_CODES.TARGET_BUSY, 'target task is briefly busy admitting other work; retry in a moment');
        }
        if (code === 'session-not-found') {
          return fail(OP_CODES.TARGET_VANISHED, 'target session vanished before delivery');
        }
        return fail(OP_CODES.RESOLVE_FAILED, `target task could not be resolved: ${resolved?.error?.message ?? code}`);
      }
      // Optional correlation: a visible annotation line quoting an earlier
      // instruction id, so corrections and handoffs stay traceable.
      const annotation = typeof reference === 'string' && reference.trim().length > 0
        ? `[reference: ${reference.trim()}]\n`
        : '';
      const message = createUserMessage({
        content: [{ type: 'text', text: `${annotation}${text}` }],
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
        ...(message?.id !== undefined ? { messageId: message.id } : {}),
        ...(annotation ? { reference: reference.trim() } : {}),
        placement: mode === 'steer' ? 'next-step (mid-run steering)' : 'next-turn (queued; starts a new round when the task is idle)',
        targetStatus: resolved.agent.status,
        hint: 'delivered != consumed; verify with task_progress before resending',
      };
    },

    /** Capability 6: spawn a brand-new task; it appears in the session list. */
    async spawnTask({ title, prompt, cwd, sessionId, agentPreset, team }, caller, signal) {
      const callerDeny = checkCaller(caller, config);
      if (callerDeny) return failDeny(callerDeny);
      if (typeof prompt !== 'string' || prompt.trim().length === 0) {
        return fail(OP_CODES.BAD_REQUEST, 'prompt is required to start the new task');
      }
      const cleanTeam = typeof team === 'string' && team.trim().length > 0 ? team.trim() : undefined;
      if (sessionId !== undefined) {
        const limitDeny = limiter.check(sessionId);
        if (limitDeny) return failDeny(limitDeny);
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
        return fail(OP_CODES.SPAWN_CREATE_FAILED, `session creation failed: ${error?.message ?? error}`);
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
      // Record the spawn durably (team + intent) so the supervisor can recover
      // "its" tasks after a host restart. Recorded before kickoff so even a
      // created-but-not-started orphan remains traceable.
      registry?.record(newId, {
        ...(cleanTeam !== undefined ? { team: cleanTeam } : {}),
        ...(appliedTitle ? { title: appliedTitle } : {}),
        promptExcerpt: excerpt(prompt.trim(), 120),
      });
      const correlationId = uuid();
      let started = false;
      try {
        // The Remote facade's prompt(request, signal) dereferences the signal
        // unconditionally (signal.throwIfAborted()), so a valid AbortSignal is
        // always supplied: the caller's when present, else a fresh one.
        await sessionController.prompt({
          requestId: correlationId,
          sessionId: newId,
          mode: 'queue',
          content: [{ type: 'text', text: prompt.trim() }],
        }, signal ?? new AbortController().signal);
        started = true;
        limiter.accept(newId);
      } catch (error) {
        return {
          ok: false,
          code: OP_CODES.KICKOFF_REJECTED,
          error: `session ${newId} was created but the kickoff prompt was rejected: ${error?.message ?? error}`,
          sessionId: newId,
          ...(cleanTeam !== undefined ? { team: cleanTeam } : {}),
        };
      }
      return {
        ok: true,
        sessionId: newId,
        shortId: shortId(newId),
        title: appliedTitle,
        ...(cleanTeam !== undefined ? { team: cleanTeam } : {}),
        cwd: resolvedCwd ?? null,
        started,
        correlationId,
        hint: 'the new task is now visible in the session list; track it with task_progress',
      };
    },

    /**
     * Capability 5 (wait): block until task(s) become idle, or time out.
     * mode 'all' settles when every target is idle; 'any' when the first is.
     */
    async waitFor({ sessionId, sessionIds, timeoutMs, mode = 'all', signal } = {}, caller) {
      const callerDeny = checkCaller(caller, config);
      if (callerDeny) return failDeny(callerDeny);
      const targets = normalizeTargetIds({ sessionId, sessionIds });
      if (targets.length === 0) {
        return fail(OP_CODES.BAD_REQUEST, 'sessionId or sessionIds is required');
      }
      if (mode !== 'all' && mode !== 'any') {
        return fail(OP_CODES.BAD_REQUEST, "mode must be 'all' or 'any'");
      }
      const requested = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : config.waitDefaultTimeoutMs;
      const clamped = Math.min(requested, config.waitMaxTimeoutMs);
      const startedAt = Date.now();

      const snapshot = targets.map((id) => {
        const agent = agents.get(id);
        const alreadyIdle = !agent || agent.status === 'idle';
        return { sessionId: id, agent, idle: alreadyIdle };
      });
      const targetOf = (id) => snapshot.find((entry) => entry.sessionId === id);
      const finish = (settled, reason) => ({
        ok: true,
        mode,
        settled,
        reason,
        waitedMs: Date.now() - startedAt,
        count: targets.length,
        targets: snapshot.map((entry) => ({
          sessionId: entry.sessionId,
          idle: entry.idle,
          agentState: entry.agent ? entry.agent.status : 'cold-idle',
        })),
        ...(targets.length === 1 ? { sessionId: targets[0] } : {}),
      });

      if (mode === 'all' && snapshot.every((entry) => entry.idle)) {
        return finish(true, targets.length === 1 ? 'target already idle' : 'all targets already idle');
      }
      if (mode === 'any' && snapshot.some((entry) => entry.idle)) {
        const first = snapshot.find((entry) => entry.idle);
        return finish(true, `target ${first.sessionId} already idle`);
      }

      const idleWatches = snapshot
        .filter((entry) => !entry.idle && entry.agent)
        .map((entry) => entry.agent.whenIdle().then(() => { entry.idle = true; return entry.sessionId; }));
      const timeout = new Promise((resolve) => {
        const timer = setTimeout(() => resolve('timeout'), clamped);
        if (typeof timer.unref === 'function') timer.unref();
      });
      const aborted = new Promise((resolve) => {
        if (!signal) return;
        if (signal.aborted) return resolve('aborted');
        signal.addEventListener('abort', () => resolve('aborted'), { once: true });
      });
      const barrier = mode === 'all' ? Promise.all(idleWatches).then(() => 'all-idle') : Promise.race(idleWatches);
      let woke;
      try {
        woke = await Promise.race([barrier, timeout, aborted]);
      } catch (error) {
        return fail(OP_CODES.WAIT_FAILED, `wait failed: ${error?.message ?? error}`);
      }
      if (woke === 'aborted') return finish(false, 'wait aborted by caller');
      if (woke === 'timeout') {
        const pending = snapshot.filter((entry) => !entry.idle).map((entry) => entry.sessionId);
        return finish(false, `timed out after ${clamped}ms; still running: ${pending.join(', ')}`);
      }
      if (mode === 'any') return finish(true, `target ${woke} became idle`);
      return finish(true, targets.length === 1 ? 'target became idle' : 'all targets became idle');
    },

    /** Capability 5 (hard stop): cancel the active turn, keep the inbox. */
    async cancelTask(targetId, caller) {
      const callerDeny = checkCaller(caller, config);
      if (callerDeny) return failDeny(callerDeny);
      const agent = agents.get(targetId);
      if (!agent) return fail(OP_CODES.TARGET_COLD, 'target has no live agent; nothing to cancel');
      try {
        await sessionController.cancel({ sessionId: targetId });
      } catch (error) {
        return fail(OP_CODES.CANCEL_REJECTED, `cancel rejected: ${error?.message ?? error}`);
      }
      limiter.forget(targetId);
      return { ok: true, cancelled: true, sessionId: targetId, note: 'active turn cancelled; queued messages are kept' };
    },
  };

  return ops;
}
