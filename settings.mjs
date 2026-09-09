/**
 * Spawn-model defaults as a durable host settings section (0.18.0).
 *
 * The section's value is three flat strings; an empty provider+model pair
 * means "no plugin default — spawned tasks keep the host default model".
 * This module is pure (no harness imports) so every rule is unit-testable:
 *
 *  - {@link normalizeSpawnRoute} is the single source of truth for "what
 *    route, if any, does a stored section yield" — the spawn path calls it
 *    defensively (never throws into a spawn) and the settings validate hook
 *    calls it strictly (malformed writes are rejected at the boundary).
 *  - {@link buildSpawnModelsSchema} mirrors the same shape for the host
 *    settings service (@deepseek-ai/schemastery), following the
 *    subagent-model-selection precedent: the plugin owns the namespace's
 *    base entry, the user layer (settings.yaml / GUI writes) composes over
 *    it, and scope.get() resolves the two.
 */

/** Durable settings namespace owned by this plugin (lowercase-hyphenated, host rule). */
export const SPAWN_MODELS_NS = 'task-coordinator';

/**
 * Hard ceiling for the GUI-editable per-target send-queue cap (0.23.0).
 * The limiter consumes ~1 queued message per target round, so depths beyond
 * this are never useful orchestration — they are spam. Values above the cap
 * clamp down (consumption side); the GUI input enforces the same range.
 */
export const MAX_QUEUE_PER_TASK_CAP = 50;

/**
 * Base (fallback) section entry: no default route — spawned tasks without an
 * explicit provider+model keep the host default model, exactly the pre-0.18
 * behavior. maxQueuePerTask 0 = "not set — follow the patch config" (the
 * config.mjs default is 5).
 */
export const SPAWN_MODELS_BASE = Object.freeze({ provider: '', model: '', reasoningEffort: '', maxQueuePerTask: 0 });

/**
 * Build the host-side schema for the section.
 * @param {Function} z - schemastery namespace (@deepseek-ai/schemastery).
 * @returns the schema resolving the `task-coordinator` namespace.
 */
export function buildSpawnModelsSchema(z) {
  return z.object({
    provider: z.string().default(''),
    model: z.string().default(''),
    reasoningEffort: z.string().default(''),
    // 0.23.0: per-target send-queue cap, 0 = follow the patch config.
    // step(1).min().max() is the real integer/range enforcement — schemastery
    // 3.18.x has no .int() and pattern() is display-only (web-search-mana
    // field finding). The write boundary stays types-only (0.18.5 lesson);
    // the range is clamped at consumption (normalizeQueueCap) and constrained
    // in the GUI input.
    maxQueuePerTask: z.number().step(1).min(0).max(MAX_QUEUE_PER_TASK_CAP).default(0),
  });
}

/**
 * Normalize the stored section's queue-cap override (0.23.0).
 *
 * Contract:
 *  - absent / not an object / field missing  -> null (follow patch config);
 *  - 0 or any non-integer / negative / non-number -> null (sentinel or junk);
 *  - integer >= 1 -> min(value, MAX_QUEUE_PER_TASK_CAP) (clamped, honest cap).
 *
 * @param {unknown} value - resolved section value from the settings service.
 * @returns {number | null} the effective cap override, or null to follow config.
 */
export function normalizeQueueCap(value) {
  if (value === undefined || value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value.maxQueuePerTask;
  if (typeof raw !== 'number' || !Number.isFinite(raw) || !Number.isInteger(raw) || raw < 1) return null;
  return Math.min(raw, MAX_QUEUE_PER_TASK_CAP);
}

/**
 * Normalize one stored section value into a spawn route.
 *
 * Contract:
 *  - absent / not an object / empty pair  -> null (no default route);
 *  - a valid provider+model pair          -> { provider, model, reasoningEffort? }
 *    (strings trimmed; empty reasoningEffort dropped);
 *  - exactly one of provider/model set    -> throws (malformed half pair).
 *
 * @param {unknown} value - resolved section value from the settings service.
 * @returns {null | { provider: string, model: string, reasoningEffort?: string }}
 */
export function normalizeSpawnRoute(value) {
  if (value === undefined || value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const rawProvider = typeof value.provider === 'string' ? value.provider.trim() : '';
  const rawModel = typeof value.model === 'string' ? value.model.trim() : '';
  if (rawProvider.length === 0 && rawModel.length === 0) return null;
  if (rawProvider.length === 0 || rawModel.length === 0) {
    throw new Error('spawn-model default requires provider and model together (or both empty to follow the host default)');
  }
  const rawEffort = typeof value.reasoningEffort === 'string' ? value.reasoningEffort.trim() : '';
  return {
    provider: rawProvider,
    model: rawModel,
    ...(rawEffort.length > 0 ? { reasoningEffort: rawEffort } : {}),
  };
}

/**
 * Validation for the settings service's validate hook: accepts the empty
 * section (no default), any well-formed route, AND half pairs — the pair
 * rule is deliberately NOT enforced at the write boundary.
 *
 * 0.18.5 lesson (field-verified against ~/.dsh/settings.yaml): rejecting
 * half pairs here silently broke GUI saves. The settings scope's write
 * channel resolves normally even when the host rejects a mutation (it folds
 * back the latest good state via a recovery read), so an over-strict
 * validate hook rolled back the provider/model writes without any visible
 * error — only the last field survived into the document, and the section
 * came back "unset" after a host restart. The pair rule lives where it can
 * be enforced honestly: the settings UI blocks Save on a half pair, and
 * consumption degrades safely (normalizeSpawnRoute throws on a half pair;
 * readSpawnDefaults catches and treats it as unset → host default).
 *
 * @param {unknown} value - candidate section value.
 * @returns {void} nothing; throws only on malformed shapes.
 */
export function validateSpawnModelsSection(value) {
  if (value === undefined || value === null) return;
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('spawn-model default section must be an object');
  }
  for (const key of ['provider', 'model', 'reasoningEffort']) {
    if (value[key] !== undefined && typeof value[key] !== 'string') {
      throw new Error(`spawn-model default field "${key}" must be a string`);
    }
  }
  // Types-only at the write boundary (0.18.5 lesson): the range clamp lives
  // at consumption (normalizeQueueCap) and in the GUI input, never here —
  // an over-strict hook silently rolls back the whole atomic save.
  if (value.maxQueuePerTask !== undefined && typeof value.maxQueuePerTask !== 'number') {
    throw new Error('spawn-model default field "maxQueuePerTask" must be a number');
  }
}
