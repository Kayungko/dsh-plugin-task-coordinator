/**
 * bridge-runtime.mjs — 外部任务桥挂载监管（0.27.0 起由 coordinator 实验开关驱动）。
 *
 * 来源：原独立包 dsh-plugin-task-bridge v0.3.0 的 index.mjs 挂载面，硬切合并进
 * dsh-plugin-task-coordinator（research/bridge-merge-into-coordinator-design.md）。
 * wire 契约冻结：7 exact 路由 / X-Task-Bridge-Token / token 文件默认路径 /
 * 信封形状一律不改——bridge-mcp 与线上 Secure MCP Tunnel 依赖它们。
 *
 * 合并后消失的机制：共享 isolate label 的 Symbol 服务缝与 503 降级语义变为同组
 * 内部调用（getCoordinator 仍走惰性 ctx.get，provider 侧自解析恒可见）。
 * mountExternalBridge 返回 effect disposer 数组；热开关由 createBridgeSupervisor
 * 状态机管理（开=挂载、关=5s drain 后调 disposer 反注册，"关就是关"）。
 *
 * 纯模块：无 @deepseek-ai import，可离线单测（mount 需注入 fake ctx/webServer）。
 */

import { homedir } from 'node:os';
import { TokenStore, defaultTokenFile, TOKEN_HEADER_NAME } from './bridge-auth.mjs';
import { RollingWindowGate } from './bridge-policy.mjs';
import { ENDPOINTS, createEndpointHandler } from './bridge-endpoints.mjs';

/** body 限长默认（固定契约⑧：256KB）。 */
export const DEFAULT_MAX_BODY_BYTES = 256 * 1024;
/** 策略闸滚动窗口默认（固定契约⑦：60s）。 */
export const DEFAULT_SPAWN_WINDOW_MS = 60_000;
/** 策略闸窗口内 spawn 配额默认（固定契约⑦：10 次）。 */
export const DEFAULT_SPAWN_MAX_PER_WINDOW = 10;

/**
 * 配置解析：全部带默认值，错误类型不猜测（对齐 coordinator config.mjs 风格）。
 * 优先级由调用方组合：GUI 设置段 > patch 行 config > 内置默认（0.27.0 合并决策）。
 * @param {unknown} input patch 行 config 或设置段覆盖
 */
export function resolveConfig(input = {}) {
  const source = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const trimmed = (value) => (typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined);
  const positiveInt = (value, fallback) => (Number.isInteger(value) && value > 0 ? value : fallback);
  return {
    tokenFile: trimmed(source.tokenFile) ?? defaultTokenFile(),
    defaultCwd: trimmed(source.defaultCwd) ?? homedir(),
    maxBodyBytes: positiveInt(source.maxBodyBytes, DEFAULT_MAX_BODY_BYTES),
    spawnWindowMs: positiveInt(source.spawnWindowMs, DEFAULT_SPAWN_WINDOW_MS),
    spawnMaxPerWindow: positiveInt(source.spawnMaxPerWindow, DEFAULT_SPAWN_MAX_PER_WINDOW),
  };
}

/**
 * 挂载 7 个 exact 路由到宿主 webserver。
 *
 * 生命周期契约：路由经 ctx.effect 注册，返回的 disposer 数组交调用方管理
 * （createBridgeSupervisor 在开关关 / 插件卸载时调用，自动反注册路由）。
 * 注册期抛错（webServer 缺席等）直接上抛——调用方须自行隔离（supervisor 已
 * 捕获并降级），不得让挂载失败炸掉 coordinator 主 apply（合并风险对策）。
 *
 * @param {object} ctx cordis 插件上下文（需 webServer / effect / logger / get）
 * @param {ReturnType<typeof resolveConfig>} config
 * @returns {Array<() => any>} 每个路由一个 effect disposer（无 effect 面时为空数组）
 */
export function mountExternalBridge(ctx, config) {
  const webServer = ctx.webServer;
  if (!webServer || typeof webServer.register !== 'function') {
    throw new Error('task-bridge: ctx.webServer is unavailable; mount @deepseek-ai/dsh-host-webserver first');
  }

  // 绑定面感知（非阻塞，蓝图 §2.4 项6）：webserver Config 允许 host:'0.0.0.0'——
  // 桥不假设宿主恒回环；运行时逐请求回环守卫才是真防线，此处只做强告警。
  try {
    if (webServer.host === '0.0.0.0') {
      ctx.logger?.warn?.(
        'task-bridge: host webserver binds 0.0.0.0 — the bridge refuses non-loopback remotes per request (token alone is not enough); consider host 127.0.0.1',
      );
    }
  } catch {
    /* host getter 永不阻断挂载 */
  }

  const tokenStore = new TokenStore(config.tokenFile);
  const gate = new RollingWindowGate({ windowMs: config.spawnWindowMs, max: config.spawnMaxPerWindow });
  // 同组服务自解析（合并后无跨组缝）：仍惰性活取，coordinator 自身 provide 的
  // taskCoordinator 恒可见；保留惰性形态以便离线单测注入 fake ctx。
  const getCoordinator = () => (typeof ctx.get === 'function' ? ctx.get('taskCoordinator') : undefined);

  const disposers = [];
  for (const endpoint of ENDPOINTS) {
    const handler = createEndpointHandler(endpoint, { config, tokenStore, gate, getCoordinator, logger: ctx.logger });
    const route = { kind: 'exact', path: endpoint.path, handler };
    // 照 webhook-github 注册模式：ctx.effect(() => webServer.register(route), label)
    // ——effect 返回 single-shot disposer（cordis fiber.ts 签名实证），供热卸载。
    if (typeof ctx.effect === 'function') {
      disposers.push(ctx.effect(() => webServer.register(route), `task-bridge: ${endpoint.path}`));
    } else {
      webServer.register(route); // 无 effect 面时直接注册（丢失热卸载能力，强告警）
    }
  }
  if (disposers.length === 0) {
    ctx.logger?.warn?.('task-bridge: no ctx.effect surface; routes mounted without hot-unmount capability');
  }

  ctx.logger?.info?.(
    `task-bridge: ${ENDPOINTS.length} exact routes mounted on the host webserver (${ENDPOINTS.map((e) => `${e.method} ${e.path}`).join(', ')}); auth ${TOKEN_HEADER_NAME} via ${config.tokenFile}`,
  );
  return disposers;
}

/** 关开关后的卸载 drain 窗口：给在途请求（wait 最长 50s 不可能全覆盖）一个短优雅期。 */
export const BRIDGE_UNMOUNT_DRAIN_MS = 5_000;

/**
 * 实验开关的热挂载/卸载状态机（纯模块，定时器可注入，离线可测）。
 *
 * 状态：mounted（disposers 在手）/ draining（pending + 定时器在跑）/ off。
 *  - reconcile()：读 prefs——开且未挂载且有 webServer ctx → mount；
 *    关且已挂载 → 进入 draining（drainMs 后调 disposer）；
 *    drain 期间重新开 → 取消卸载（路由从未反注册，直接恢复 mounted）。
 *  - attach(wsCtx)：webServer 可选依赖就绪时接入并立即 reconcile。
 *  - dispose()：插件卸载路径——清定时器，mounted+draining 全部立即反注册。
 *  - mount 抛错只记 warn 并保持 off（合并风险对策：桥故障不炸 coordinator）。
 *
 * @param {{ readPrefs: () => { enabled: boolean, tokenFile?: string },
 *           mount: (wsCtx: object) => Array<() => any>,
 *           logger?: object, drainMs?: number,
 *           setTimeoutFn?: Function, clearTimeoutFn?: Function }} deps
 */
export function createBridgeSupervisor({ readPrefs, mount, logger, drainMs = BRIDGE_UNMOUNT_DRAIN_MS, setTimeoutFn = setTimeout, clearTimeoutFn = clearTimeout }) {
  let wsCtx = null;
  /** @type {Array<() => any> | null} mounted 态的 disposer 数组 */
  let disposers = null;
  /** @type {Array<() => any> | null} draining 态待处置的 disposer 数组 */
  let pending = null;
  let timer = null;

  const safeDisposeAll = (list) => {
    for (const dispose of list) {
      try {
        const result = typeof dispose === 'function' ? dispose() : undefined;
        if (result && typeof result.then === 'function') result.catch(() => {}); // disposer 可 awaitable（cordis 签名）
      } catch (error) {
        logger?.warn?.(`task-bridge: route disposer threw: ${error?.message ?? error}`);
      }
    }
  };

  function reconcile() {
    const prefs = readPrefs();
    if (prefs.enabled) {
      if (timer !== null) {
        // drain 期间重新开：路由从未反注册，取消卸载直接恢复 mounted
        clearTimeoutFn(timer);
        timer = null;
        disposers = pending;
        pending = null;
        logger?.info?.('task-bridge: unmount cancelled by re-enable (routes stayed mounted)');
        return;
      }
      if (disposers === null && wsCtx !== null) {
        try {
          disposers = mount(wsCtx) ?? [];
        } catch (error) {
          logger?.warn?.(`task-bridge: mount failed; experimental bridge stays off (${error?.message ?? error})`);
        }
      }
      return;
    }
    if (pending !== null || timer !== null) return; // 已在 draining
    if (disposers !== null) {
      pending = disposers;
      disposers = null;
      timer = setTimeoutFn(() => {
        timer = null;
        const list = pending;
        pending = null;
        if (list) {
          safeDisposeAll(list);
          logger?.info?.('task-bridge: experimental bridge disabled (routes unmounted after drain)');
        }
      }, drainMs);
      logger?.info?.(`task-bridge: experimental bridge toggle off; unmounting routes in ${drainMs}ms`);
    }
  }

  return {
    reconcile,
    /** @param {object} ctx 含 webServer 的 cordis 上下文（ctx.inject 可选依赖回调） */
    attach(ctx) {
      wsCtx = ctx;
      reconcile();
    },
    dispose() {
      if (timer !== null) {
        clearTimeoutFn(timer);
        timer = null;
      }
      const list = [...(disposers ?? []), ...(pending ?? [])];
      disposers = null;
      pending = null;
      safeDisposeAll(list);
    },
    state() {
      return { mounted: disposers !== null, draining: pending !== null };
    },
  };
}
