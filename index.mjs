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
import { defineTool } from '@deepseek-ai/dsh-tools';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { resolveConfig } from './config.mjs';
import { SendLimiter } from './safety.mjs';
import { createOps } from './ops.mjs';
import { registerTools } from './tools.mjs';
import { mountCoordinatorSkills } from './skills.mjs';

export const name = 'task-coordinator';
export const inject = ['agents', 'tools', 'sessionController'];

export function apply(ctx, input = {}) {
  const config = resolveConfig(input);
  ctx.provide('taskCoordinator', { config, version: '0.1.0' });
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
  const ops = createOps({
    sessionController,
    agents,
    createUserMessage,
    config,
    limiter,
    uuid: () => `task-coord-${randomUUID()}`,
  });
  const dispose = registerTools(ctx, ops, { defineTool }, config);
  ctx.effect(() => () => dispose(), 'task-coordinator.dispose');
  // Ship the supervisor playbook skill with the bundle. Fire-and-forget: the
  // mount degrades to a warning on failure and never breaks the tools above.
  void mountCoordinatorSkills(ctx);
}
