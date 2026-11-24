import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { discoverBridgeOrigin, publishBridgeInstance, requestLocalBridge, BRIDGE_INSTANCE_HEADER } from '../bridge-discovery.mjs';
import { ENDPOINTS, createEndpointHandler } from '../bridge-endpoints.mjs';
import { mountExternalBridge, resolveConfig } from '../bridge-runtime.mjs';

async function localServer(t, listener) {
  const http = createServer(listener);
  await new Promise((done, fail) => http.once('error', fail).listen(0, '127.0.0.1', done));
  t.after(() => { http.closeAllConnections(); return new Promise(done => http.close(done)); });
  return `http://127.0.0.1:${http.address().port}`;
}

test('discovery requires live matching instance, rejects ambiguity, and does not follow redirects or carry tokens', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-bridge-discovery-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const tokenFile = join(dir, 'separate-test.token');
  const instance = randomUUID(), other = randomUUID();
  const portFor = async nonce => await localServer(t, (req, res) => {
    assert.equal(req.url, '/v1/capabilities');
    assert.equal(req.headers['x-task-bridge-token'], undefined);
    res.writeHead(401, { 'content-type': 'application/json', [BRIDGE_INSTANCE_HEADER]: nonce });
    res.end('{}');
  });
  const first = await portFor(instance), second = await portFor(other);
  const endpoint = origin => ({ getOrigin: () => origin });
  await assert.rejects(discoverBridgeOrigin(tokenFile), /No live/);
  const firstDispose = publishBridgeInstance(endpoint(first), tokenFile, instance);
  assert.equal(await discoverBridgeOrigin(tokenFile), first);
  const secondDispose = publishBridgeInstance(endpoint(second), tokenFile, other);
  await assert.rejects(discoverBridgeOrigin(tokenFile), /Multiple/);
  firstDispose();
  assert.equal(await discoverBridgeOrigin(tokenFile), second);
  secondDispose();
  await assert.rejects(discoverBridgeOrigin(tokenFile), /No live/);
  const mismatched = publishBridgeInstance(endpoint(first), tokenFile, other);
  await assert.rejects(discoverBridgeOrigin(tokenFile), /No live/);
  mismatched();
  let followed = false;
  const sink = await localServer(t, (_req, res) => { followed = true; res.end(); });
  const redirect = await localServer(t, (_req, res) => {
    res.writeHead(302, { location: sink + '/v1/capabilities' }); res.end();
  });
  const dispose = publishBridgeInstance(endpoint(redirect), tokenFile, instance);
  await assert.rejects(discoverBridgeOrigin(tokenFile), /No live/);
  await assert.rejects(requestLocalBridge(redirect, '/v1/list', { headers: { 'X-Task-Bridge-Token': 'fixture' } }), /redirect/i);
  assert.equal(followed, false);
  dispose();
  const unsafe = publishBridgeInstance(endpoint('https://192.0.2.10:43120'), tokenFile, instance);
  await assert.rejects(discoverBridgeOrigin(tokenFile), /No live/);
  unsafe();
});

test('socket loopback guard rejects a non-loopback peer even with forwarded loopback headers', async () => {
  const endpoint = ENDPOINTS.find(entry => entry.kind === 'send');
  const handler = createEndpointHandler(endpoint, {
    tokenStore: { verify: () => assert.fail('token check ran before socket guard') },
    getCoordinator: () => assert.fail('coordinator called before socket guard'),
  });
  const req = {
    method: 'POST', socket: { remoteAddress: '192.0.2.10' },
    headers: { 'x-forwarded-for': '127.0.0.1', forwarded: 'for=127.0.0.1', 'x-task-bridge-token': 'fixture' },
  };
  let status, json;
  await handler(req, { writeHead(code) { status = code; }, end(body) { json = JSON.parse(body); } });
  assert.equal(status, 403);
  assert.equal(json.code, 'unauthorized');
});

const hostRoot = process.env.DSH_BRIDGE_HOST_TEST_ROOT;
test('official DSH dispatcher: bridge authorization reaches only the guarded exact routes', {
  skip: hostRoot ? false : 'Set DSH_BRIDGE_HOST_TEST_ROOT to the isolated DSH alpha.2+ npm prefix.',
}, async t => {
  const req = createRequire(join(resolve(hostRoot), 'package.json'));
  const { Context } = await import(pathToFileURL(req.resolve('@deepseek-ai/cordis')).href);
  const { default: WebServer } = await import(pathToFileURL(req.resolve('@deepseek-ai/dsh-host-webserver')).href);
  const ctx = new Context();
  // Match Desktop's admission decision for requests without its separate credential.
  ctx.on('webserver/authorize', (_request, policy) => policy === 'anonymous'
    ? { kind: 'allow' } : { kind: 'deny', status: 401 }, { global: true });
  const fiber = ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 });
  await fiber.await();
  t.after(() => fiber.dispose());
  const webServer = ctx.get('webServer');
  const origin = webServer.getOrigin();
  let elsewhere = 0, mutations = 0;
  const dir = await mkdtemp(join(tmpdir(), 'dsh-bridge-dispatch-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const tokenFile = join(dir, 'test.token');
  webServer.register({ kind: 'exact', path: '/protected-control', handler: (_req, res) => {
    elsewhere++; res.end('should never run');
  } });
  const disposers = mountExternalBridge({
    webServer, effect: register => register(),
    get: () => ({ ops: { sendMessage: () => { mutations++; return { ok: true }; } } }),
  }, resolveConfig({ tokenFile }));
  const token = (await readFile(tokenFile, 'utf8')).trim();
  assert.equal(await discoverBridgeOrigin(tokenFile), origin);
  const control = await fetch(origin + '/protected-control');
  assert.equal(control.status, 401);
  assert.equal(await control.text(), 'unauthorized');
  assert.equal(elsewhere, 0);
  assert.equal((await fetch(origin + '/unrelated-miss')).status, 404);
  for (const { path, method } of ENDPOINTS) {
    for (const value of [undefined, 'wrong-token']) {
      const headers = value ? { 'X-Task-Bridge-Token': value } : {};
      const res = await fetch(origin + path, { method, headers });
      assert.equal(res.status, 401, path);
      assert.match(res.headers.get('content-type'), /^application\/json/);
      assert.equal((await res.json()).code, 'unauthorized');
    }
  }
  assert.equal(mutations, 0);
  const capabilities = await fetch(origin + '/v1/capabilities', { headers: { 'X-Task-Bridge-Token': token } });
  assert.equal(capabilities.status, 200);
  assert.equal((await capabilities.json()).ok, true);
  for (const dispose of disposers) await dispose();
  assert.equal((await fetch(origin + '/v1/capabilities')).status, 404);
  await assert.rejects(discoverBridgeOrigin(tokenFile), /No live/);
});

test('explicit fixed URL takes precedence even with no discovery record', () => {
  const stdout = execFileSync(process.execPath, [fileURLToPath(new URL('../scripts/dsh-bridge-url.mjs', import.meta.url))], {
    encoding: 'utf8',
    env: { ...process.env, TASK_BRIDGE_URL: 'http://127.0.0.1:43120/', TASK_BRIDGE_TOKEN_FILE: join(tmpdir(), randomUUID()) },
  });
  assert.equal(stdout.trim(), 'http://127.0.0.1:43120');
});
