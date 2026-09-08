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
 * Base (fallback) section entry: no default route — spawned tasks without an
 * explicit provider+model keep the host default model, exactly the pre-0.18
 * behavior.
 */
export const SPAWN_MODELS_BASE = Object.freeze({ provider: '', model: '', reasoningEffort: '' });

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
  });
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
 * Strict validation for the settings service's validate hook: accepts the
 * empty section (no default) and any well-formed route; rejects half pairs
 * and non-string shapes at the write boundary so a bad stored layer can
 * never silently break spawns.
 * @param {unknown} value - candidate section value.
 * @returns {void} nothing; throws on malformed values.
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
  normalizeSpawnRoute(value); // throws on half pairs
}
