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
  SPAWN_DEPTH_EXCEEDED: 'spawn-depth-exceeded',
  BATCH_ALL_FAILED: 'batch-all-failed',
  CONFIRMATION_REQUIRED: 'confirmation-required',
  CONFIRMATION_MISMATCH: 'confirmation-mismatch',
  CONFIRM_CANCELLED: 'confirm-cancelled',
  CONFIRM_ABORTED: 'confirm-aborted',
  NO_QUESTION_CHANNEL: 'no-question-channel',
  DELEGATED_CALLER: 'delegated-caller',
  CALLER_NOT_LIVE: 'caller-not-live',
  TARGET_BUSY: 'target-busy',
  TARGET_VANISHED: 'target-vanished',
  RESOLVE_FAILED: 'resolve-failed',
  TARGET_COLD: 'target-cold',
  WAIT_FAILED: 'wait-failed',
  CANCEL_REJECTED: 'cancel-rejected',
  WORKSPACE_NOT_FOUND: 'workspace-not-found',
  WORKSPACE_OP_FAILED: 'workspace-op-failed',
  MODEL_UNAVAILABLE: 'model-unavailable',
  MODEL_SELECT_FAILED: 'model-select-failed',
});

/** Approve option label for the dispatch-confirmation card (must match exactly). */
export const CONFIRM_APPROVE_LABEL = '按计划派发（推荐）';

/** Decline option label for the dispatch-confirmation card. */
export const CONFIRM_DECLINE_LABEL = '暂不派发';

/**
 * Resolve the workspace a spawn should attach to: the workspace (if any)
 * whose membership contains the caller or one of its recorded spawn
 * ancestors. Pure and failure-tolerant — any missing piece yields undefined
 * and the caller falls back to plain cwd semantics.
 * @param {string} callerSessionId - the session doing the spawning
 * @param {object|null} registry - durable spawn registry (parent chain)
 * @param {Function|undefined} listWorkspaces - lazy host registry snapshot
 * @returns {string|undefined} workspaceId to pass to sessionController.create
 */
export function resolveCallerWorkspaceId(callerSessionId, registry, listWorkspaces) {
  if (typeof callerSessionId !== 'string' || callerSessionId.length === 0) return undefined;
  if (typeof listWorkspaces !== 'function') return undefined;
  let workspaces;
  try {
    workspaces = listWorkspaces();
  } catch {
    return undefined;
  }
  if (!Array.isArray(workspaces) || workspaces.length === 0) return undefined;
  const candidates = new Set([callerSessionId]);
  let entry = registry?.get?.(callerSessionId);
  let hops = 0;
  while (entry?.parentSessionId && hops < 8) {
    candidates.add(entry.parentSessionId);
    entry = registry?.get?.(entry.parentSessionId);
    hops += 1;
  }
  const hit = workspaces.find(
    (workspace) => Array.isArray(workspace?.sessionIds) && workspace.sessionIds.some((id) => candidates.has(id)),
  );
  return typeof hit?.id === 'string' && hit.id.length > 0 ? hit.id : undefined;
}

/**
 * Best-effort path lookup for a workspace id (result payload only — the host
 * derives the real cwd itself). Failure-tolerant like resolveCallerWorkspaceId.
 * @param {string} workspaceId - workspace to look up
 * @param {Function|undefined} listWorkspaces - lazy host registry snapshot
 * @returns {string|undefined} the workspace path when known
 */
export function workspacePathOf(workspaceId, listWorkspaces) {
  if (typeof workspaceId !== 'string' || workspaceId.length === 0) return undefined;
  if (typeof listWorkspaces !== 'function') return undefined;
  let workspaces;
  try {
    workspaces = listWorkspaces();
  } catch {
    return undefined;
  }
  if (!Array.isArray(workspaces)) return undefined;
  const hit = workspaces.find((workspace) => workspace?.id === workspaceId);
  return typeof hit?.path === 'string' && hit.path.length > 0 ? hit.path : undefined;
}

/**
 * Normalize a filesystem path for exact workspace matching. Platform-aware
 * (0.12.1): win32 unifies separators to backslash, strips trailing
 * separators (drive roots kept) and folds case (NTFS is case-insensitive);
 * darwin folds case only (default volumes are case-insensitive); POSIX keeps
 * case and treats backslash as a regular filename character. Not a general
 * realpath — the host entity does full validation on attach itself.
 * @param {string} value - raw path
 * @param {string} [platform] - override for tests; defaults to process.platform
 * @returns {string} comparable form
 */
export function normalizeWorkspacePath(value, platform = process.platform) {
  let path = String(value).trim();
  if (platform === 'win32') {
    path = path.replaceAll('/', '\\');
    while (path.length > 1 && path.endsWith('\\') && !/^[A-Za-z]:\\$/.test(path)) path = path.slice(0, -1);
    return path.toLowerCase();
  }
  while (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);
  return platform === 'darwin' ? path.toLowerCase() : path;
}

/**
 * Find the workspace whose path exactly matches a directory (0.12.0):
 * powers the spawn cwd→workspace upgrade and task_workspace path targeting.
 * Failure-tolerant like the other registry helpers.
 * @param {string|undefined} cwd - directory to match
 * @param {Function|undefined} listWorkspaces - lazy host registry snapshot
 * @param {string} [platform] - normalization override for tests
 * @returns {object|undefined} the matching workspace snapshot entry
 */
export function findWorkspaceByPath(cwd, listWorkspaces, platform) {
  if (typeof cwd !== 'string' || cwd.trim().length === 0) return undefined;
  if (typeof listWorkspaces !== 'function') return undefined;
  let workspaces;
  try {
    workspaces = listWorkspaces();
  } catch {
    return undefined;
  }
  if (!Array.isArray(workspaces)) return undefined;
  const target = normalizeWorkspacePath(cwd, platform);
  return workspaces.find(
    (workspace) => typeof workspace?.path === 'string' && normalizeWorkspacePath(workspace.path, platform) === target,
  );
}

/**
 * @param {object} deps
 * @returns {TaskOps}
 */
export function createOps(deps) {
  const { sessionController, agents, createUserMessage, config, limiter, registry, uuid, askUser, listWorkspaces, getWorkspace, resolveModelConfig } = deps;

  const fail = (code, message) => ({ ok: false, code, error: message });
  const failDeny = (denial) => fail(denial.code, denial.message);
  const shortId = (sessionId) => String(sessionId).replace(/^session-/, '').slice(0, 8);

  /**
   * Approved-but-unused dispatch confirmations (confirmationId -> record).
   * Process-local on purpose: after a host restart the supervisor simply
   * confirms again rather than acting on stale approvals.
   */
  const confirmations = new Map();

  /** Map one user-questions service error to our stable codes. */
  function failQuestionError(error) {
    const code = error?.code;
    if (code === 'ASK_CANCELLED') {
      return fail(OP_CODES.CONFIRM_CANCELLED, 'the user closed the confirmation card without answering; stop dispatching and wait for the user\'s next message');
    }
    if (code === 'ASK_ABORTED') {
      return fail(OP_CODES.CONFIRM_ABORTED, 'confirmation was aborted before the user answered');
    }
    if (code === 'NO_PROVIDER') {
      return fail(OP_CODES.NO_QUESTION_CHANNEL, 'no UI is connected to answer interactive questions; present the plan in plain text and get the user\'s go-ahead in chat');
    }
    if (code === 'DELEGATED_CALLER') {
      return fail(OP_CODES.DELEGATED_CALLER, 'human interaction is only available from a live root session; include the plan and the pending decision in your final result instead');
    }
    if (code === 'CALLER_NOT_LIVE') {
      return fail(OP_CODES.CALLER_NOT_LIVE, 'the calling agent is no longer the exact live instance; retry from a fresh tool call');
    }
    return fail('internal', `confirmation channel failed: ${error?.message ?? error}`);
  }

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
    async spawnTask({ title, prompt, cwd, sessionId, agentPreset, team, reportBack, provider, model, reasoningEffort }, caller, signal) {
      const callerDeny = checkCaller(caller, config);
      if (callerDeny) return failDeny(callerDeny);
      if (typeof prompt !== 'string' || prompt.trim().length === 0) {
        return fail(OP_CODES.BAD_REQUEST, 'prompt is required to start the new task');
      }
      // Per-child model selection (0.13.0): provider+model are a pair; the
      // optional reasoningEffort only rides along with them. Validated up-front
      // through the host LLM catalog when available so an invalid route never
      // creates an orphan session; installed after creation via the host's
      // sessionController.selectModel (the same API the GUI model picker uses —
      // note it also updates the app-wide default model, host semantics).
      const hasProvider = provider !== undefined && provider !== null && String(provider).trim().length > 0;
      const hasModel = model !== undefined && model !== null && String(model).trim().length > 0;
      if (hasProvider !== hasModel) {
        return fail(OP_CODES.BAD_REQUEST, 'provider and model must be supplied together (or both omitted to use the host default)');
      }
      const modelSpec = hasProvider
        ? {
            provider: String(provider).trim(),
            model: String(model).trim(),
            ...(reasoningEffort !== undefined && reasoningEffort !== null && String(reasoningEffort).trim().length > 0
              ? { reasoningEffort: String(reasoningEffort).trim() }
              : {}),
          }
        : undefined;
      if (modelSpec && typeof resolveModelConfig === 'function') {
        const precheck = resolveModelConfig(modelSpec);
        if (precheck) {
          try {
            await precheck;
          } catch (error) {
            return fail(OP_CODES.MODEL_UNAVAILABLE, `model selection was rejected by the host catalog: ${error?.message ?? error}`);
          }
        }
      }
      // Recursion governance: the child's depth derives from the caller's
      // recorded depth (a never-spawned root session counts as depth 0).
      // Beyond maxSpawnDepth the tree stops growing; the rejected coordinator
      // should fall back to subagents for deeper parallelism.
      const parentEntry = registry?.get(caller.sessionId);
      const childDepth = (parentEntry?.depth ?? 0) + 1;
      if (childDepth > config.maxSpawnDepth) {
        return fail(
          OP_CODES.SPAWN_DEPTH_EXCEEDED,
          `spawn depth would be ${childDepth} but maxSpawnDepth is ${config.maxSpawnDepth}; use subagents for deeper parallelism instead of spawning new task sessions`,
        );
      }
      const cleanTeam = typeof team === 'string' && team.trim().length > 0 ? team.trim() : undefined;
      if (sessionId !== undefined) {
        const limitDeny = limiter.check(sessionId);
        if (limitDeny) return failDeny(limitDeny);
      }
      const request = {};
      if (typeof sessionId === 'string' && sessionId.length > 0) request.sessionId = sessionId;
      if (typeof agentPreset === 'string' && agentPreset.length > 0) request.agentPreset = agentPreset;
      // Workspace inheritance: an explicit cwd overrides caller-workspace
      // membership (legacy semantics); otherwise the child attaches to the
      // caller's workspace so spawned tasks stay visible beside their
      // supervisor instead of landing in the ungrouped bucket. The host
      // derives cwd from the workspace path and rejects requests carrying
      // both fields.
      // cwd→workspace upgrade (0.12.0): whenever the cwd we would send is
      // exactly a workspace's path, send workspaceId instead — the host
      // attaches the child to that workspace and derives the same cwd, so
      // explicit-cwd spawns (and supervisors that are themselves ungrouped)
      // no longer drop children into the ungrouped bucket.
      const explicitCwd = typeof cwd === 'string' && cwd.length > 0 ? cwd : undefined;
      let effectiveCwd;
      if (explicitCwd) {
        const byPath = findWorkspaceByPath(explicitCwd, listWorkspaces);
        if (byPath?.id) {
          request.workspaceId = byPath.id;
          effectiveCwd = byPath.path ?? explicitCwd;
        } else {
          request.cwd = explicitCwd;
          effectiveCwd = explicitCwd;
        }
      } else {
        const workspaceId = resolveCallerWorkspaceId(caller.sessionId, registry, listWorkspaces);
        if (workspaceId) {
          request.workspaceId = workspaceId;
          effectiveCwd = workspacePathOf(workspaceId, listWorkspaces) ?? caller.cwd;
        } else if (caller.cwd) {
          const byPath = findWorkspaceByPath(caller.cwd, listWorkspaces);
          if (byPath?.id) {
            request.workspaceId = byPath.id;
            effectiveCwd = byPath.path ?? caller.cwd;
          } else {
            request.cwd = caller.cwd;
            effectiveCwd = caller.cwd;
          }
        }
      }
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
        depth: childDepth,
        parentSessionId: caller.sessionId,
      });
      // Install the per-child model BEFORE the kickoff so the very first turn
      // runs on the requested route. A failure leaves a traceable orphan (the
      // registry record above) and never kicks off on the wrong model.
      let installedModel;
      if (modelSpec) {
        try {
          const selection = await sessionController.selectModel({ sessionId: newId, ...modelSpec });
          installedModel = selection?.selected ?? modelSpec;
        } catch (error) {
          return {
            ok: false,
            code: OP_CODES.MODEL_SELECT_FAILED,
            error: `session ${newId} was created but the model could not be installed: ${error?.message ?? error} — the kickoff was NOT sent; pick the model manually (or task_cancel the orphan) and task_send the prompt`,
            sessionId: newId,
            depth: childDepth,
            ...(cleanTeam !== undefined ? { team: cleanTeam } : {}),
          };
        }
      }
      const correlationId = uuid();
      // Report-back convention (default on): the kickoff prompt tells the new
      // task to push its result summary back to the spawning session via
      // task_send when it finishes, so the supervisor gets push instead of
      // only pull. The registry excerpt keeps the user's original prompt.
      const wantsReport = reportBack !== false;
      const kickoffText = wantsReport
        ? `${prompt.trim()}\n\n---\n汇报约定：完成（或确认无法完成）后，用 task_send 把结果摘要发回会话 ${caller.sessionId}（内容：结论、产出路径、遗留问题）。若发送失败，把摘要完整写进你的最终回复。`
        : prompt.trim();
      let started = false;
      try {
        // The Remote facade's prompt(request, signal) dereferences the signal
        // unconditionally (signal.throwIfAborted()), so a valid AbortSignal is
        // always supplied: the caller's when present, else a fresh one.
        await sessionController.prompt({
          requestId: correlationId,
          sessionId: newId,
          mode: 'queue',
          content: [{ type: 'text', text: kickoffText }],
        }, signal ?? new AbortController().signal);
        started = true;
        limiter.accept(newId);
      } catch (error) {
        return {
          ok: false,
          code: OP_CODES.KICKOFF_REJECTED,
          error: `session ${newId} was created but the kickoff prompt was rejected: ${error?.message ?? error}`,
          sessionId: newId,
          depth: childDepth,
          ...(cleanTeam !== undefined ? { team: cleanTeam } : {}),
        };
      }
      return {
        ok: true,
        sessionId: newId,
        shortId: shortId(newId),
        title: appliedTitle,
        ...(cleanTeam !== undefined ? { team: cleanTeam } : {}),
        cwd: effectiveCwd ?? null,
        ...(installedModel !== undefined ? { model: installedModel } : {}),
        started,
        correlationId,
        depth: childDepth,
        hint: 'the new task is now visible in the session list; track it with task_progress',
      };
    },

    /**
     * Capability 6c: interactive dispatch confirmation. Presents the plan as a
     * plan-review card through the ctx.userQuestions seam (same mechanism as
     * the official exit_plan_mode) and blocks until the user answers.
     * Approval mints a single-use confirmationId consumed by task_spawn_batch.
     */
    async confirmPlan({ plan, question, reusable }, caller, agent, signal) {
      const callerDeny = checkCaller(caller, config);
      if (callerDeny) return failDeny(callerDeny);
      if (typeof plan !== 'string' || plan.trim().length === 0) {
        return fail(OP_CODES.BAD_REQUEST, 'plan is required (markdown: what gets split into how many tasks and why)');
      }
      // Host plan-review convention (dsh-plan-mode exit_plan_mode uses the same
      // check): the reviewed body must be markdown starting with a # heading,
      // so every card body renders with the same structure as official plans.
      if (!/^#\s+\S/.test(plan.trim())) {
        return fail(OP_CODES.BAD_REQUEST, 'plan must be markdown starting with a # heading (host plan-review convention, same as exit_plan_mode)');
      }
      if (typeof askUser !== 'function') {
        return fail(OP_CODES.NO_QUESTION_CHANNEL, 'no user-questions channel composed; present the plan in plain text and get the go-ahead in chat');
      }
      // Plan-review narrowing (verified against dsh-user-questions + client
      // PlanReviewPanel): single question, no multiSelect, <=2 options, detail
      // present, and the approve label must name one option exactly.
      const approveLabel = CONFIRM_APPROVE_LABEL;
      const reviewQuestion = {
        id: 'task-dispatch-review',
        header: '派发确认',
        question: typeof question === 'string' && question.trim().length > 0 ? question.trim() : '批准该拆分方案并开始派发？',
        detail: plan.trim(),
        options: [
          { label: approveLabel, description: '总控将按上述方案批量派发任务' },
          { label: CONFIRM_DECLINE_LABEL, description: '取消本次派发；在聊天里说明调整意见' },
        ],
        intent: { kind: 'plan-review', approve: approveLabel },
      };
      let result;
      try {
        result = await askUser({ questions: [reviewQuestion], agent, signal });
      } catch (error) {
        return failQuestionError(error);
      }
      if (result === null || result === undefined) {
        return fail(OP_CODES.NO_QUESTION_CHANNEL, 'no UI is connected to answer interactive questions; present the plan in plain text and get the user\'s go-ahead in chat');
      }
      const answer = Array.isArray(result.answers) ? result.answers.find((entry) => entry?.id === reviewQuestion.id) : undefined;
      const selected = Array.isArray(answer?.selected) ? answer.selected : [];
      const approved = selected.includes(approveLabel);
      if (approved) {
        const confirmationId = `confirm-${uuid()}`;
        confirmations.set(confirmationId, {
          callerSessionId: caller.sessionId,
          approvedAt: Date.now(),
          taskHint: excerpt(plan.trim(), 80),
          ...(reusable === true ? { reusable: true } : {}),
        });
        return {
          ok: true,
          approved: true,
          confirmationId,
          ...(reusable === true ? { reusable: true } : {}),
          hint: reusable === true
            ? 'pass this confirmationId to every task_spawn_batch of this mission; it is REUSABLE (survives successful batches) and bound to your session'
            : 'pass this confirmationId to task_spawn_batch for this plan; it is single-use and bound to your session',
        };
      }
      return {
        ok: true,
        approved: false,
        feedback: typeof answer?.custom === 'string' && answer.custom.trim().length > 0 ? answer.custom.trim() : (selected[0] ?? CONFIRM_DECLINE_LABEL),
        hint: 'do not dispatch; fold the user\'s feedback into a revised plan and confirm again',
      };
    },

    /**
     * Capability 6d (0.10.0): multi-select dispatch confirmation. Renders the
     * proposed task list as ONE multi-select question in the host's neutral
     * question UI (no plan-review intent → no amber warn styling; multiSelect +
     * the custom input row are generic-UI capabilities). The user checks WHICH
     * of the proposed tasks to dispatch; approval mints a confirmationId bound
     * to the selected subset, and spawnBatch enforces the batch stays within it.
     * The generic UI renders no markdown body, so the supervisor presents the
     * full plan in chat before calling this (the tool description says so).
     */
    async confirmSelect({ question, tasks, reusable }, caller, agent, signal) {
      const callerDeny = checkCaller(caller, config);
      if (callerDeny) return failDeny(callerDeny);
      if (!Array.isArray(tasks) || tasks.length === 0) {
        return fail(OP_CODES.BAD_REQUEST, 'tasks must be a non-empty array of {title, scope?} items (or plain title strings)');
      }
      const options = [];
      const seen = new Set();
      for (const [index, item] of tasks.entries()) {
        const title = typeof item === 'string' ? item.trim() : typeof item?.title === 'string' ? item.title.trim() : '';
        if (title.length === 0) return fail(OP_CODES.BAD_REQUEST, `tasks[${index}].title is required`);
        if (seen.has(title)) return fail(OP_CODES.BAD_REQUEST, `tasks[${index}].title duplicates "${title}" — option labels must be unique`);
        seen.add(title);
        const scope = typeof item === 'string' ? undefined : typeof item?.scope === 'string' && item.scope.trim().length > 0 ? item.scope.trim() : undefined;
        options.push(scope === undefined ? { label: title } : { label: title, description: scope });
      }
      if (typeof askUser !== 'function') {
        return fail(OP_CODES.NO_QUESTION_CHANNEL, 'no user-questions channel composed; list the tasks in chat and let the user pick by replying');
      }
      const selectQuestion = {
        id: 'task-dispatch-select',
        question: typeof question === 'string' && question.trim().length > 0
          ? question.trim()
          : `共 ${options.length} 个任务，勾选要派发的（未勾选的不派发；可在自定义输入行写调整意见）`,
        multiSelect: true,
        options,
      };
      let result;
      try {
        result = await askUser({ questions: [selectQuestion], agent, signal });
      } catch (error) {
        return failQuestionError(error);
      }
      if (result === null || result === undefined) {
        return fail(OP_CODES.NO_QUESTION_CHANNEL, 'no UI is connected to answer interactive questions; list the tasks in chat and get the user\'s pick there');
      }
      const answer = Array.isArray(result.answers) ? result.answers.find((entry) => entry?.id === selectQuestion.id) : undefined;
      const selected = Array.isArray(answer?.selected) ? answer.selected.filter((label) => typeof label === 'string') : [];
      const custom = typeof answer?.custom === 'string' && answer.custom.trim().length > 0 ? answer.custom.trim() : undefined;
      if (selected.length === 0) {
        return {
          ok: true,
          approved: false,
          feedback: custom ?? '未选择任何任务',
          hint: 'do not dispatch; fold the user\'s feedback into a revised task list and confirm again',
        };
      }
      const confirmationId = `confirm-${uuid()}`;
      confirmations.set(confirmationId, {
        callerSessionId: caller.sessionId,
        approvedAt: Date.now(),
        taskHint: excerpt(`select ${selected.length}/${options.length}: ${selected.join(', ')}`, 80),
        selected,
        ...(reusable === true ? { reusable: true } : {}),
      });
      return {
        ok: true,
        approved: true,
        selected,
        ...(custom !== undefined ? { custom } : {}),
        confirmationId,
        ...(reusable === true ? { reusable: true } : {}),
        hint: reusable === true
          ? 'pass this confirmationId to every task_spawn_batch of this mission; it is REUSABLE (survives successful batches) but the batch must still contain ONLY the selected tasks; bound to your session'
          : 'pass this confirmationId to task_spawn_batch; the batch must contain ONLY the selected tasks (titles match exactly); single-use and bound to your session',
      };
    },

    /** Consume one approved confirmationId for this caller, if valid. */
    consumeConfirmation(confirmationId, caller) {
      const record = typeof confirmationId === 'string' ? confirmations.get(confirmationId) : undefined;
      if (!record || record.callerSessionId !== caller.sessionId) return false;
      confirmations.delete(confirmationId);
      return true;
    },

    /**
     * task_workspace (0.12.0): list host workspaces or move an EXISTING
     * top-level session into/out of one. Attach/detach go through the live
     * workspace entity — the same API the host's session.create uses
     * internally (workspace.attachSession validates the session's stored cwd
     * against the workspace path). Never injects a message into the session.
     */
    async workspaceOp({ action, sessionId, workspaceId, workspacePath }, caller) {
      const callerDeny = checkCaller(caller, config);
      if (callerDeny) return failDeny(callerDeny);
      const mode = typeof action === 'string' && action.trim().length > 0 ? action.trim().toLowerCase() : 'list';
      if (!['list', 'attach', 'detach'].includes(mode)) {
        return fail(OP_CODES.BAD_REQUEST, `unknown action '${action}' (expected list | attach | detach)`);
      }
      if (mode === 'list') {
        let workspaces;
        try {
          workspaces = typeof listWorkspaces === 'function' ? listWorkspaces() : [];
        } catch {
          workspaces = [];
        }
        if (!Array.isArray(workspaces)) workspaces = [];
        return {
          ok: true,
          action: 'list',
          workspaces: workspaces.map((workspace) => ({
            id: workspace?.id,
            path: workspace?.path,
            ...(typeof workspace?.title === 'string' ? { title: workspace.title } : {}),
            sessionIds: Array.isArray(workspace?.sessionIds) ? [...workspace.sessionIds] : [],
          })),
        };
      }
      if (typeof sessionId !== 'string' || sessionId.trim().length === 0) {
        return fail(OP_CODES.BAD_REQUEST, `action '${mode}' requires sessionId`);
      }
      const cleanSessionId = sessionId.trim();
      // Resolve the target workspace: explicit id wins, else exact path match.
      let targetId = typeof workspaceId === 'string' && workspaceId.trim().length > 0 ? workspaceId.trim() : undefined;
      if (!targetId) {
        const byPath = findWorkspaceByPath(workspacePath, listWorkspaces);
        if (byPath?.id) targetId = byPath.id;
      }
      if (!targetId) {
        return fail(OP_CODES.WORKSPACE_NOT_FOUND, 'no workspace matched: pass workspaceId (see action list) or an exact workspacePath');
      }
      const entity = typeof getWorkspace === 'function' ? getWorkspace(targetId) : undefined;
      const method = mode === 'attach' ? 'attachSession' : 'detachSession';
      if (!entity || typeof entity[method] !== 'function') {
        return fail(OP_CODES.WORKSPACE_NOT_FOUND, `workspace '${targetId}' is not available from the host registry`);
      }
      try {
        await entity[method](cleanSessionId);
      } catch (error) {
        return fail(OP_CODES.WORKSPACE_OP_FAILED, `${mode} failed: ${error?.message ?? error}`);
      }
      return { ok: true, action: mode, sessionId: cleanSessionId, workspaceId: targetId };
    },

    /**
     * Capability 6b: spawn a whole decomposition plan in one call.
     * Every item goes through spawnTask (title rule, registry, depth
     * governance); one failed item does not abort the rest. Batches at or
     * above confirmBatchThreshold require an approved confirmationId when
     * confirmBeforeBatch is on.
     */
    async spawnBatch({ tasks, team, confirmationId, reportBack }, caller, signal) {
      const callerDeny = checkCaller(caller, config);
      if (callerDeny) return failDeny(callerDeny);
      if (!Array.isArray(tasks) || tasks.length === 0) {
        return fail(OP_CODES.BAD_REQUEST, 'tasks must be a non-empty array of {title?, prompt} items');
      }
      if (tasks.length > config.maxBatchSpawn) {
        return fail(OP_CODES.BAD_REQUEST, `batch of ${tasks.length} exceeds maxBatchSpawn (${config.maxBatchSpawn}); split into smaller batches`);
      }
      for (const [index, item] of tasks.entries()) {
        if (!item || typeof item !== 'object' || typeof item.prompt !== 'string' || item.prompt.trim().length === 0) {
          return fail(OP_CODES.BAD_REQUEST, `tasks[${index}].prompt is required`);
        }
      }
      // Dispatch confirmation gate: big fan-outs must be user-approved first.
      const needsConfirmation = config.confirmBeforeBatch && tasks.length >= config.confirmBatchThreshold;
      const record = typeof confirmationId === 'string' ? confirmations.get(confirmationId) : undefined;
      if (needsConfirmation && (!record || record.callerSessionId !== caller.sessionId)) {
        return fail(
          OP_CODES.CONFIRMATION_REQUIRED,
          `batches of ${config.confirmBatchThreshold}+ tasks need user approval: call task_confirm with this plan first, then pass its confirmationId`,
        );
      }
      // Select-form approval (task_confirm_select, 0.10.0): the batch must stay
      // within the user-checked subset regardless of whether the size gate fired.
      if (record && record.callerSessionId === caller.sessionId && Array.isArray(record.selected)) {
        const approved = new Set(record.selected);
        const unapproved = tasks
          .map((item) => (typeof item.title === 'string' && item.title.trim().length > 0 ? item.title.trim() : '(untitled)'))
          .filter((title) => !approved.has(title));
        if (unapproved.length > 0) {
          return fail(
            OP_CODES.CONFIRMATION_MISMATCH,
            `the user only approved: ${record.selected.join(', ')} — not approved in this batch: ${unapproved.join(', ')}. Drop the unapproved items or re-confirm with task_confirm_select`,
          );
        }
      }
      const cleanTeam = typeof team === 'string' && team.trim().length > 0 ? team.trim() : undefined;
      const results = [];
      let startedCount = 0;
      for (const item of tasks) {
        // Each item gets its own signal-free path; abort the whole batch when
        // the caller's signal is already gone.
        if (signal?.aborted) {
          results.push({ ok: false, code: 'bad-request', error: 'batch aborted by caller' });
          continue;
        }
        const result = await ops.spawnTask({
          title: item.title,
          prompt: item.prompt,
          cwd: item.cwd,
          sessionId: item.sessionId,
          agentPreset: item.agentPreset,
          provider: item.provider,
          model: item.model,
          reasoningEffort: item.reasoningEffort,
          team: cleanTeam,
          reportBack,
        }, caller, signal);
        if (result.ok) startedCount += 1;
        results.push(result.ok
          ? { ok: true, sessionId: result.sessionId, title: result.title, correlationId: result.correlationId, depth: result.depth }
          : { ok: false, code: result.code, error: result.error, ...(result.sessionId !== undefined ? { sessionId: result.sessionId } : {}) });
      }
      if (startedCount === 0) {
        // Keep the confirmation usable so the supervisor does not re-ask for
        // the same plan after an all-failed attempt.
        return { ok: false, code: OP_CODES.BATCH_ALL_FAILED, error: `all ${tasks.length} batch spawns failed`, results };
      }
      if (needsConfirmation && typeof confirmationId === 'string' && record?.reusable !== true) {
        confirmations.delete(confirmationId); // single-use: consumed on success (reusable credentials survive)
      }
      return {
        ok: true,
        startedCount,
        failedCount: results.length - startedCount,
        ...(cleanTeam !== undefined ? { team: cleanTeam } : {}),
        results,
        hint: 'wait for the whole batch with task_wait({ sessionIds: [...], mode: "all" })',
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
