/**
 * Model-facing tool registration for dsh-plugin-task-coordinator.
 *
 * registerTools(ctx, ops, deps) wires six coordination tools. `defineTool`
 * is injected so the module stays testable without the host package.
 *
 * Caller identity is always derived from `exec.agent` (the calling agent);
 * every operation re-validates it through the safety guards.
 */

const OUTPUT = {
  schema: { type: 'json' },
  render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
};

function callerFrom(exec) {
  const agent = exec?.agent;
  if (!agent) return { sessionId: '' };
  return {
    sessionId: agent.id ?? agent.session?.id ?? '',
    origin: agent.session?.header?.origin,
    cwd: agent.session?.header?.cwd,
  };
}

/**
 * @param {object} ctx cordis context (uses ctx.tools)
 * @param {ReturnType<import('./ops.mjs').createOps>} ops
 * @param {{ defineTool: Function }} deps injected tool DSL
 * @param {object} config resolved plugin config
 * @returns {() => void} disposer for all registrations
 */
export function registerTools(ctx, ops, deps, config) {
  const { defineTool } = deps;
  const disposers = [];

  disposers.push(ctx.tools.register(defineTool({
    name: 'task_list',
    description: 'List coordination-visible tasks (top-level sessions) with their stable session ids, run status, titles, todo and goal progress. Use this to discover a task before reading or messaging it.',
    parameters: {
      filter: { type: 'string', description: 'Optional case-insensitive substring matched against session id, title, and cwd.' },
      includeSubagents: { type: 'boolean', description: 'Also list subagent-origin sessions. Defaults to false.' },
      limit: { type: 'integer', description: 'Max rows to return, newest first. Defaults to 50.' },
    },
    output: OUTPUT,
    async execute(args, exec) {
      try {
        return await ops.listTasks(args, callerFrom(exec), exec?.signal);
      } catch (error) {
        return { ok: false, error: error?.message ?? String(error) };
      }
    },
  })));

  disposers.push(ctx.tools.register(defineTool({
    name: 'task_progress',
    description: 'Read one task\'s current progress without disturbing it: live/cold status, queued messages, recent conversation tail, todos and goal. Read-only.',
    parameters: {
      sessionId: { type: 'string', required: true, description: 'Target task session id (from task_list).' },
    },
    output: OUTPUT,
    async execute(args, exec) {
      try {
        return await ops.progress(args.sessionId, callerFrom(exec), exec?.signal);
      } catch (error) {
        return { ok: false, error: error?.message ?? String(error) };
      }
    },
  })));

  disposers.push(ctx.tools.register(defineTool({
    name: 'task_send',
    description: 'Send a visible follow-up prompt to another task. Mode "queue" (default): starts a new round when the target is idle, otherwise queues at the next turn boundary. Mode "steer": mid-run course correction delivered at the next step boundary. The message appears in the target\'s transcript and is attributed to this coordinating session.',
    parameters: {
      sessionId: { type: 'string', required: true, description: 'Target task session id.' },
      message: { type: 'string', required: true, description: 'Follow-up prompt text: corrections, new instructions, or handoff context.' },
      mode: { type: 'string', enum: ['queue', 'steer'], description: 'Delivery mode. queue = next turn (default); steer = next step of the running turn.' },
    },
    output: OUTPUT,
    async execute(args, exec) {
      try {
        return await ops.sendMessage({
          targetId: args.sessionId,
          text: args.message,
          mode: args.mode ?? 'queue',
        }, callerFrom(exec));
      } catch (error) {
        return { ok: false, error: error?.message ?? String(error) };
      }
    },
  })));

  const titleTypes = Array.isArray(config.titleTypes) && config.titleTypes.length > 0
    ? config.titleTypes.join('、')
    : '功能、设计、修复、优化、发布、探索、文档、研究';
  const fallbackType = config.titleFallbackType || '探索';
  const spawnTitleRule = `Session titles follow the rule "MMDD｜type｜topic". `
    + `The caller only supplies the semantic part in the \`title\` argument as "type｜topic" `
    + `(e.g. "修复｜对账精度"); the plugin auto-stamps the MMDD date prefix from the session `
    + `creation time (Asia/Shanghai). Allowed types: ${titleTypes}. `
    + `Keep the topic short (<=16 chars), concrete, and do not repeat the project name. `
    + `If the type is unclear, supply just the topic and the plugin uses "${fallbackType}". `
    + `If no title is given, the topic is derived from the kickoff prompt's first line.`;

  disposers.push(ctx.tools.register(defineTool({
    name: 'task_spawn',
    description: 'Create a brand-new task session, name it, and start it with a kickoff prompt. '
      + 'The new task appears in the session list immediately. Returns the new session id for follow-up coordination. '
      + spawnTitleRule,
    parameters: {
      prompt: { type: 'string', required: true, description: 'Kickoff prompt: the full initial instruction for the new task.' },
      title: {
        type: 'string',
        description: 'Semantic title in the form "type｜topic" (e.g. "功能｜导出报表"). '
          + `Allowed types: ${titleTypes}. The MMDD｜ date prefix is added automatically; do not write the date yourself. `
          + 'Keep the topic short and concrete. If unsure of the type, pass only the topic.',
      },
      cwd: { type: 'string', description: 'Working directory for the new task. Defaults to the caller\'s working directory.' },
      sessionId: { type: 'string', description: 'Optional explicit session id; creation is idempotent for the same id and cwd.' },
      agentPreset: { type: 'string', description: 'Optional agent preset name for the new task.' },
    },
    output: OUTPUT,
    async execute(args, exec) {
      try {
        return await ops.spawnTask(args, callerFrom(exec), exec?.signal);
      } catch (error) {
        return { ok: false, error: error?.message ?? String(error) };
      }
    },
  })));

  disposers.push(ctx.tools.register(defineTool({
    name: 'task_wait',
    description: 'Wait until one task becomes idle (its current round finishes) or the timeout expires. Use before reading a final result or handing work over. Returns the settled state and waited time.',
    parameters: {
      sessionId: { type: 'string', required: true, description: 'Target task session id.' },
      timeoutMs: { type: 'integer', description: 'Max milliseconds to wait. Defaults to the configured default and is capped.' },
    },
    output: OUTPUT,
    async execute(args, exec) {
      try {
        return await ops.waitFor(args.sessionId, { timeoutMs: args.timeoutMs, signal: exec?.signal }, callerFrom(exec));
      } catch (error) {
        return { ok: false, error: error?.message ?? String(error) };
      }
    },
  })));

  disposers.push(ctx.tools.register(defineTool({
    name: 'task_cancel',
    description: 'Cancel one task\'s active turn without dropping its queued messages. Use only when a task must stop before its next boundary; queued follow-ups stay pending.',
    parameters: {
      sessionId: { type: 'string', required: true, description: 'Target task session id.' },
    },
    output: OUTPUT,
    async execute(args, exec) {
      try {
        return await ops.cancelTask(args.sessionId, callerFrom(exec));
      } catch (error) {
        return { ok: false, error: error?.message ?? String(error) };
      }
    },
  })));

  ctx.logger?.info(`task-coordinator: registered 6 coordination tools (subagent use ${config.allowSubagentUse ? 'allowed' : 'denied'})`);
  return () => {
    for (const dispose of disposers.splice(0)) {
      try {
        dispose?.();
      } catch {
        /* registration cleanup must never throw */
      }
    }
  };
}
