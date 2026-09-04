/**
 * Safety guards for dsh-plugin-task-coordinator.
 * Pure module: no harness imports, fully unit-testable.
 *
 * Guards implemented:
 *  - self-addressing is always rejected (a task must not message itself);
 *  - only top-level sessions (origin !== 'subagent') may be coordination targets;
 *  - caller origin gate: subagent sessions are refused unless explicitly allowed;
 *  - per-target rate limiting and queue-depth limiting against runaway spam.
 */

/** @typedef {{ sessionId: string; origin?: string }} TaskRef */
/** @typedef {{ code: string; message: string }} GuardDenial */

/** Stable machine-readable denial codes (absorbed from SCDP's typed errors). */
export const DENIAL_CODES = Object.freeze({
  CALLER_UNKNOWN: 'caller-unknown',
  SUBAGENT_CALLER_DENIED: 'subagent-caller-denied',
  TARGET_NOT_FOUND: 'target-not-found',
  TARGET_INVALID: 'target-invalid',
  SELF_SEND_DENIED: 'self-send-denied',
  SUBAGENT_TARGET_DENIED: 'subagent-target-denied',
  RATE_LIMITED: 'rate-limited',
  QUEUE_FULL: 'queue-full',
});

/**
 * Validate the calling agent is allowed to coordinate at all.
 * @param {{ sessionId: string; origin?: string }} caller
 * @param {{ allowSubagentUse: boolean }} config
 * @returns {GuardDenial | null} denial with a stable code, or null when allowed
 */
export function checkCaller(caller, config) {
  if (!caller || typeof caller.sessionId !== 'string' || caller.sessionId.length === 0) {
    return { code: DENIAL_CODES.CALLER_UNKNOWN, message: 'caller identity unavailable (no agent context)' };
  }
  if (!config.allowSubagentUse && caller.origin === 'subagent') {
    return { code: DENIAL_CODES.SUBAGENT_CALLER_DENIED, message: 'subagent sessions are not allowed to use task coordination (config: allowSubagentUse)' };
  }
  return null;
}

/**
 * Validate one coordination target for the given caller.
 * @param {TaskRef} caller
 * @param {TaskRef | undefined} target resolved target summary; undefined = not found
 * @returns {GuardDenial | null} denial with a stable code, or null when allowed
 */
export function checkTarget(caller, target) {
  if (target === undefined) return { code: DENIAL_CODES.TARGET_NOT_FOUND, message: 'target session not found' };
  if (typeof target.sessionId !== 'string' || target.sessionId.length === 0) {
    return { code: DENIAL_CODES.TARGET_INVALID, message: 'target session has no id' };
  }
  if (target.sessionId === caller.sessionId) {
    return { code: DENIAL_CODES.SELF_SEND_DENIED, message: 'refusing to send a message to the calling session itself' };
  }
  if (target.origin === 'subagent') {
    return { code: DENIAL_CODES.SUBAGENT_TARGET_DENIED, message: 'target is a subagent-owned session; coordinate with top-level tasks only' };
  }
  return null;
}

/**
 * In-memory per-target limiter. One instance lives inside the plugin runtime;
 * it is intentionally process-local (host restart resets it).
 */
export class SendLimiter {
  /**
   * @param {{ maxQueuePerTask: number; minSendIntervalMs: number }} config
   * @param {(targetId: string) => number} pendingCount live inbox depth probe
   * @param {() => number} now clock, injectable for tests
   */
  constructor(config, pendingCount, now = () => Date.now()) {
    this.config = config;
    this.pendingCount = pendingCount;
    this.now = now;
    /** @type {Map<string, number>} targetId -> last accepted send timestamp */
    this.lastSentAt = new Map();
  }

  /**
   * @param {string} targetId
   * @returns {GuardDenial | null} denial with a stable code, or null when the send may proceed
   */
  check(targetId) {
    const currentTime = this.now();
    const last = this.lastSentAt.get(targetId);
    if (last !== undefined && currentTime - last < this.config.minSendIntervalMs) {
      const waitMs = this.config.minSendIntervalMs - (currentTime - last);
      return {
        code: DENIAL_CODES.RATE_LIMITED,
        message: `rate limited: wait ~${Math.ceil(waitMs / 100) / 10}s before messaging this task again`,
      };
    }
    let depth;
    try {
      depth = this.pendingCount(targetId);
    } catch {
      return null; // probe failure must never block a send
    }
    if (Number.isFinite(depth) && depth >= this.config.maxQueuePerTask) {
      return {
        code: DENIAL_CODES.QUEUE_FULL,
        message: `target already has ${depth} pending message(s) (max ${this.config.maxQueuePerTask}); wait for it to consume them`,
      };
    }
    return null;
  }

  /** Record an accepted send for rate limiting. */
  accept(targetId) {
    this.lastSentAt.set(targetId, this.now());
  }

  /** Forget a target (e.g. on session removal). */
  forget(targetId) {
    this.lastSentAt.delete(targetId);
  }
}

/**
 * Truncate one text excerpt safely.
 * @param {string} text
 * @param {number} maxChars
 */
export function excerpt(text, maxChars) {
  if (typeof text !== 'string') return '';
  const trimmed = text.trim();
  if (trimmed.length <= maxChars) return trimmed;
  return `${trimmed.slice(0, maxChars)}… (+${trimmed.length - maxChars} chars)`;
}

/**
 * Extract plain text from a ContentBlock array.
 * @param {readonly unknown[]} blocks
 */
export function blocksToText(blocks) {
  if (!Array.isArray(blocks)) return '';
  const parts = [];
  for (const block of blocks) {
    if (block && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') {
      parts.push(block.text);
    } else if (block && typeof block === 'object' && block.type === 'tool-call') {
      parts.push(`[tool-call: ${block.name ?? 'unknown'}]`);
    } else if (block && typeof block === 'object' && block.type === 'image') {
      parts.push('[image]');
    }
  }
  return parts.join('\n');
}
