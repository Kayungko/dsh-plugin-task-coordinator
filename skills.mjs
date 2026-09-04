/**
 * Skill mounting for dsh-plugin-task-coordinator.
 *
 * Ships the `task-coordination` supervisor playbook inside the bundle by
 * mounting an ISOLATED @deepseek-ai/dsh-skill-filesystem provider that serves
 * only this plugin's own `skills/` directory (same pattern as the shipped
 * @openviking/dsh-memory-plugin). The isolated provider:
 *  - never shadows or duplicates what DSH's default `filesystem` provider
 *    discovers under the project and user skill roots;
 *  - watches the directory, so skill edits reach the catalog without restart;
 *  - disappears together with the plugin on uninstall.
 *
 * The provider package is imported dynamically so that a missing skill
 * dependency can never break the coordination tools themselves: failure
 * degrades to a warning and skips the skill only.
 */

import { fileURLToPath } from 'node:url';

/** Provider name on `ctx.skills`; must not collide with DSH's own `filesystem`. */
export const SKILL_PROVIDER_NAME = 'task-coordinator';

/** The bundled `task-coordination` skill directory. */
export const SKILLS_DIR = fileURLToPath(new URL('./skills', import.meta.url));

export function buildSkillsConfig() {
  return {
    providerName: SKILL_PROVIDER_NAME,
    includeDefaultRoots: false,
    customSkillDirs: [SKILLS_DIR],
  };
}

/**
 * Mount the isolated skill provider on the plugin context.
 * Fire-and-forget by design (mirrors the shipped openviking MCP mount):
 * tool registration is the plugin's core contract, the skill is a companion.
 * @param {object} ctx cordis context
 * @returns {Promise<void>}
 */
export async function mountCoordinatorSkills(ctx) {
  let skillFilesystem;
  try {
    skillFilesystem = await import('@deepseek-ai/dsh-skill-filesystem');
  } catch (error) {
    ctx.logger?.warn(`task-coordinator: skill not mounted, dsh-skill-filesystem unavailable (${error?.message ?? error})`);
    return;
  }
  try {
    ctx.plugin(skillFilesystem, buildSkillsConfig());
  } catch (error) {
    ctx.logger?.warn(`task-coordinator: skill mount failed (${error?.message ?? error})`);
  }
}
