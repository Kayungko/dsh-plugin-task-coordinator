import { createHash } from 'node:crypto';
export const EXTERNAL_CALLER = 'task-bridge-external';
export function externalGroup(row) {
  if (row.parentSessionId !== EXTERNAL_CALLER) return undefined;
  // Free-form ref is opaque grouping data, not an authenticated identity.
  const known = typeof row.externalRef === 'string' && row.externalRef.trim().length > 0;
  const key = known ? `ref:${row.externalRef.trim()}` : `unknown:${row.sessionId}`;
  return { id: `${EXTERNAL_CALLER}:${createHash('sha256').update(key).digest('hex').slice(0, 32)}`, known };
}
export function cleanReceipt(value) {
  if (!value || !Number.isSafeInteger(value.seq) || value.seq < 1 || !Number.isFinite(value.time) ||
      !['spawn', 'send'].includes(value.kind)) return null;
  const result = { seq: value.seq, time: value.time, kind: value.kind };
  for (const key of ['messageId', 'correlationId']) if (typeof value[key] === 'string' && value[key].length <= 256) result[key] = value[key];
  if (typeof value.delivered === 'boolean') result.delivered = value.delivered;
  if (['queue', 'steer'].includes(value.mode)) result.mode = value.mode;
  return result;
}
