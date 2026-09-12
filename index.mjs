/**
 * dsh-plugin-task-coordinator — entry point.
 *
 * Codex-style cross-task coordination for DeepSeek Harness: a supervisor
 * agent can list top-level sessions, read their progress, spawn new ones
 * (visible in the session list), and deliver visible follow-up prompts with
 * idle-wakeup / running-queue semantics, plus steering, waiting and cancel.
 *
 * Host wiring contract (verified against 0.1.2-alpha.1):
 *  - ctx.sessionController: @deepseek-ai/dsh-api-session-controller service
 *  - ctx.agents: live agent registry (`.get(sessionId)`)
 *  - ctx.tools: @deepseek-ai/dsh-tools registry
 *
 * Service seam (0.24.0): apply() provides 'taskCoordinator' with the live ops
 * instance — { config, version, ops }, the same instance the tools use — on
 * the enabled path, and a reduced { config, version } payload (ops absent)
 * when disabled. The service lives in a shared-label isolate realm so future
 * bridge plugins declaring the same label can resolve it: cordis.patch.yml
 * and docs/PROTOCOL.md §17 carry the full seam contract.
 */

import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { statSync } from 'node:fs';
import { join } from 'node:path';
import z from '@deepseek-ai/schemastery';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { resolveConfig } from './config.mjs';
import { SendLimiter } from './safety.mjs';
import { createOps } from './ops.mjs';
import { registerTools } from './tools.mjs';
import { registerCommands } from './commands.mjs';
import { mountCoordinatorSkills } from './skills.mjs';
import { SpawnRegistry } from './registry.mjs';
import { resolveUiLocale, uiStrings } from './i18n.mjs';
import { SPAWN_MODELS_NS, SPAWN_MODELS_BASE, buildSpawnModelsSchema, normalizeSpawnRoute, normalizeQueueCap, validateSpawnModelsSection } from './settings.mjs';

export const name = 'task-coordinator';
export const inject = ['agents', 'tools', 'sessionController', 'commands'];

/** Default registry path: <DSH_HOME or ~/.dsh>/task-coordinator/registry.json */
export function defaultRegistryFile() {
  const dshHome = process.env.DSH_HOME && process.env.DSH_HOME.trim().length > 0
    ? process.env.DSH_HOME.trim()
    : join(homedir(), '.dsh');
  return join(dshHome, 'task-coordinator', 'registry.json');
}

export function apply(ctx, input = {}) {
  const config = resolveConfig(input);
  // 0.24.0 service seam: the service ALWAYS exists (a missing service would
  // leave bridge consumers forever inert), but the payload is two-shaped.
  // Disabled provides { config, version } with ops ABSENT — the degrade
  // signal bridge consumers map to 503; enabled provides the full payload
  // after createOps below (the instance only exists on that path).
  if (!config.enabled) {
    ctx.provide('taskCoordinator', { config, version: '0.25.2' });
    ctx.logger?.info('task-coordinator: disabled by config; no tools registered');
    return;
  }
  const sessionController = ctx.sessionController;
  if (!sessionController || typeof sessionController.list !== 'function' || typeof sessionController.resolveAgent !== 'function') {
    throw new Error('task-coordinator: ctx.sessionController is unavailable; mount @deepseek-ai/dsh-api-session-controller first');
  }
  const agents = ctx.agents;
  if (!agents || typeof agents.get !== 'function') {
    throw new Error('task-coordinator: ctx.agents is unavailable');
  }
  // 0.23.0: maxQueuePerTask becomes GUI-editable (Settings → 任务编排). The
  // limiter reads its cap through a live getter, so a settings edit applies
  // from the next check() onward without a restart — the same live-read
  // pattern as readSpawnDefaults (defined below; the getter only runs after
  // apply() completes, so the forward reference is safe). Any settings
  // failure falls back to the resolved patch-config value.
  const limiterConfig = { ...config };
  Object.defineProperty(limiterConfig, 'maxQueuePerTask', {
    enumerable: true,
    configurable: true,
    get: () => readQueueCap() ?? config.maxQueuePerTask,
  });
  const limiter = new SendLimiter(limiterConfig, (targetId) => {
    const agent = agents.get(targetId);
    if (!agent) return 0;
    return (agent.inbox?.nextTurn?.length ?? 0) + (agent.inbox?.nextStep?.length ?? 0);
  });
  const registry = new SpawnRegistry(
    typeof config.registryFile === 'string' && config.registryFile.trim().length > 0
      ? config.registryFile.trim()
      : defaultRegistryFile(),
    { maxEntries: config.registryMaxEntries },
  );
  // Interactive confirmation channel: the ctx.userQuestions seam (same one
  // the official exit_plan_mode uses). Resolved lazily per call so the seam
  // mounting order does not matter; missing service degrades to a coded
  // error, never a crash. Not hard-injected: hosts without the seam still get
  // every other tool.
  const askUser = (request) => {
    const service = typeof ctx.get === 'function' ? ctx.get('userQuestions') : undefined;
    if (!service || typeof service.ask !== 'function') return Promise.resolve(null);
    return service.ask(request);
  };
  // Workspace inheritance: spawned tasks attach to the caller's workspace.
  // The host's sessionController.create accepts workspaceId (mutually
  // exclusive with cwd) and attaches the new session to it; without one,
  // sessions land in the ungrouped bucket. Resolved lazily per spawn — a
  // missing or throwing registry degrades to plain cwd semantics.
  const listWorkspaces = () => {
    try {
      const service = typeof ctx.get === 'function' ? ctx.get('workspaceRegistry') : undefined;
      const list = typeof service?.list === 'function' ? service.list() : undefined;
      return Array.isArray(list) ? list : [];
    } catch {
      return [];
    }
  };
  // task_workspace (0.12.0): live workspace-entity access for attaching or
  // detaching EXISTING sessions — the same entity API the host's own
  // session.create calls (attachSession/detachSession). Degrades to undefined
  // when the registry is missing; the op then reports workspace-not-found.
  const getWorkspace = (workspaceId) => {
    try {
      const service = typeof ctx.get === 'function' ? ctx.get('workspaceRegistry') : undefined;
      return typeof service?.get === 'function' ? service.get(workspaceId) : undefined;
    } catch {
      return undefined;
    }
  };
  // Per-child model selection (0.13.0): optional up-front validation through
  // the host LLM catalog (ctx.llm.resolveCallConfig — the same resolver
  // sessionController.selectModel uses). Returns undefined when the service is
  // absent; ops then relies on selectModel's own validation after creation.
  const resolveModelConfig = (selection) => {
    try {
      const service = typeof ctx.get === 'function' ? ctx.get('llm') : undefined;
      if (typeof service?.resolveCallConfig !== 'function') return undefined;
      return service.resolveCallConfig(selection);
    } catch {
      return undefined;
    }
  };
  // Model-route discovery (0.14.0): every deployment connects different
  // providers/models, so valid ids come from the live registry — never
  // hardcoded. Both helpers are failure-tolerant; undefined degrades the
  // model-unavailable hint to its original message.
  const listModelProviders = () => {
    try {
      const service = typeof ctx.get === 'function' ? ctx.get('llm') : undefined;
      return typeof service?.listProviders === 'function' ? service.listProviders() : undefined;
    } catch {
      return undefined;
    }
  };
  const listProviderModels = (providerId) => {
    try {
      const service = typeof ctx.get === 'function' ? ctx.get('llm') : undefined;
      return typeof service?.listModels === 'function' ? service.listModels(providerId) : undefined;
    } catch {
      return undefined;
    }
  };
  // UI localization (0.15.0): host-side user-visible strings (confirmation
  // cards, report-back kickoff suffix, /tasks metadata) follow the host
  // Language preference — the durable settings namespace "locale" (field
  // "preference": "zh" | "en") owned by @deepseek-ai/dsh-client-locale, the
  // same value the GUI's Settings → General → Language row writes. Read live
  // per call, so switching the language applies from the next card/kickoff
  // onward. Absent settings service, unregistered namespace or unknown
  // preference keeps the historical zh strings — the host side cannot see the
  // browser-language delegation an absent preference means on the client.
  const readUiLocale = () => {
    try {
      const service = typeof ctx.get === 'function' ? ctx.get('settings') : undefined;
      const stored = typeof service?.get === 'function' ? service.get('locale') : undefined;
      return resolveUiLocale(stored?.preference);
    } catch {
      return 'zh';
    }
  };
  // Spawn-model defaults (0.18.0): a durable settings section the GUI edits
  // (Settings → 任务编排, a first-level section) and task_spawn falls back to when a call
  // omits provider+model. Registered through the host settings service's
  // installSection (subagent-model-selection precedent): our entry is the
  // composition base, the user layer composes over it, scope.get() resolves.
  // Optional dependency — hosts without the settings service keep the tools
  // on the pre-0.18 host-default behavior. The live read mirrors readUiLocale
  // (read per call, never cached), so a GUI edit applies from the next spawn
  // onward without a restart.
  ctx.inject(['settings'], (settingsCtx) => {
    try {
      settingsCtx.settings.installSection(ctx, SPAWN_MODELS_NS, buildSpawnModelsSchema(z), SPAWN_MODELS_BASE, {
        setSource: () => {},
        validate: (value) => {
          validateSpawnModelsSection(value);
        },
        onChange: () => {},
      });
      ctx.logger?.info?.(`task-coordinator: settings section "${SPAWN_MODELS_NS}" installed (spawn-model defaults)`);
    } catch (error) {
      ctx.logger?.warn?.(`task-coordinator: settings section install failed (${error?.message ?? error}); spawn-model defaults stay unset`);
    }
  });
  const readSpawnDefaults = () => {
    try {
      const service = typeof ctx.get === 'function' ? ctx.get('settings') : undefined;
      const stored = typeof service?.get === 'function' ? service.get(SPAWN_MODELS_NS) : undefined;
      return normalizeSpawnRoute(stored); // throws only on a malformed half pair
    } catch {
      // Defensive by contract: a malformed stored layer (or a missing service)
      // degrades to "no default route" and never breaks the spawn itself.
      return null;
    }
  };
  // Queue-cap override (0.23.0): live-read like readSpawnDefaults; null means
  // "follow the patch config" (config.mjs default 5). normalizeQueueCap
  // clamps hand-edited yaml values above the ceiling (MAX_QUEUE_PER_TASK_CAP).
  const readQueueCap = () => {
    try {
      const service = typeof ctx.get === 'function' ? ctx.get('settings') : undefined;
      const stored = typeof service?.get === 'function' ? service.get(SPAWN_MODELS_NS) : undefined;
      return normalizeQueueCap(stored);
    } catch {
      return null;
    }
  };
  // Cross-workspace migration (0.16.0): the host never rewrites a session's
  // stored cwd, so a true move is clone + archive — the route the host's own
  // fork() uses internally (sessions.create seeded with the full event log)
  // and dsh-session-mover proved for cross-workspace moves. readSession
  // returns cloned header + complete replay-validated events without making
  // the source live; create seeds a NEW session born with the target cwd;
  // archiveSession durably retires the original. The read/create closures
  // degrade to undefined when their service is missing — ops then reports
  // migrate-unavailable; archiveSession surfaces absence as an error, which
  // ops records as a warning on an otherwise successful move.
  const readSessionSnapshot = async (sessionId) => {
    const service = typeof ctx.get === 'function' ? ctx.get('sessionQuery') : undefined;
    if (typeof service?.readSession !== 'function') return undefined;
    const snapshot = await service.readSession(sessionId);
    if (!snapshot || typeof snapshot !== 'object') return undefined;
    return {
      header: snapshot.session,
      events: Array.isArray(snapshot.events) ? snapshot.events : [],
    };
  };
  const createSeededSession = async ({ seed, meta }) => {
    const service = typeof ctx.get === 'function' ? ctx.get('sessions') : undefined;
    if (typeof service?.create !== 'function') return undefined;
    const session = service.create(undefined, { seed, meta });
    if (typeof service.flush === 'function') await service.flush(session);
    const id = typeof session?.id === 'string' ? session.id : session?.header?.id;
    return typeof id === 'string' && id.length > 0 ? { id } : undefined;
  };
  const archiveSession = async (sessionId) => {
    const service = typeof ctx.get === 'function' ? ctx.get('workspaceRegistry') : undefined;
    if (typeof service?.archiveSession !== 'function') throw new Error('workspaceRegistry.archiveSession unavailable');
    await service.archiveSession(sessionId);
  };
  // Git-worktree probe (0.19.0): a linked worktree's `.git` is a FILE
  // (pointing at `<main>/.git/worktrees/<name>`), while a plain checkout's
  // `.git` is a directory. Pure fs marker read — NO git subprocess, no
  // gitdir back-resolution (that unverified mechanism belongs to the
  // reserved 'grouping' tier). Anything missing/throwing = not a worktree,
  // so spawn placement degrades to the plain ungrouped terminal.
  const probeWorktree = (candidate) => {
    try {
      if (typeof candidate !== 'string' || candidate.trim().length === 0) return false;
      const stats = statSync(join(candidate, '.git'), { throwIfNoEntry: false });
      return stats !== undefined && typeof stats.isFile === 'function' && stats.isFile();
    } catch {
      return false;
    }
  };
  const ops = createOps({
    sessionController,
    agents,
    createUserMessage,
    config,
    limiter,
    registry,
    uuid: () => `task-coord-${randomUUID()}`,
    askUser,
    listWorkspaces,
    getWorkspace,
    resolveModelConfig,
    listModelProviders,
    listProviderModels,
    readUiLocale,
    readSpawnDefaults,
    readSessionSnapshot,
    createSeededSession,
    archiveSession,
    probeWorktree,
    logger: ctx.logger,
  });
  // 0.24.0 service seam: expose THE ops instance through the provide payload
  // so future bridge plugins (dsh-plugin-task-bridge) reuse this exact
  // limiter/registry/confirmation state instead of forking it. Read-only by
  // contract (docs/PROTOCOL.md §17): consumers call members, never replace
  // or wrap them. This is the enabled-branch provide; the disabled early
  // return above provided the reduced payload.
  ctx.provide('taskCoordinator', { config, version: '0.25.2', ops });
  const dispose = registerTools(ctx, ops, { defineTool }, config);
  const disposeCommands = registerCommands(ctx, ops, uiStrings(readUiLocale()));
  ctx.effect(() => () => {
    dispose();
    disposeCommands();
  }, 'task-coordinator.dispose');
  // Ship the supervisor playbook skill with the bundle. Fire-and-forget: the
  // mount degrades to a warning on failure and never breaks the tools above.
  void mountCoordinatorSkills(ctx);
}
