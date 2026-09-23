/**
 * auth.mjs — token 文件鉴权（纯模块：无宿主/无 @deepseek-ai import，可离线单测）。
 *
 * 固定契约（三任务共用，不得单方更改）：
 *  - 鉴权头名 `X-Task-Bridge-Token`（HTTP 访问一律小写键）；
 *  - token 文件默认路径 `<用户主目录>/.dsh/task-bridge-token`（本机即
 *    C:\Users\admin\.dsh\task-bridge-token），插件 config `tokenFile` 可覆盖；
 *  - 比较必须恒时：crypto.timingSafeEqual + 长度前置检查，对齐宿主官方先例
 *    dsh-client-connection 的 tokenMatches（lib/index.js:252-255）。
 *
 * 热轮换：current() 以 (mtimeMs, size) 为缓存戳；token 文件被覆写后，下一个
 * 请求即读到新值——轮换 = 直接覆写文件，无需重启宿主（README 安全节详述）。
 *
 * 脱敏红线：本模块绝不把 token 值写进日志/错误消息；错误文案全为静态安全串。
 */

import { readFileSync, statSync } from 'node:fs';
import { timingSafeEqual } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** 鉴权头规范大小写形式（仅用于文档/日志展示；HTTP 读写一律走小写键）。 */
export const TOKEN_HEADER_NAME = 'X-Task-Bridge-Token';

/** 鉴权头的小写键（Node http 模块把头名统一小写）。 */
export const TOKEN_HEADER_KEY = 'x-task-bridge-token';

/** token 文件默认路径：<用户主目录>/.dsh/task-bridge-token（契约固定）。 */
export function defaultTokenFile() {
  return join(homedir(), '.dsh', 'task-bridge-token');
}

/**
 * 恒时比较两个 token 字符串。
 * 照宿主官方 tokenMatches 先例：长度不等直接判否（长度本身不属于秘密），
 * 长度相等才走 timingSafeEqual；任一侧为空串视为不匹配（防「空 token 通过」）。
 * @param {unknown} actual 请求头携带的值
 * @param {unknown} expected token 文件中的值
 * @returns {boolean}
 */
export function tokenMatches(actual, expected) {
  if (typeof actual !== 'string' || typeof expected !== 'string') return false;
  if (actual.length === 0 || expected.length === 0) return false;
  const actualBytes = Buffer.from(actual, 'utf8');
  const expectedBytes = Buffer.from(expected, 'utf8');
  return actualBytes.byteLength === expectedBytes.byteLength && timingSafeEqual(actualBytes, expectedBytes);
}

/**
 * token 文件读取器：stat 戳缓存 + 缺失/空文件显式报因。
 * 结果形态：{ token: string } | { error: 'unavailable' | 'empty', message: string }。
 */
export class TokenStore {
  /** @param {string} filePath token 文件绝对路径 */
  constructor(filePath) {
    this.filePath = filePath;
    /** @type {string | undefined} */
    this.cachedToken = undefined;
    /** @type {string | null} (mtimeMs:size) 缓存戳 */
    this.cachedStamp = null;
  }

  /** @param {import('node:fs').Stats} stat */
  #stampOf(stat) {
    return `${stat.mtimeMs}:${stat.size}`;
  }

  /**
   * 当前 token（或不可用原因）。文件被覆写后自动重读（热轮换）。
   * @returns {{ token: string } | { error: 'unavailable' | 'empty', message: string }}
   */
  current() {
    let stat;
    try {
      stat = statSync(this.filePath);
    } catch {
      return { error: 'unavailable', message: `bridge token file is missing or unreadable: ${this.filePath}` };
    }
    if (!stat.isFile()) {
      return { error: 'unavailable', message: `bridge token file path is not a regular file: ${this.filePath}` };
    }
    const stamp = this.#stampOf(stat);
    if (this.cachedStamp === stamp && this.cachedToken !== undefined) {
      return { token: this.cachedToken };
    }
    let token;
    try {
      token = readFileSync(this.filePath, 'utf8').trim();
    } catch {
      return { error: 'unavailable', message: `bridge token file could not be read: ${this.filePath}` };
    }
    if (token.length === 0) {
      return { error: 'empty', message: `bridge token file exists but is empty: ${this.filePath}` };
    }
    this.cachedToken = token;
    this.cachedStamp = stamp;
    return { token: this.cachedToken };
  }

  /**
   * 校验一个请求头值。token 文件不可用优先于「头缺失」判定（fail-closed：
   * 文件缺失/空时任何请求都无法通过，回 503 而非 401）。
   * @param {unknown} headerValue 请求头原始值（可能 undefined/空/畸形）
   * @returns {{ ok: true } | { ok: false, reason: 'unavailable' | 'unauthorized', message: string }}
   */
  verify(headerValue) {
    const current = this.current();
    if (current.error) {
      // 静态文案，不回显文件路径以外的任何请求数据
      return { ok: false, reason: 'unavailable', message: 'bridge token is unavailable (token file missing, unreadable, or empty)' };
    }
    if (typeof headerValue !== 'string' || headerValue.length === 0) {
      return { ok: false, reason: 'unauthorized', message: `missing ${TOKEN_HEADER_NAME} header` };
    }
    if (!tokenMatches(headerValue, current.token)) {
      return { ok: false, reason: 'unauthorized', message: `invalid ${TOKEN_HEADER_NAME}` };
    }
    return { ok: true };
  }
}
