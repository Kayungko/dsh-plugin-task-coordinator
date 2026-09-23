/**
 * policy.mjs — 桥侧策略闸：spawn 准入的滚动窗口限流（纯模块，时钟可注入）。
 *
 * 固定契约⑦：默认 60s 窗口内最多 10 次 spawn（config spawnWindowMs /
 * spawnMaxPerWindow 可调），超限返回 policy-gated（HTTP 429）。
 *
 * 设计依据（research/task-bridge-reanchoring.md §3.3.3）：MVP 桥只用单发
 * spawnTask（无 coordinator 侧确认门——门只在 spawnBatch），但桥侧自补策略闸，
 * 堵住「外部驱动方用串行单发绕过批量确认」的治理漏洞；语义对齐 coordinator 的
 * confirmBatchThreshold 精神。二期走 /v1/confirm 直通弹卡通道。
 *
 * 计数口径：「到达 ops 调用层的 spawn 尝试」——失败尝试同样占用配额（防爆破
 * 绕过）；其余端点（send/wait/progress/list/models）不经此闸。
 */

export class RollingWindowGate {
  /**
   * @param {{ windowMs: number, max: number }} options 窗口长度与配额
   * @param {() => number} now 可注入时钟（测试用），默认 Date.now
   */
  constructor({ windowMs, max }, now = () => Date.now()) {
    if (!Number.isInteger(windowMs) || windowMs <= 0) {
      throw new TypeError('RollingWindowGate: windowMs must be a positive integer');
    }
    if (!Number.isInteger(max) || max <= 0) {
      throw new TypeError('RollingWindowGate: max must be a positive integer');
    }
    this.windowMs = windowMs;
    this.max = max;
    this.now = now;
    /** @type {number[]} 窗口内已准入的 spawn 时间戳（升序） */
    this.admitted = [];
  }

  /** 裁剪过期项，返回窗口内当前占用数。 */
  #prune(t) {
    this.admitted = this.admitted.filter((ts) => t - ts < this.windowMs);
    return this.admitted.length;
  }

  /** 窗口内已占用数（先裁剪过期项；只读，不占用配额）。 */
  get size() {
    return this.#prune(this.now());
  }

  /**
   * 尝试准入一次 spawn。准入成功即占用一个配额（记当前时间戳）。
   * @returns {{ ok: true } | { ok: false, retryAfterMs: number }}
   *   retryAfterMs = 最旧一项滑出窗口所需的毫秒数（>=1）。
   */
  tryAcquire() {
    const t = this.now();
    const used = this.#prune(t);
    if (used >= this.max) {
      const oldest = this.admitted[0];
      // 裁剪后所有留存项满足 t - oldest < windowMs，故差值恒 >=1；Math.max 兜底。
      // 语义：最旧一项在 t = oldest + windowMs 时滑出窗口，距今 windowMs - (t - oldest) ms。
      return { ok: false, retryAfterMs: Math.max(1, this.windowMs - (t - oldest)) };
    }
    this.admitted.push(t);
    return { ok: true };
  }
}
