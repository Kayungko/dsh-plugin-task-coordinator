/**
 * Configuration resolution for dsh-plugin-task-coordinator.
 * Pure module: no harness imports, fully unit-testable.
 */

import { DEFAULT_TITLE_TYPES } from './title.mjs';

export const DEFAULTS = Object.freeze({
  /** Master switch. When false the plugin mounts no tools at all. */
  enabled: true,
  /** Allow agents whose session origin is 'subagent' to use coordination tools. */
  allowSubagentUse: false,
  /** task_list hides subagent-origin sessions unless asked explicitly. */
  includeSubagentsInList: false,
  /**
   * Spawn-title rule (format: MMDD｜类型｜主题).
   * The date prefix is always stamped from the session creation time in
   * `titleTimeZone` — the model only supplies 类型｜主题.
   */
  /** Allowed 类型 values; anything else falls back to `titleFallbackType`. */
  titleTypes: DEFAULT_TITLE_TYPES,
  /** 类型 used when the caller's type is missing or not in `titleTypes`. */
  titleFallbackType: '探索',
  /** Max characters kept for 主题 (sidebar-friendly truncation). */
  titleMaxTopicChars: 16,
  /** IANA time zone for the MMDD date prefix. */
  titleTimeZone: 'Asia/Shanghai',
  /** Max pending inbox messages a single target may hold before task_send refuses. */
  maxQueuePerTask: 5,
  /** Minimum interval between task_send/task_spawn kickoffs toward one target. */
  minSendIntervalMs: 2000,
  /** Default timeout for task_wait. */
  waitDefaultTimeoutMs: 120000,
  /** Hard cap for task_wait timeout arguments. */
  waitMaxTimeoutMs: 600000,
  /** Max characters kept per message excerpt in progress reports. */
  excerptChars: 400,
  /** Max messages included in progress reports. */
  progressTailMessages: 6,
});

/**
 * Merge user config over defaults, rejecting wrong types instead of guessing.
 * @param {unknown} input raw plugin config (usually an object from cordis.yml)
 * @returns {typeof DEFAULTS & Record<string, unknown>}
 */
export function resolveConfig(input = {}) {
  const source = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const config = { ...DEFAULTS };
  const booleans = ['enabled', 'allowSubagentUse', 'includeSubagentsInList'];
  const numbers = [
    'maxQueuePerTask',
    'minSendIntervalMs',
    'waitDefaultTimeoutMs',
    'waitMaxTimeoutMs',
    'excerptChars',
    'progressTailMessages',
    'titleMaxTopicChars',
  ];
  const strings = ['titleFallbackType', 'titleTimeZone'];
  for (const key of booleans) {
    if (source[key] !== undefined) {
      if (typeof source[key] !== 'boolean') throw new TypeError(`task-coordinator config "${key}" must be boolean`);
      config[key] = source[key];
    }
  }
  for (const key of numbers) {
    if (source[key] !== undefined) {
      const value = source[key];
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
        throw new TypeError(`task-coordinator config "${key}" must be a finite non-negative number`);
      }
      config[key] = value;
    }
  }
  for (const key of strings) {
    if (source[key] !== undefined) {
      if (typeof source[key] !== 'string') throw new TypeError(`task-coordinator config "${key}" must be string`);
      config[key] = source[key];
    }
  }
  if (source.titleTypes !== undefined) {
    if (!Array.isArray(source.titleTypes) || source.titleTypes.length === 0
      || source.titleTypes.some((value) => typeof value !== 'string' || value.trim().length === 0)) {
      throw new TypeError('task-coordinator config "titleTypes" must be a non-empty array of non-empty strings');
    }
    config.titleTypes = source.titleTypes.map((value) => value.trim());
  }
  if (config.maxQueuePerTask < 1) config.maxQueuePerTask = 1;
  if (config.titleMaxTopicChars < 1) config.titleMaxTopicChars = 1;
  if (config.waitMaxTimeoutMs < config.waitDefaultTimeoutMs) {
    config.waitDefaultTimeoutMs = config.waitMaxTimeoutMs;
  }
  return config;
}
