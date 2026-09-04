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
 */

import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { resolveConfig } from './config.mjs';
import { SendLimiter } from './safety.mjs';
import { createOps } from './ops.mjs';
import { registerTools } from './tools.mjs';
import { registerCommands } from './commands.mjs';
import { mountCoordinatorSkills } from './skills.mjs';
import { SpawnRegistry } from './registry.mjs';

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
  ctx.provide('taskCoordinator', { config, version: '0.8.4' });
  if (!config.enabled) {
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
  const limiter = new SendLimiter(config, (targetId) => {
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
  });
  const dispose = registerTools(ctx, ops, { defineTool }, config);
  const disposeCommands = registerCommands(ctx, ops);
  ctx.effect(() => () => {
    dispose();
    disposeCommands();
  }, 'task-coordinator.dispose');
  // Ship the supervisor playbook skill with the bundle. Fire-and-forget: the
  // mount degrades to a warning on failure and never breaks the tools above.
  void mountCoordinatorSkills(ctx);
}
