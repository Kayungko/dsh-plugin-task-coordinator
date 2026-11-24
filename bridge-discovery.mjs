/** Local discovery for the owner of a configured task-bridge token file. No token is stored here. */
import { randomUUID } from 'node:crypto';
import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Agent as HttpAgent, request as httpRequest } from 'node:http';
import { Agent as HttpsAgent, request as httpsRequest } from 'node:https';
import { Readable } from 'node:stream';

export const BRIDGE_INSTANCE_HEADER = 'X-Task-Bridge-Instance';
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const dirOf = tokenFile => `${resolve(tokenFile)}.instances`;

function loopbackOrigin(value) {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) ||
        !['127.0.0.1', '[::1]'].includes(url.hostname) ||
        url.username || url.password || url.pathname !== '/' || url.search || url.hash)
      return null;
    return url.origin;
  } catch {
    return null;
  }
}

// New agents intentionally ignore ambient proxy settings. These requests must
// go to the exact local socket; node:http never follows HTTP redirects.
const directHttp = new HttpAgent({ keepAlive: true });
const directHttps = new HttpsAgent({ keepAlive: true });
export function requestLocalBridge(origin, pathname, { headers, signal } = {}) {
  if (loopbackOrigin(origin) !== origin || typeof pathname !== 'string' || !/^\/v1\//.test(pathname))
    throw new Error('Task bridge discovery requires an exact loopback origin.');
  return new Promise((resolve, reject) => {
    const target = new URL(origin + pathname);
    const tls = target.protocol === 'https:';
    const request = (tls ? httpsRequest : httpRequest)(target, {
      agent: tls ? directHttps : directHttp, headers, signal,
    }, response => {
      const status = response.statusCode;
      if (!status || status >= 300 && status < 400) {
        response.resume();
        reject(new Error('Task bridge redirects are not supported.'));
        return;
      }
      resolve(new Response(status === 204 ? null : Readable.toWeb(response), { status, headers: response.headers }));
    });
    request.once('error', reject);
    request.end();
  });
}

/** Publishes one file per live mount so a different instance never loses its file. */
export function publishBridgeInstance(webServer, tokenFile, instance, logger) {
  let origin;
  try { origin = loopbackOrigin(webServer.getOrigin?.()); } catch { /* not yet bound */ }
  if (!origin) return () => {};
  const directory = dirOf(tokenFile);
  const file = join(directory, `${instance}.json`);
  const temp = `${file}.tmp`;
  try {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    writeFileSync(temp, `${JSON.stringify({ version: 1, origin, instance, pid: process.pid })}\n`, { flag: 'wx', mode: 0o600 });
    renameSync(temp, file);
  } catch (error) {
    logger?.warn?.(`task-bridge: address discovery unavailable (${error?.code ?? 'write failed'})`);
    try { rmSync(temp, { force: true }); } catch { /* non-blocking */ }
    return () => {};
  }
  return () => {
    try { rmSync(file, { force: true }); } catch { /* stale descriptors are not trusted */ }
  };
}

function processExists(pid) {
  if (!Number.isInteger(pid) || pid < 1 || pid > 0x7fff_ffff) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/** Resolve without credentials. A matching local bridge must prove it owns the origin. */
export async function discoverBridgeOrigin(tokenFile, { signal, timeoutMs = 1800 } = {}) {
  const directory = dirOf(tokenFile);
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  const instances = entries.filter(entry => entry.isFile() && UUID.test(entry.name.slice(0, -5)) && entry.name.endsWith('.json'));
  const bound = signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
  const results = await Promise.all(instances.map(async entry => {
    try {
      const descriptor = JSON.parse(await readFile(join(directory, entry.name), { encoding: 'utf8', signal: bound }));
      const { origin, instance, pid } = descriptor;
      if (descriptor.version !== 1 || instance !== entry.name.slice(0, -5) || !processExists(pid)) return null;
      const verifiedOrigin = loopbackOrigin(origin);
      if (!verifiedOrigin) return null;
      const response = await requestLocalBridge(verifiedOrigin, '/v1/capabilities', { signal: bound });
      const accepted = response.status === 401 &&
        /^application\/json(?:;|$)/i.test(response.headers.get('content-type') ?? '') &&
        response.headers.get(BRIDGE_INSTANCE_HEADER) === instance;
      await response.body?.cancel();
      return accepted ? verifiedOrigin : null;
    } catch { return null; }
  }));
  const live = results.filter(Boolean);
  if (live.length > 1) throw new Error('Multiple local task bridges are live; set an explicit TASK_BRIDGE_URL.');
  if (live.length !== 1) throw new Error('No live local task bridge discovered; check Desktop or set an explicit TASK_BRIDGE_URL.');
  return live[0];
}
