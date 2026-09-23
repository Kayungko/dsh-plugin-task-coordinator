// bridge-toggle.test.mjs — 0.27.0 实验外部桥：设置归一化 + 热挂载/卸载状态机。
// 离线单测：fake ctx/webServer/定时器，不碰宿主与真桥（wire 契约由 smoke 覆盖）。
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

// 测试隔离（必须）：mount 回调经 resolveConfig 落到 tokenFile，而 ensureTokenFile
// 在文件缺失时**会写盘**（固定契约①的合并后接替者）。默认路径是真实的
// ~/.dsh/task-bridge-token —— 绝不允许 npm test 往用户主目录写文件，也不允许
// 因作者本机恰好有个遗产 token 文件而让「生成」分支永远测不到。故 makeWorld 的
// tokenFile 默认指向本文件独占的一次性临时目录，跑完整体清理。
const TEST_TMP = mkdtempSync(join(tmpdir(), 'dsh-bridge-toggle-'));
after(() => {
  try { rmSync(TEST_TMP, { recursive: true, force: true }); } catch { /* 尽力清理 */ }
});

function makeWorld({ enabled = false, tokenFile = join(TEST_TMP, 'task-bridge-token') } = {}) {
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
      return mountExternalBridge(ctx, resolveConfig({ tokenFile }));
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

test('supervisor：挂载即确保 token 文件在位（固定契约①接替者，缺文件也能起来）', () => {
  // 用独占探针路径，不依赖测试执行顺序（默认 tokenFile 可能已被其他用例生成）。
  const file = join(TEST_TMP, 'token-ensure-probe');
  assert.equal(existsSync(file), false, '前置：探针路径上还没有 token 文件');

  const w = makeWorld({ enabled: true, tokenFile: file });
  w.sup.attach(w.wsCtx);
  w.sup.reconcile();

  assert.equal(w.routes.length, ENDPOINTS.length, '路由照常挂满');
  assert.equal(existsSync(file), true, '挂载路径必须已生成 token 文件——否则七条路由一律 503 bridge token is unavailable');
  assert.match(readFileSync(file, 'utf8'), /^[0-9a-f]{64}$/u);
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
