import { EXTERNAL_CALLER, externalGroup, cleanReceipt } from './external.mjs';
// Read-only orchestration queries carried by the host's authenticated Connection.
// No prompts, filesystem paths, external references or provider output cross this API.
export const FAMILY_PATH = '/api/task-coordinator/family';
export const HISTORY_PATH = '/api/task-coordinator/history';
const safeId = value => typeof value === 'string' && value.length > 0 && value.length <= 256;
const fail = (code, status = 503) => ({ ok: false, code, status });
const clipped = value => typeof value === 'string' ? value.slice(0, 300) : undefined;

export function buildFamily(snapshot, sessionId, visibleIds) {
  if (!safeId(sessionId)) return fail('bad-session-id', 400);
  if (!visibleIds.has(sessionId)) return fail('session-not-visible', 404);
  if (snapshot.state !== 'ready' && snapshot.state !== 'missing') return fail('registry-unavailable');
  const projected = snapshot.entries.map(row => {
    if (row.parentSessionId !== EXTERNAL_CALLER) return row;
    const group = row.externalGroup ?? externalGroup(row);
    return { ...row, parentSessionId: group.id, externalAssociation: group.known ? 'known' : 'unknown' };
  });
  const entries = new Map(projected.map(row => [row.sessionId, row]));
  for (const row of projected) if (row.externalAssociation) entries.set(row.parentSessionId, {
    sessionId: row.parentSessionId, kind: 'external', externalAssociation: row.externalAssociation,
  });
  const path = [], visited = new Set();
  let rootId = sessionId, ancestryComplete = true;
  while (entries.get(rootId)?.parentSessionId) {
    if (visited.has(rootId) || visited.size >= 64) return fail('lineage-cycle');
    visited.add(rootId); path.push(rootId);
    const entry = entries.get(rootId);
    rootId = entry.parentSessionId;
    if (!entries.has(rootId) && entry.depth !== 1) ancestryComplete = false;
  }
  if (visited.has(rootId)) return fail('lineage-cycle');
  path.push(rootId); path.reverse();
  const children = new Map();
  for (const row of projected) {
    if (!safeId(row.parentSessionId)) continue;
    if (!children.has(row.parentSessionId)) children.set(row.parentSessionId, []);
    children.get(row.parentSessionId).push(row);
  }
  const nodes = [], queue = [{ id: rootId, depth: 0 }], seen = new Set();
  while (queue.length) {
    const { id, depth } = queue.shift();
    if (seen.has(id) || depth > 64) return fail('lineage-cycle');
    seen.add(id);
    const row = entries.get(id);
    const visible = visibleIds.has(id);
    nodes.push({ sessionId: id, parentSessionId: id === rootId ? null : row?.parentSessionId,
      familyDepth: depth, available: visible,
      ...(row?.kind === 'external' ? { kind: 'external', association: row.externalAssociation } : {}),
      ...(visible && row ? { title: clipped(row.title), team: clipped(row.team), time: row.createdAt } : {}) });
    const sorted = (children.get(id) || []).slice().sort((a,b) => a.createdAt - b.createdAt || a.sessionId.localeCompare(b.sessionId, 'en'));
    for (const child of sorted) queue.push({ id: child.sessionId, depth: depth + 1 });
  }
  return { ok: true, associated: nodes.length > 1, rootSessionId: rootId, currentSessionId: sessionId,
    ancestryComplete, currentPath: path, nodes, coverage: 'registry', limit: snapshot.maxEntries };
}

// Native tool-call/result event shapes match dsh-client-ui-chat's rootCall/rootResult.
export function relationEvents(records, parentId, targetId) {
  const calls = new Map(), events = [];
  let unmatched = 0;
  const json = value => { try { return typeof value === 'string' ? JSON.parse(value) : value; } catch { return null; } };
  for (const record of records) {
    const event = record?.type === 'event' ? record.event : null;
    if (!event || !Number.isSafeInteger(event.seq)) continue;
    const data = event.data || {};
    if (event.type === 'tool/call' && typeof data.callId === 'string') calls.set(data.callId, { name: data.name, args: json(data.arguments) });
    if (event.type === 'tool/result') {
      const callId = data.message?.source?.callId;
      const call = calls.get(callId);
      if (!call) { unmatched++; continue; }
      const resultBlock = data.message?.content?.[0];
      const payload = json(resultBlock?.content?.find(part => part.type === 'text')?.text);
      if (!payload || typeof payload !== 'object') continue;
      const base = { seq: event.seq, time: event.time, from: parentId, to: targetId };
      if (call.name === 'task_spawn' && payload.ok !== false && payload.sessionId === targetId) events.push({ ...base, kind: 'spawn' });
      if (call.name === 'task_spawn_batch' && Array.isArray(payload.results) && payload.results.some(row => row?.ok !== false && row?.sessionId === targetId)) events.push({ ...base, kind: 'spawn' });
      if (call.name === 'task_send' && (payload.targetId || call.args?.sessionId) === targetId) events.push({ ...base, kind: 'send',
        delivered: payload.ok !== false && payload.delivered !== false && resultBlock.isError !== true,
        mode: call.args?.mode === 'steer' ? 'steer' : 'queue' });
    }
    if (event.type === 'user/message' && data.source?.kind === 'coordinator' && data.source.form === 'relay' && data.source.senderSessionId === targetId) {
      events.push({ seq: event.seq, time: event.time, kind: 'report', from: targetId, to: parentId });
    }
  }
  return { events, unmatched };
}

export function createFamilyQueries({ registry, sessionController }) {
  async function context(sessionId, signal) {
    const result = await sessionController.list({}, signal);
    const rows = Array.isArray(result) ? result : result?.items;
    if (!Array.isArray(rows)) return { family: fail('session-list-unavailable'), rows: [] };
    const ids = new Set(rows.map(row => row.sessionId));
    return { family: buildFamily(registry.snapshot(), sessionId, ids), rows };
  }
  return {
    async family(sessionId, signal) { return (await context(sessionId, signal)).family; },
    async history(sessionId, targetId, cursor, signal) {
      if (!safeId(targetId)) return fail('bad-target-id', 400);
      const { family, rows } = await context(sessionId, signal);
      if (!family.ok) return family;
      const target = family.nodes.find(row => row.sessionId === targetId);
      if (!target?.available || !target.parentSessionId) return fail('target-not-in-family', 404);
      const parent = rows.find(row => row.sessionId === target.parentSessionId);
      if (!parent) {
        const root = family.nodes.find(row => row.sessionId === target.parentSessionId);
        if (root?.kind !== 'external') return fail('parent-not-visible', 404);
        const recorded = registry.snapshot().entries.find(row => row.sessionId === targetId);
        const receipts = (recorded?.bridgeReceipts ?? []).map(cleanReceipt).filter(Boolean);
        const throughSeq = cursor?.throughSeq ?? recorded?.receiptSeq ?? 0;
        const beforeSeq = cursor?.beforeSeq ?? throughSeq + 1;
        if (!Number.isSafeInteger(throughSeq) || throughSeq < 0 || throughSeq > (recorded?.receiptSeq ?? 0) ||
            !Number.isSafeInteger(beforeSeq) || beforeSeq < 1 || beforeSeq > throughSeq + 1) return fail('bad-cursor', 400);
        const candidates = receipts.filter(r => r.seq <= throughSeq && r.seq < beforeSeq);
        const page = candidates.slice(-30);
        const hasMore = candidates.length > page.length;
        return { ok: true, sourceSessionId: target.parentSessionId, targetSessionId: targetId,
          events: page.map(r => ({ ...r, from: target.parentSessionId, to: targetId })),
          hasMore, nextCursor: hasMore ? { throughSeq, beforeSeq: page[0].seq } : null,
          scanned: page.length, unmatched: 0, coverage: 'partial', source: 'bridge-receipts',
          note: 'Delivery receipts only; historical gaps and external replies are not reconstructed. Delivery does not prove consumption.' };
      }
      if (typeof sessionController.page !== 'function') return fail('history-service-unavailable');
      const throughSeq = cursor?.throughSeq ?? parent.projections?.asOfSeq;
      const beforeSeq = cursor?.beforeSeq;
      if (!Number.isSafeInteger(throughSeq) || throughSeq < -1 || (beforeSeq !== undefined && (!Number.isSafeInteger(beforeSeq) || beforeSeq < 0 || beforeSeq > throughSeq + 1))) return fail('history-cursor-unavailable', 400);
      const page = await sessionController.page({ address: { kind: 'session', sessionId: parent.sessionId }, throughSeq,
        ...(beforeSeq === undefined ? {} : { beforeSeq }), maxMessages: 30 }, signal);
      if (!Array.isArray(page?.records)) return fail('history-shape-invalid');
      // Cap what this plugin scans/returns even when a message has many tool events.
      const records = page.records.slice(-2000);
      const first = records.find(record => record.type === 'event' && Number.isSafeInteger(record.event?.seq))?.event.seq;
      const { events, unmatched } = relationEvents(records, parent.sessionId, targetId);
      const hasMore = (page.hasMore === true || page.records.length > records.length) && Number.isSafeInteger(first) && first > 0;
      return { ok: true, sourceSessionId: parent.sessionId, targetSessionId: targetId, events,
        hasMore, nextCursor: hasMore ? { throughSeq, beforeSeq: first } : null, scanned: records.length, unmatched,
        coverage: hasMore || unmatched ? 'partial' : 'loaded' };
    },
  };
}

export function installFamilyRoutes(ctx, deps) {
  const queries = createFamilyQueries(deps);
  ctx.inject(['connection'], connectionCtx => {
    const register = connectionCtx.connection?.fetch?.register;
    if (typeof register !== 'function') return;
    for (const path of [FAMILY_PATH, HISTORY_PATH]) {
      ctx.effect(() => connectionCtx.connection.fetch.register({ path, methods: ['GET'], requestBody: 'buffered',
        fetch: async request => {
          let result;
          try {
            const url = new URL(request.url);
            const id = url.searchParams.get('sessionId');
            if (!safeId(id)) result = fail('bad-session-id', 400);
            else if (path === FAMILY_PATH) result = await queries.family(id, request.signal);
            else {
              const before = url.searchParams.get('beforeSeq'), through = url.searchParams.get('throughSeq');
              const validInteger = value => /^\d{1,16}$/.test(value || '') && Number.isSafeInteger(Number(value));
              if ((before !== null || through !== null) && (!validInteger(before) || !validInteger(through))) result = fail('bad-cursor', 400);
              else result = await queries.history(id, url.searchParams.get('targetId'), before === null ? null : { beforeSeq: Number(before), throughSeq: Number(through) }, request.signal);
            }
          } catch { result = fail(request.signal.aborted ? 'cancelled' : 'family-query-failed'); }
          return new Response(JSON.stringify(result), { status: result.ok ? 200 : result.status || 503,
            headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
        },
      }), `task-coordinator: ${path}`);
    }
  });
}
