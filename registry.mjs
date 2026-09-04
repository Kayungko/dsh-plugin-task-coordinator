/**
 * Durable spawn registry for dsh-plugin-task-coordinator.
 *
 * Absorbed from the SCDP workstream idea (junwei529/session-coordinator-dsh),
 * kept deliberately lightweight: one JSON file records which sessions the
 * coordinator spawned, under which team, and with what intent — so after a
 * host restart the supervisor can still answer "which tasks are mine and how
 * do they group", which native session listing alone cannot tell it.
 *
 * Design rules:
 *  - never throws on load/save: a corrupt or missing file degrades to an
 *    empty registry (corrupt files are preserved as `*.corrupt-<ts>` for
 *    inspection instead of being silently dropped);
 *  - writes are near-atomic (temp file + rename);
 *  - the registry is capped (`maxEntries`) and pruned oldest-first.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const REGISTRY_FORMAT_VERSION = 1;

export class SpawnRegistry {
  /**
   * @param {string} filePath absolute path of the registry JSON file
   * @param {{ maxEntries?: number; now?: () => number }} [options]
   */
  constructor(filePath, options = {}) {
    this.filePath = filePath;
    this.maxEntries = Number.isFinite(options.maxEntries) && options.maxEntries > 0
      ? Math.floor(options.maxEntries)
      : 500;
    this.now = typeof options.now === 'function' ? options.now : () => Date.now();
    /** @type {Map<string, { team?: string; createdAt: number; title?: string; promptExcerpt?: string }>} */
    this.entries = new Map();
    this.loaded = false;
  }

  /** Load lazily and tolerantly; safe to call repeatedly. */
  ensureLoaded() {
    if (this.loaded) return;
    this.loaded = true;
    if (!existsSync(this.filePath)) return;
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, 'utf8'));
      const raw = parsed && typeof parsed === 'object' ? parsed.entries : null;
      if (raw && typeof raw === 'object') {
        for (const [sessionId, entry] of Object.entries(raw)) {
          if (typeof sessionId === 'string' && entry && typeof entry === 'object' && Number.isFinite(entry.createdAt)) {
            this.entries.set(sessionId, {
              createdAt: entry.createdAt,
              ...(typeof entry.team === 'string' && entry.team.length > 0 ? { team: entry.team } : {}),
              ...(typeof entry.title === 'string' && entry.title.length > 0 ? { title: entry.title } : {}),
              ...(typeof entry.promptExcerpt === 'string' && entry.promptExcerpt.length > 0 ? { promptExcerpt: entry.promptExcerpt } : {}),
              ...(typeof entry.depth === 'number' && Number.isFinite(entry.depth) && entry.depth >= 1 ? { depth: entry.depth } : {}),
              ...(typeof entry.parentSessionId === 'string' && entry.parentSessionId.length > 0 ? { parentSessionId: entry.parentSessionId } : {}),
            });
          }
        }
      }
    } catch {
      // Preserve the broken file for inspection, start clean.
      try { renameSync(this.filePath, `${this.filePath}.corrupt-${this.now()}`); } catch { /* best effort */ }
      this.entries.clear();
    }
  }

  /**
   * Record one spawned session. Existing entries are merged (never lost).
   * @param {string} sessionId
   * @param {{ team?: string; title?: string; promptExcerpt?: string; createdAt?: number; depth?: number; parentSessionId?: string }} entry
   */
  record(sessionId, entry = {}) {
    this.ensureLoaded();
    const existing = this.entries.get(sessionId);
    const merged = {
      createdAt: existing?.createdAt ?? (Number.isFinite(entry.createdAt) ? entry.createdAt : this.now()),
      ...(entry.team !== undefined || existing?.team !== undefined
        ? { team: typeof entry.team === 'string' && entry.team.length > 0 ? entry.team : existing?.team }
        : {}),
      ...(entry.title !== undefined || existing?.title !== undefined
        ? { title: typeof entry.title === 'string' && entry.title.length > 0 ? entry.title : existing?.title }
        : {}),
      ...(entry.promptExcerpt !== undefined || existing?.promptExcerpt !== undefined
        ? { promptExcerpt: typeof entry.promptExcerpt === 'string' && entry.promptExcerpt.length > 0 ? entry.promptExcerpt : existing?.promptExcerpt }
        : {}),
      ...(entry.depth !== undefined || existing?.depth !== undefined
        ? { depth: typeof entry.depth === 'number' && Number.isFinite(entry.depth) && entry.depth >= 1 ? entry.depth : existing?.depth }
        : {}),
      ...(entry.parentSessionId !== undefined || existing?.parentSessionId !== undefined
        ? { parentSessionId: typeof entry.parentSessionId === 'string' && entry.parentSessionId.length > 0 ? entry.parentSessionId : existing?.parentSessionId }
        : {}),
    };
    if (merged.team === undefined) delete merged.team;
    if (merged.title === undefined) delete merged.title;
    if (merged.promptExcerpt === undefined) delete merged.promptExcerpt;
    if (merged.depth === undefined) delete merged.depth;
    if (merged.parentSessionId === undefined) delete merged.parentSessionId;
    this.entries.set(sessionId, merged);
    this.prune();
    this.save();
  }

  /** @returns {{ team?: string; createdAt: number; title?: string; promptExcerpt?: string } | undefined} */
  get(sessionId) {
    this.ensureLoaded();
    return this.entries.get(sessionId);
  }

  /** @returns {string[]} session ids recorded under one team, oldest first */
  listTeam(team) {
    this.ensureLoaded();
    return [...this.entries.entries()]
      .filter(([, entry]) => entry.team === team)
      .sort((a, b) => a[1].createdAt - b[1].createdAt)
      .map(([sessionId]) => sessionId);
  }

  /** @returns {string[]} all known team names */
  teams() {
    this.ensureLoaded();
    return [...new Set([...this.entries.values()].map((entry) => entry.team).filter((team) => typeof team === 'string'))];
  }

  prune() {
    if (this.entries.size <= this.maxEntries) return;
    const ordered = [...this.entries.entries()].sort((a, b) => a[1].createdAt - b[1].createdAt);
    const dropCount = this.entries.size - this.maxEntries;
    for (let index = 0; index < dropCount; index += 1) {
      this.entries.delete(ordered[index][0]);
    }
  }

  save() {
    try {
      mkdirSync(dirname(this.filePath), { recursive: true });
      const payload = JSON.stringify(
        { version: REGISTRY_FORMAT_VERSION, updatedAt: this.now(), entries: Object.fromEntries(this.entries) },
        null,
        2,
      );
      const tmp = `${this.filePath}.tmp-${this.now()}`;
      writeFileSync(tmp, payload, 'utf8');
      renameSync(tmp, this.filePath);
    } catch {
      // The registry is an enhancement, never a failure path for coordination.
    }
  }
}
