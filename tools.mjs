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
    description: 'List coordination-visible tasks (top-level sessions) with their stable session ids, run status, titles, todo and goal progress. Tasks spawned through task_spawn carry their team when one was given. Use this to discover a task before reading or messaging it.',
    parameters: {
      filter: { type: 'string', description: 'Optional case-insensitive substring matched against session id, title, and cwd.' },
      team: { type: 'string', description: 'Only list tasks spawned under this team (workstream). Requires the task to be recorded in the spawn registry.' },
      includeSubagents: { type: 'boolean', description: 'Also list subagent-origin sessions. Defaults to false.' },
      limit: { type: 'integer', description: 'Max rows to return, newest first. Defaults to 50.' },
    },
    output: OUTPUT,
    async execute(args, exec) {
      try {
        return await ops.listTasks(args, callerFrom(exec), exec?.signal);
      } catch (error) {
        return { ok: false, code: 'internal', error: error?.message ?? String(error) };
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
        return { ok: false, code: 'internal', error: error?.message ?? String(error) };
      }
    },
  })));

  disposers.push(ctx.tools.register(defineTool({
    name: 'task_send',
    description: 'Send a visible follow-up prompt to another task. Mode "queue" (default): starts a new round when the target is idle, otherwise queues at the next turn boundary. Mode "steer": mid-run course correction delivered at the next step boundary. The message appears in the target\'s transcript and is attributed to this coordinating session. Returns a messageId; delivery means accepted into the inbox, not yet consumed — verify with task_progress before resending.',
    parameters: {
      sessionId: { type: 'string', required: true, description: 'Target task session id.' },
      message: { type: 'string', required: true, description: 'Follow-up prompt text: corrections, new instructions, or handoff context.' },
      mode: { type: 'string', enum: ['queue', 'steer'], description: 'Delivery mode. queue = next turn (default); steer = next step of the running turn.' },
      reference: { type: 'string', description: 'Optional id of an earlier instruction (a messageId or correlationId returned by task_send/task_spawn) that this message corrects or continues; it is quoted visibly in the delivered message.' },
    },
    output: OUTPUT,
    async execute(args, exec) {
      try {
        return await ops.sendMessage({
          targetId: args.sessionId,
          text: args.message,
          mode: args.mode ?? 'queue',
          reference: args.reference,
        }, callerFrom(exec));
      } catch (error) {
        return { ok: false, code: 'internal', error: error?.message ?? String(error) };
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
      + 'This is how a supervisor session dispatches work: when the user asks to split work into sub-task sessions, '
      + 'run things in parallel across sessions, or coordinate multiple tasks (any wording, including "/task plugin" '
      + 'or "task-coordinator" references), use this tool family instead of doing everything in-session, and load the '
      + 'task-coordination skill for the orchestration playbook. '
      + 'The new task appears in the session list immediately. Returns the new session id for follow-up coordination. '
      + 'Optional provider+model select the child\'s LLM route (installed before the kickoff, so its first turn uses it; '
      + 'host semantics: this also updates the app-wide default model, like picking a model in the GUI). '
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
      team: { type: 'string', description: 'Optional team (workstream) name grouping related spawned tasks; recorded durably and usable as a task_list filter, so the group survives a host restart.' },
      reportBack: { type: 'boolean', description: 'Default true: append an instruction telling the new task to push its result summary back to your session via task_send when it finishes. Set false for fire-and-forget tasks you will only read with task_progress.' },
      sessionId: { type: 'string', description: 'Optional explicit session id; creation is idempotent for the same id and cwd.' },
      agentPreset: { type: 'string', description: 'Optional agent preset name for the new task.' },
      provider: { type: 'string', description: 'LLM provider route for the child session. Supply together with model; omit both to inherit the host default model.' },
      model: { type: 'string', description: 'Model id interpreted by provider. Supply together with provider; an invalid pair is rejected up front (model-unavailable) without creating the session.' },
      reasoningEffort: { type: 'string', description: 'Optional reasoning effort for the selected route; only meaningful together with provider+model.' },
    },
    output: OUTPUT,
    async execute(args, exec) {
      try {
        return await ops.spawnTask(args, callerFrom(exec), exec?.signal);
      } catch (error) {
        return { ok: false, code: 'internal', error: error?.message ?? String(error) };
      }
    },
  })));

  disposers.push(ctx.tools.register(defineTool({
    name: 'task_confirm',
    description: 'Present a decomposition/dispatch plan to the user as an interactive approval card and block until they answer. '
      + 'REQUIRED before task_spawn_batch when the batch reaches the confirmation threshold: pass the returned confirmationId to the batch call. '
      + 'On approval returns { approved: true, confirmationId }; when the user declines or edits, returns their feedback — fold it into a revised plan and confirm again. '
      + 'If the user closes the card (confirm-cancelled), stop dispatching and wait for their next message. '
      + 'Set reusable: true for a long mission (e.g. goal mode): confirm ONCE after the initial analysis, then every batch of the mission reuses the same confirmationId.',
    parameters: {
      plan: {
        type: 'string',
        required: true,
        description: 'The full dispatch plan in markdown: what gets split into how many task sessions, each task\'s scope and why it is independent. Must start with a # heading (the host plan-review convention). Rendered as the card body — this is what the user reviews.',
      },
      question: { type: 'string', description: 'Optional one-line question shown above the plan. Defaults to asking whether to approve the dispatch.' },
      reusable: { type: 'boolean', description: 'Mission-scoped approval: the confirmationId survives successful batches instead of being single-use. Use for autonomous multi-milestone runs; confirm once after the initial analysis.' },
    },
    output: OUTPUT,
    async execute(args, exec) {
      try {
        return await ops.confirmPlan({ plan: args.plan, question: args.question, reusable: args.reusable }, callerFrom(exec), exec?.agent, exec?.signal);
      } catch (error) {
        return { ok: false, code: 'internal', error: error?.message ?? String(error) };
      }
    },
  })));

  disposers.push(ctx.tools.register(defineTool({
    name: 'task_confirm_select',
    description: 'Present the proposed task list as a MULTI-SELECT card: the user checks WHICH of the proposed tasks to dispatch (partial dispatch) and can add adjustment feedback via the custom input row. Renders in the host\'s neutral question UI (not the amber plan-review card). '
      + 'Present the full plan in your chat message BEFORE calling this — the card only carries the task list. '
      + 'On approval returns { approved: true, selected: [...titles], confirmationId }; task_spawn_batch then accepts ONLY those exact titles (subset enforced). '
      + 'When the user selects nothing, returns their feedback — revise the list and confirm again. '
      + 'Set reusable: true for a long mission: the subset approval then covers later batches too (the subset check still applies to every batch).',
    parameters: {
      question: { type: 'string', description: 'Optional one-line question shown on the card. Defaults to asking which tasks to dispatch.' },
      tasks: {
        type: 'array',
        required: true,
        description: 'Proposed tasks as options: one entry per task.',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            title: { type: 'string', required: true, description: 'Task title — use EXACTLY the title you will give this task in task_spawn_batch (subset matching is exact).' },
            scope: { type: 'string', description: 'One-line scope shown under the title.' },
          },
        },
      },
      reusable: { type: 'boolean', description: 'Mission-scoped approval: the confirmationId survives successful batches instead of being single-use (subset enforcement still applies).' },
    },
    output: OUTPUT,
    async execute(args, exec) {
      try {
        return await ops.confirmSelect({ question: args.question, tasks: args.tasks, reusable: args.reusable }, callerFrom(exec), exec?.agent, exec?.signal);
      } catch (error) {
        return { ok: false, code: 'internal', error: error?.message ?? String(error) };
      }
    },
  })));

  disposers.push(ctx.tools.register(defineTool({
    name: 'task_spawn_batch',
    description: 'Execute a decomposition plan: create several task sessions in one call, all optionally under one team. '
      + 'The batch counterpart of task_spawn for parallel fan-out as a supervisor. '
      + 'Use after analyzing the work into independent pieces (no shared files, no producer/consumer dependency between them). '
      + 'Every item\'s prompt must be fully self-contained. One failed item does not abort the rest; the response lists per-item results. '
      + spawnTitleRule,
    parameters: {
      tasks: {
        type: 'array',
        required: true,
        description: 'The decomposition plan: one entry per new task session.',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            title: { type: 'string', description: 'Semantic title "type｜topic" (MMDD｜ stamped automatically).' },
            prompt: { type: 'string', required: true, description: 'Self-contained kickoff prompt for this task.' },
            cwd: { type: 'string', description: 'Working directory override for this task.' },
            provider: { type: 'string', description: 'LLM provider route for this child (with model; see task_spawn — installing also updates the app-wide default model).' },
            model: { type: 'string', description: 'Model id interpreted by provider (with provider).' },
            reasoningEffort: { type: 'string', description: 'Optional reasoning effort for this child\'s route.' },
          },
        },
      },
      team: { type: 'string', description: 'Team (workstream) name applied to every task in the batch.' },
      reportBack: { type: 'boolean', description: 'Default true: every task in the batch gets the instruction to push its result summary back to your session via task_send when it finishes.' },
      confirmationId: { type: 'string', description: 'confirmationId from an approved task_confirm for this plan. Required when the batch reaches the confirmation threshold (confirmation enabled); single-use.' },
    },
    output: OUTPUT,
    async execute(args, exec) {
      try {
        return await ops.spawnBatch(args, callerFrom(exec), exec?.signal);
      } catch (error) {
        return { ok: false, code: 'internal', error: error?.message ?? String(error) };
      }
    },
  })));

  disposers.push(ctx.tools.register(defineTool({
    name: 'task_wait',
    description: 'Wait until task(s) become idle (current round finishes) or the timeout expires. Pass one sessionId, or several sessionIds with mode "all" (settle when every target is idle; the fan-out default) or "any" (settle when the first target is idle). Use before reading final results or handing work over. A timeout means the tasks are still running — check task_progress before resending anything.',
    parameters: {
      sessionId: { type: 'string', description: 'Single target task session id. Use this or sessionIds.' },
      sessionIds: { type: 'array', items: { type: 'string' }, description: 'Several target task session ids to wait on together. Use this or sessionId.' },
      mode: { type: 'string', enum: ['all', 'any'], description: 'Multi-target settle mode. all = every target idle (default); any = first target idle.' },
      timeoutMs: { type: 'integer', description: 'Max milliseconds to wait. Defaults to the configured default and is capped.' },
    },
    output: OUTPUT,
    async execute(args, exec) {
      try {
        return await ops.waitFor({
          sessionId: args.sessionId,
          sessionIds: args.sessionIds,
          timeoutMs: args.timeoutMs,
          mode: args.mode ?? 'all',
          signal: exec?.signal,
        }, callerFrom(exec));
      } catch (error) {
        return { ok: false, code: 'internal', error: error?.message ?? String(error) };
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
        return { ok: false, code: 'internal', error: error?.message ?? String(error) };
      }
    },
  })));

  disposers.push(ctx.tools.register(defineTool({
    name: 'task_workspace',
    description: 'List host workspaces, move an EXISTING top-level session into/out of one (attach/detach), or MIGRATE it to a DIFFERENT workspace (migrate). '
      + 'Use it to fix sessions that landed in the ungrouped bucket — e.g. spawned with an explicit cwd before 0.12.0. '
      + 'Attach goes through the host workspace entity (the same API session.create uses): the session\'s stored cwd must match the workspace path, and the session\'s conversation is never touched. '
      + 'Migrate crosses workspaces whose path differs from the session\'s cwd — the one thing attach can never do: it clones the full history into a NEW session born with the target cwd, attaches the clone and archives the original, then returns the new session id (message that id from now on). It refuses running sessions (settle them with task_wait first). '
      + 'New spawns rarely need attach — task_spawn upgrades an exact cwd match to a workspace attachment automatically; spawn with the target workspace\'s cwd when the task belongs elsewhere.',
    parameters: {
      action: { type: 'string', description: 'list | attach | detach | migrate. Defaults to list.' },
      sessionId: { type: 'string', description: 'Session to attach/detach/migrate (required for those actions). For migrate this is the SOURCE session; the result reports the new id.' },
      workspaceId: { type: 'string', description: 'Target workspace id (see action list). Preferred over workspacePath.' },
      workspacePath: { type: 'string', description: 'Workspace directory path, matched exactly (case- and separator-insensitive) when workspaceId is omitted.' },
    },
    output: OUTPUT,
    async execute(args, exec) {
      try {
        return await ops.workspaceOp(args, callerFrom(exec));
      } catch (error) {
        return { ok: false, code: 'internal', error: error?.message ?? String(error) };
      }
    },
  })));

  disposers.push(ctx.tools.register(defineTool({
    name: 'task_models',
    description: 'List the EXACT model routes available in THIS deployment — providers, model ids, and reasoning efforts — from the host\'s live model catalog (the same source the GUI model picker renders). '
      + 'Every user connects different providers/models, so never guess ids: consult this before task_spawn / task_spawn_batch with provider+model. Read-only, needs no session.',
    parameters: {},
    output: OUTPUT,
    async execute(args, exec) {
      try {
        return await ops.models(args, callerFrom(exec));
      } catch (error) {
        return { ok: false, code: 'internal', error: error?.message ?? String(error) };
      }
    },
  })));

  ctx.logger?.info(`task-coordinator: registered 11 coordination tools (subagent use ${config.allowSubagentUse ? 'allowed' : 'denied'})`);
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
