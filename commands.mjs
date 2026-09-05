/**
 * Slash-command surface for dsh-plugin-task-coordinator.
 *
 * Registers `/tasks` through the host's dsh-commands registry (same pattern
 * as the official dsh-command-goal / dsh-command-feedback bundles). Commands
 * execute DIRECTLY — no model turn, no tokens — which makes them the right
 * surface for deterministic read-only coordination queries, while semantic
 * work (deciding what to spawn, how to steer) stays with the model + skill.
 *
 * Grammar:
 *   /tasks                -> list coordination-visible tasks (newest first)
 *   /tasks team <name>    -> list one workstream's members
 *   /tasks <sessionId>    -> progress summary of one task (short id prefix ok)
 */

import { uiStrings } from './i18n.mjs';

export const TASKS_USAGE = 'Usage: /tasks [team <name> | <sessionId>]';

/**
 * Parse only the grammar owned by `/tasks`; anything else is a session id.
 * @param {string} rawInput text after the command name
 * @returns {{ kind: 'list' } | { kind: 'team'; team: string } | { kind: 'inspect'; target: string } | { kind: 'invalid' }}
 */
export function parseTasksCommand(rawInput) {
  const input = String(rawInput ?? '').trim();
  if (input.length === 0) return { kind: 'list' };
  if (/^team(?=\s|$)/iu.test(input)) {
    const team = input.slice(4).trim();
    if (team.length === 0) return { kind: 'invalid' };
    return { kind: 'team', team };
  }
  return { kind: 'inspect', target: input };
}

/** Derive caller identity from a command invocation's receiving agent. */
export function callerFromInvocation(invocation) {
  const agent = invocation?.agent;
  return {
    sessionId: agent?.id ?? agent?.session?.id ?? '',
    origin: agent?.session?.header?.origin,
    cwd: agent?.session?.header?.cwd,
  };
}

const STATE_MARK = { running: '●', idle: '○', blank: '◌' };

function taskLine(task) {
  const mark = STATE_MARK[task.status] ?? '?';
  const bits = [
    `  ${mark} ${task.sessionId}`,
    task.status,
    task.title ?? '(untitled)',
  ];
  if (task.team !== undefined) bits.push(`team=${task.team}`);
  if (task.todos) bits.push(`todos ${task.todos}`);
  return bits.join('  ');
}

/** Render one ops.listTasks result as command text. */
export function renderTaskList(result, { team } = {}) {
  if (!result?.ok) {
    return { kind: 'error', text: `/tasks: ${result?.code ?? 'internal'}: ${result?.error ?? 'unknown failure'}` };
  }
  const header = team === undefined
    ? `Coordination-visible tasks (${result.count}${result.truncated ? '+, truncated' : ''}, newest first)`
    : `Team “${team}” (${result.count} member${result.count === 1 ? '' : 's'})`;
  const lines = [header];
  if (result.tasks.length === 0) lines.push('  (none)');
  for (const task of result.tasks) lines.push(taskLine(task));
  lines.push('');
  lines.push('Legend: ● running  ○ idle  ◌ blank — direct query, no model turn.');
  lines.push('Actions (send/spawn/wait/cancel) go through the task_* tools.');
  return { kind: 'success', text: lines.join('\n') };
}

/** Render one ops.progress result as command text. */
export function renderProgress(result) {
  if (!result?.ok) {
    return { kind: 'error', text: `/tasks: ${result?.code ?? 'internal'}: ${result?.error ?? 'unknown failure'}` };
  }
  const lines = [
    `${result.title ?? '(untitled)'}  [${result.agentState}]`,
    `sessionId: ${result.sessionId}`,
  ];
  if (result.team !== undefined) lines.push(`team: ${result.team}`);
  if (result.cwd) lines.push(`cwd: ${result.cwd}`);
  const todos = Array.isArray(result.todos) ? result.todos : null;
  if (todos) {
    const done = todos.filter((todo) => todo.status === 'completed').length;
    lines.push(`todos: ${done}/${todos.length} done`);
    for (const todo of todos.filter((todo) => todo.status !== 'completed').slice(0, 5)) {
      lines.push(`  - [${todo.status}] ${String(todo.content ?? '').slice(0, 80)}`);
    }
  }
  if (result.goal?.goal?.objective) lines.push(`goal: ${String(result.goal.goal.objective).slice(0, 120)}`);
  if (Array.isArray(result.queue) && result.queue.length > 0) {
    lines.push(`queued messages: ${result.queue.length}`);
    for (const entry of result.queue) lines.push(`  - (${entry.placement}) ${entry.text}`);
  }
  const recent = Array.isArray(result.recent) ? result.recent : [];
  if (recent.length > 0) {
    lines.push('recent:');
    for (const entry of recent.slice(-3)) lines.push(`  ${entry.role}: ${entry.text}`);
  }
  return { kind: 'success', text: lines.join('\n') };
}

/**
 * Register the `/tasks` command. Degrades to a no-op when the host has no
 * commands registry (never breaks the tools).
 * @param {object} ctx cordis context (uses ctx.commands)
 * @param {ReturnType<import('./ops.mjs').createOps>} ops
 * @param {ReturnType<import('./i18n.mjs').uiStrings>} [strings] UI-string
 *   dictionary for the command metadata (0.15.0; captured at mount — the
 *   description follows the locale preference read when the plugin loads)
 * @returns {() => void} disposer
 */
export function registerCommands(ctx, ops, strings = uiStrings('zh')) {
  if (!ctx.commands || typeof ctx.commands.register !== 'function') {
    ctx.logger?.warn?.('task-coordinator: ctx.commands unavailable; /tasks not registered');
    return () => {};
  }
  const dispose = ctx.commands.register({
    name: 'tasks',
    description: strings.tasksCommandDescription,
    input: { hint: strings.tasksCommandHint },
    async handler(invocation) {
      const caller = callerFromInvocation(invocation);
      const parsed = parseTasksCommand(invocation?.rawInput);
      try {
        if (parsed.kind === 'invalid') return { kind: 'error', text: TASKS_USAGE };
        if (parsed.kind === 'list') {
          return renderTaskList(await ops.listTasks({}, caller, invocation?.signal));
        }
        if (parsed.kind === 'team') {
          return renderTaskList(await ops.listTasks({ team: parsed.team }, caller, invocation?.signal), { team: parsed.team });
        }
        // inspect: exact id first, then short-id prefix resolution
        let target = parsed.target;
        let progress = await ops.progress(target, caller, invocation?.signal);
        if (!progress.ok && progress.code === 'target-not-found' && !target.startsWith('session-')) {
          const listing = await ops.listTasks({ includeSubagents: true, limit: 200 }, caller, invocation?.signal);
          const matches = (listing.tasks ?? []).filter((task) =>
            task.sessionId.replace(/^session-/, '').startsWith(target.toLowerCase()));
          if (matches.length === 1) {
            target = matches[0].sessionId;
            progress = await ops.progress(target, caller, invocation?.signal);
          } else if (matches.length > 1) {
            return { kind: 'error', text: `/tasks: ambiguous id "${parsed.target}" matches ${matches.map((task) => task.sessionId).join(', ')}` };
          }
        }
        if (!progress.ok && progress.code === 'target-not-found') {
          return { kind: 'error', text: `/tasks: session not found: ${parsed.target}. Run /tasks to list visible tasks.` };
        }
        return renderProgress(progress);
      } catch (error) {
        return { kind: 'error', text: `/tasks failed: ${error?.message ?? error}` };
      }
    },
  });
  ctx.logger?.info?.('task-coordinator: registered /tasks slash command');
  return () => {
    try {
      dispose?.();
    } catch {
      /* command cleanup must never throw */
    }
  };
}
