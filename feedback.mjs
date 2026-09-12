import { blocksToText, excerpt } from './safety.mjs';

export const COORDINATOR_CAPABILITIES = Object.freeze({
  externalRef: true, validatedWaitTargets: true, progressCursor: true,
  messageIdentity: true, externalFamilies: true, bridgeReceipts: true,
});
export function decodeCursor(cursor, sessionId) {
  if (cursor === undefined) return null;
  try {
    if (typeof cursor !== 'string' || cursor.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(cursor)) throw new Error();
    const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (value.v !== 1 || value.sessionId !== sessionId || !Number.isSafeInteger(value.nextSeq) || value.nextSeq < 0) throw new Error();
    return value.nextSeq;
  } catch { throw new Error('invalid progress cursor for this session'); }
}
export function messageProjection(event, chars) {
  const data = event?.data;
  const assistant = event?.type === 'assistant/message';
  if (!data || (!assistant && event.type !== 'user/message')) return null;
  const message = assistant ? data.message : data;
  const text = blocksToText(message?.content);
  if (!text) return null;
  return { role: assistant ? 'assistant' : 'user', text: excerpt(text, chars),
    truncated: text.length > chars,
    ...(!assistant ? { source: data.source?.kind ?? 'user' } : {}),
    ...(Number.isSafeInteger(event.seq) ? { seq: event.seq } : {}),
    ...(typeof message?.id === 'string' ? { messageId: message.id } : {}),
    ...(typeof event.time === 'number' ? { time: event.time } : {}),
    ...(/^\[reference: ([^\r\n]+)\]\n/.test(text) ? { reference: text.match(/^\[reference: ([^\r\n]+)\]\n/)[1] } : {}),
  };
}

// seq is the next event position, matching snapshotEvents(from, to)'s exclusive end.
export function feedbackPage({ sessionId, events, from, throughSeq, nextSeq, limit, chars, source }) {
  const valid = Number.isSafeInteger(throughSeq) && throughSeq >= 0 && Array.isArray(events) &&
    events.every(event => Number.isSafeInteger(event?.seq));
  if (!valid || (nextSeq !== null && nextSeq > throughSeq)) return {
    messages: [], nextCursor: null, hasMore: false, coverage: 'unavailable', source,
    reason: valid ? 'cursor-ahead-of-session' : 'event-sequence-unavailable',
  };
  const scannedEnd = Math.min(throughSeq, from + 400);
  const gap = events.length !== scannedEnd - from || events.some((event, i) => event.seq !== from + i);
  const picked = events.filter(e => e.seq >= from && e.seq < scannedEnd)
    .map(e => messageProjection(e, chars)).filter(Boolean);
  const messages = nextSeq === null ? picked.slice(-limit) : picked.slice(0, limit);
  const moreInPage = nextSeq !== null && picked.length > limit;
  const resumeAt = moreInPage ? messages.at(-1).seq + 1 : scannedEnd;
  return { messages, nextCursor: Buffer.from(JSON.stringify({ v: 1, sessionId, nextSeq: resumeAt })).toString('base64url'),
    hasMore: resumeAt < throughSeq, coverage: (gap || (nextSeq === null && (from > 0 || picked.length > limit))) ? 'partial' : 'complete',
    ...(gap ? { reason: 'event-gap' } : {}),
    source, fromSeq: from, throughSeq: scannedEnd,
    // A model-authored excerpt, explicitly not a completion/acceptance verdict.
    summary: messages.findLast?.(m => m.role === 'assistant') ?? [...messages].reverse().find(m => m.role === 'assistant') ?? null,
  };
}
