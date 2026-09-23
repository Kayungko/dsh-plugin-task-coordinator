// bridge-toggle.test.mjs — 0.27.0 实验外部桥：设置归一化 + 热挂载/卸载状态机。
// 离线单测：fake ctx/webServer/定时器，不碰宿主与真桥（wire 契约由 smoke 覆盖）。
import test from 'node:test';
import assert from 'node:assert/strict';
import z from '@deepseek-ai/schemastery';

import {
  normalizeBridgeSection,
  validateSpawnModelsSection,
  SPAWN_MODELS_BASE,
  buildSpawnModelsSchema,
} from '../settings.mjs';
import { createBridgeSupervisor, mountExternalBridge, resolveConfig, BRIDGE_UNMOUNT_DRAIN_MS } from '../bridge-runtime.mjs';
import { ENDPOINTS } from '../bridge-endpoints.mjs';

// ---------------------------------------------------------------------------
// 设置段归一化 / 校验
// ---------------------------------------------------------------------------

test('normalizeBridgeSection：缺席/畸形一律默认关', () => {
  for (const value of [undefined, null, 'x', [], 42, {}]) {
    const norm = normalizeBridgeSection(value);
    assert.equal(norm.enabled, false);
    assert.equal(norm.tokenFile, undefined);
  }
  // 严格 true 才开（字符串 "true" / 1 都不算）
  assert.equal(normalizeBridgeSection({ bridgeEnabled: 'true' }).enabled, false);
  assert.equal(normalizeBridgeSection({ bridgeEnabled: 1 }).enabled, false);
  assert.equal(normalizeBridgeSection({ bridgeEnabled: true }).enabled, true);
});

test('normalizeBridgeSection：tokenFile 只收非空字符串并 trim', () => {
  assert.equal(normalizeBridgeSection({ bridgeTokenFile: '   ' }).tokenFile, undefined);
  assert.equal(normalizeBridgeSection({ bridgeTokenFile: 7 }).tokenFile, undefined);
  assert.equal(normalizeBridgeSection({ bridgeTokenFile: '  C:/x/tok  ' }).tokenFile, 'C:/x/tok');
});

test('validateSpawnModelsSection：实验字段类型校验在写边界', () => {
  assert.doesNotThrow(() => validateSpawnModelsSection({ bridgeEnabled: false, bridgeTokenFile: '' }));
  assert.doesNotThrow(() => validateSpawnModelsSection({ provider: 'p', model: 'm', bridgeEnabled: true }));
  assert.throws(() => validateSpawnModelsSection({ bridgeEnabled: 'yes' }), /bridgeEnabled/);
  assert.throws(() => validateSpawnModelsSection({ bridgeTokenFile: 3 }), /bridgeTokenFile/);
});

test('schema/base：实验字段默认关、默认空路径', () => {
  assert.equal(SPAWN_MODELS_BASE.bridgeEnabled, false);
  assert.equal(SPAWN_MODELS_BASE.bridgeTokenFile, '');
  const schema = buildSpawnModelsSchema(z);
  const shape = schema.parse ? schema.parse({}) : null;
  if (shape) {
    assert.equal(shape.bridgeEnabled, false);
    assert.equal(shape.bridgeTokenFile, '');
  }
});

// ---------------------------------------------------------------------------
// supervisor 状态机（fake 定时器）
// ---------------------------------------------------------------------------

function makeWorld({ enabled = false, tokenFile } = {}) {
  const prefs = { enabled, tokenFile };
  const routes = [];
  const disposed = [];
  let mountCalls = 0;
  let mountError = null;
  const timers = [];
  const fakeSetTimeout = (fn, ms) => { timers.push({ fn, ms }); return timers.length - 1; };
  const fakeClearTimeout = (id) => { if (timers[id]) timers[id].cancelled = true; };
  const fireTimers = () => {
    for (const t of timers.splice(0)) if (!t.cancelled) t.fn();
  };
  const wsCtx = {
    webServer: { register: (r) => routes.push(r), host: '127.0.0.1' },
    effect: (fn, label) => { fn(); return () => { disposed.push(label); }; },
    logger: { info: () => {}, warn: () => {} },
    get: () => undefined,
  };
  const sup = createBridgeSupervisor({
    readPrefs: () => ({ ...prefs }),
    mount: (ctx) => {
      mountCalls += 1;
      if (mountError) throw mountError;
      return mountExternalBridge(ctx, resolveConfig({}));
    },
    logger: { info: () => {}, warn: () => {} },
    setTimeoutFn: fakeSetTimeout,
    clearTimeoutFn: fakeClearTimeout,
  });
  return { prefs, routes, disposed, timers, fireTimers, wsCtx, sup, get mountCalls() { return mountCalls; }, setMountError: (e) => { mountError = e; } };
}

test('supervisor：默认关不挂载；attach 后开=挂 7 路由', () => {
  const w = makeWorld();
  w.sup.attach(w.wsCtx);
  assert.deepEqual(w.sup.state(), { mounted: false, draining: false });
  assert.equal(w.routes.length, 0);
  w.prefs.enabled = true;
  w.sup.reconcile();
  assert.equal(w.routes.length, ENDPOINTS.length);
  assert.equal(w.sup.state().mounted, true);
  // 重复 reconcile 不重复挂载
  w.sup.reconcile();
  assert.equal(w.mountCalls, 1);
});

test('supervisor：关=drain 后卸载；drain 内重开=取消卸载', () => {
  const w = makeWorld({ enabled: true });
  w.sup.attach(w.wsCtx);
  assert.equal(w.sup.state().mounted, true);
  w.prefs.enabled = false;
  w.sup.reconcile();
  assert.deepEqual(w.sup.state(), { mounted: false, draining: true });
  assert.equal(w.timers[0].ms, BRIDGE_UNMOUNT_DRAIN_MS);
  assert.equal(w.disposed.length, 0); // drain 期间路由仍在
  // drain 内重开：取消卸载，路由保持挂载
  w.prefs.enabled = true;
  w.sup.reconcile();
  assert.equal(w.sup.state().mounted, true);
  assert.equal(w.disposed.length, 0);
  assert.equal(w.mountCalls, 1);
  w.fireTimers(); // 被取消的定时器不应处置任何东西
  assert.equal(w.disposed.length, 0);
  // 再关：drain 到期真正卸载
  w.prefs.enabled = false;
  w.sup.reconcile();
  w.fireTimers();
  assert.equal(w.disposed.length, ENDPOINTS.length);
  assert.deepEqual(w.sup.state(), { mounted: false, draining: false });
});

test('supervisor：mount 抛错只降级不抛出', () => {
  const w = makeWorld({ enabled: true });
  w.setMountError(new Error('webserver exploded'));
  assert.doesNotThrow(() => w.sup.attach(w.wsCtx));
  assert.deepEqual(w.sup.state(), { mounted: false, draining: false });
  // 修复后下一次 reconcile 能挂上
  w.setMountError(null);
  w.sup.reconcile();
  assert.equal(w.sup.state().mounted, true);
});

test('supervisor：dispose 立即卸载 mounted 与 draining 两态', () => {
  const w = makeWorld({ enabled: true });
  w.sup.attach(w.wsCtx);
  w.sup.dispose();
  assert.equal(w.disposed.length, ENDPOINTS.length);
  const w2 = makeWorld({ enabled: true });
  w2.sup.attach(w2.wsCtx);
  w2.prefs.enabled = false;
  w2.sup.reconcile(); // draining
  w2.sup.dispose();
  assert.equal(w2.disposed.length, ENDPOINTS.length);
  assert.equal(w2.timers.every((t) => t.cancelled), true);
});
