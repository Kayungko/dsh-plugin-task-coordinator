/**
 * Spawn-title rules for dsh-plugin-task-coordinator.
 *
 * Final title format:  MMDD｜类型｜主题   (separator: fullwidth ｜ U+FF5C)
 *
 * Division of labor:
 *  - the supervisor model supplies the semantic part: 类型｜主题 (or raw topic);
 *  - this module supplies the mechanical part: the MMDD date prefix is always
 *    stamped from the session creation time in Asia/Shanghai (never updatedAt),
 *    separators are normalized, the topic is truncated for sidebar display.
 *
 * Pure module: no harness imports, fully unit-testable.
 */

export const DEFAULT_TITLE_TYPES = Object.freeze([
  '功能', '设计', '修复', '优化', '发布', '探索', '文档', '研究',
]);

export const TITLE_SEPARATOR = '｜';
const HALF_SEPARATOR = /\|/g;
const LEADING_BRACKET_PREFIX = /^\[[^\]]*\]\s*/;

/**
 * English spelling variants of the default Chinese type vocabulary.
 * Normalization runs BEFORE the membership check, so a custom
 * `titleTypes` set stays authoritative: an alias only resolves when its
 * canonical type is actually allowed.
 */
export const TYPE_ALIASES = Object.freeze({
  fix: '修复', bugfix: '修复',
  feature: '功能', feat: '功能',
  design: '设计',
  optimize: '优化', optimise: '优化', perf: '优化', refactor: '优化',
  release: '发布', publish: '发布',
  explore: '探索', exploration: '探索',
  doc: '文档', docs: '文档', documentation: '文档',
  research: '研究', investigate: '研究',
});

/**
 * Resolve one raw title segment to an allowed type: exact match first,
 * then case-insensitive English alias whose canonical form is allowed.
 * @param {string} part raw segment (already separator-split)
 * @param {string[]} types allowed canonical types
 * @returns {string | null} canonical type, or null when not a type
 */
export function resolveTitleType(part, types) {
  if (typeof part !== 'string' || !Array.isArray(types)) return null;
  const trimmed = part.trim();
  if (trimmed.length === 0) return null;
  if (types.includes(trimmed)) return trimmed;
  const lower = trimmed.toLowerCase();
  const aliased = Object.hasOwn(TYPE_ALIASES, lower) ? TYPE_ALIASES[lower] : null;
  if (aliased !== null && types.includes(aliased)) return aliased;
  // custom sets: values also match their own members case-insensitively
  return types.find((value) => typeof value === 'string' && value.toLowerCase() === lower) ?? null;
}

/**
 * Format MMDD from a creation timestamp in one IANA time zone.
 * @param {number} createdAtMs epoch milliseconds
 * @param {string} timeZone e.g. 'Asia/Shanghai'
 * @returns {string} 4-digit MMDD
 */
export function mmdd(createdAtMs, timeZone = 'Asia/Shanghai') {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(createdAtMs));
  const month = parts.find((part) => part.type === 'month')?.value ?? '01';
  const day = parts.find((part) => part.type === 'day')?.value ?? '01';
  return `${month}${day}`;
}

/** First non-empty line of a prompt, trimmed. */
export function firstLine(text) {
  if (typeof text !== 'string') return '';
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length > 0) return trimmed;
  }
  return '';
}

/** Collapse whitespace and truncate one topic for sidebar display. */
export function truncateTopic(topic, maxChars) {
  const collapsed = String(topic ?? '').replace(/\s+/g, ' ').trim();
  if (collapsed.length <= maxChars) return collapsed;
  return collapsed.slice(0, maxChars);
}

/**
 * Build the final spawn title.
 *
 * Accepted `title` shapes (separator variants ｜ / | both fine):
 *   "类型｜主题"          -> date is stamped, type kept
 *   "fix｜topic"          -> English alias normalized to its canonical type
 *   "MMDD｜类型｜主题"     -> stale date is re-stamped from createdAt
 *   "主题" (unknown type)  -> fallback type is used (never guessed)
 * Missing/blank title      -> topic derived from the kickoff prompt's first line.
 *
 * @param {{ title?: string; prompt?: string }} input
 * @param {object} config resolved plugin config
 * @param {number} createdAtMs session creation timestamp
 * @returns {string} formatted title
 */
export function buildSpawnTitle({ title, prompt } = {}, config = {}, createdAtMs = Date.now()) {
  const types = Array.isArray(config.titleTypes) && config.titleTypes.length > 0
    ? config.titleTypes
    : DEFAULT_TITLE_TYPES;
  const fallbackType = typeof config.titleFallbackType === 'string' && config.titleFallbackType.length > 0
    ? config.titleFallbackType
    : '探索';
  const fallbackTopic = typeof config.titleFallbackTopic === 'string' && config.titleFallbackTopic.trim().length > 0
    ? config.titleFallbackTopic.trim()
    : '新任务';
  const maxTopic = Number.isFinite(config.titleMaxTopicChars) && config.titleMaxTopicChars > 0
    ? config.titleMaxTopicChars
    : 16;
  const timeZone = typeof config.titleTimeZone === 'string' && config.titleTimeZone.length > 0
    ? config.titleTimeZone
    : 'Asia/Shanghai';

  let raw = typeof title === 'string' && title.trim().length > 0 ? title.trim() : firstLine(prompt);
  raw = raw.replace(HALF_SEPARATOR, TITLE_SEPARATOR).replace(LEADING_BRACKET_PREFIX, '').trim();

  const parts = raw.split(TITLE_SEPARATOR).map((part) => part.trim()).filter((part) => part.length > 0);
  let type = fallbackType;
  let topic;
  const datedType = parts.length >= 3 && /^\d{4}$/.test(parts[0]) ? resolveTitleType(parts[1], types) : null;
  const plainType = parts.length >= 2 ? resolveTitleType(parts[0], types) : null;
  if (datedType) {
    // "MMDD｜类型｜主题" — keep type/topic, re-stamp the date below
    type = datedType;
    topic = parts.slice(2).join(TITLE_SEPARATOR);
  } else if (plainType) {
    // "类型｜主题" (canonical or English alias)
    type = plainType;
    topic = parts.slice(1).join(TITLE_SEPARATOR);
  } else {
    // bare topic: never guess a type
    topic = parts.join(TITLE_SEPARATOR);
  }

  topic = truncateTopic(topic, maxTopic);
  if (topic.length === 0) topic = fallbackTopic;
  return `${mmdd(createdAtMs, timeZone)}${TITLE_SEPARATOR}${type}${TITLE_SEPARATOR}${topic}`;
}
