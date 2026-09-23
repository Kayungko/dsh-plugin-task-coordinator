import { readFileSync } from 'node:fs';
const BRIDGE_VERSION = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version;
/**
 * endpoints.mjs — 端点实现：包装 task-coordinator ops 调用面，错误映射到桥信封。
 * 纯模块：无宿主/无 @deepseek-ai import；ops 经 deps.getCoordinator() 惰性解析。
 *
 * 中间件链（每路由 handler 内联，顺序即固定契约）：
 *   ① 回环自检   非回环 remoteAddress → 403 unauthorized + 记 warn 日志
 *   ② 方法白名单 不符 → 405 + allow 头（bad-request）
 *   ③ body 限长·预检 Content-Length 头：非法 400 / 超限 413（forbidden-body）
 *   ④ token 恒时比较 重复/畸形头 400；缺失/错值 401；token 文件不可用 503
 *   ⑤ body 读取   流式累计上限 413 + fatal UTF-8 400 + JSON 形态 400
 *   ⑥ 端点分发   策略闸（spawn）/ 字段校验 / ops 调用 / 信封映射
 *
 * 防御骨架逐条照抄官方先例 @deepseek-ai/dsh-webhook-github（lib/index.js）：
 * readBoundedUtf8Body（CL 预检 + 流式双保险 + fatal UTF-8）、isJsonContentType、
 * 静态错误文案不回显请求数据、503 兜底。差异：凭据从 credential-ref 改为 token
 * 文件（蓝图 §2.4 项3——credential-ref 是宿主 env 引用，外部进程读不到）。
 *
 * 服务缝消费契约见 task-coordinator docs/PROTOCOL.md §17.2：只读 ops、不 provide
 * 同名、伪 caller、reportBack 强制 false、6 方法白名单收敛。
 */

import { homedir } from 'node:os';

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/** 伪 caller（PROTOCOL §17.2 约定 5）：桥无 agent 上下文，合成稳定身份。
 *  checkCaller 只校验 sessionId 非空 + origin ≠ 'subagent'，可通过。稳定 id 使
 *  registry parentSessionId / 消息 senderSessionId 落伪 id（审计可辨），spawn
 *  恒 depth 1。origin 取 undefined，精确匹配 PROTOCOL §17.2 的示例形状。 */
export const BRIDGE_CALLER_SESSION_ID = 'task-bridge-external';
export const BRIDGE_CALLER_ORIGIN = undefined;

/** 鉴权头小写键（与 bridge-auth.mjs 一致；此处复声明避免 endpoints 反向依赖 auth）。 */
const TOKEN_HEADER_KEY = 'x-task-bridge-token';

/** wait 单次封顶（固定契约⑤：≤50000ms，对齐 Codex MCP tool_timeout_sec 默认 60s，
 *  留序列化余量）。蓝图 §3.2 修订 0905 的 5 分钟封顶。 */
export const WAIT_MAX_TIMEOUT_MS = 50000;
/** wait 缺省时长（推荐 45-50s，取 45s 留余量）。 */
export const WAIT_DEFAULT_TIMEOUT_MS = 45000;

/** 桥信封 code 稳定枚举（固定契约②，三任务共用，不得增删改）。 */
export const ENVELOPE_CODES = Object.freeze({
  UNAUTHORIZED: 'unauthorized',
  FORBIDDEN_BODY: 'forbidden-body',
  BAD_REQUEST: 'bad-request',
  POLICY_GATED: 'policy-gated',
  RATE_LIMITED: 'rate-limited',
  QUEUE_FULL: 'queue-full',
  NOT_FOUND: 'not-found',
  UPSTREAM_ERROR: 'upstream-error',
});

/** MVP 端点收敛清单（research/task-bridge-reanchoring.md §0.2 的 6 个 ✅ 行）。
 *  cancel/confirm/spawn_batch 为第二批（§0.2 ⏸），transcript 已砍（§3.1）。 */
export const ENDPOINTS = Object.freeze([
  Object.freeze({ path: '/v1/spawn', method: 'POST', kind: 'spawn' }),
  Object.freeze({ path: '/v1/send', method: 'POST', kind: 'send' }),
  Object.freeze({ path: '/v1/progress', method: 'GET', kind: 'progress' }),
  Object.freeze({ path: '/v1/wait', method: 'GET', kind: 'wait' }),
  Object.freeze({ path: '/v1/list', method: 'GET', kind: 'list' }),
  Object.freeze({ path: '/v1/models', method: 'GET', kind: 'models' }),
  Object.freeze({ path: '/v1/capabilities', method: 'GET', kind: 'capabilities' }),
]);

/** ops 失败码 → [桥信封 code, HTTP status]。未列出的 ops 码一律 upstream-error/500。
 *  原始 ops 码经信封 `upstreamCode` 字段保留，便于诊断。映射依据蓝图 §3.2/§3.3。 */
const OPS_CODE_MAP = Object.freeze({
  'bad-request': [ENVELOPE_CODES.BAD_REQUEST, 400],
  'rate-limited': [ENVELOPE_CODES.RATE_LIMITED, 429],
  'queue-full': [ENVELOPE_CODES.QUEUE_FULL, 429],
  // target-busy：瞬时重试类 → rate-limited；原始码经 upstreamCode 保留（蓝图 §3.2 项4 记 409，
  // 但信封 code 枚举无 target-busy，归最接近的重试型 code）
  'target-busy': [ENVELOPE_CODES.RATE_LIMITED, 429],
  'target-not-found': [ENVELOPE_CODES.NOT_FOUND, 404],
  'target-vanished': [ENVELOPE_CODES.NOT_FOUND, 404],
  'target-invalid': [ENVELOPE_CODES.BAD_REQUEST, 400],
  'target-cold': [ENVELOPE_CODES.BAD_REQUEST, 400],
  'self-send-denied': [ENVELOPE_CODES.BAD_REQUEST, 400],
  'subagent-target-denied': [ENVELOPE_CODES.BAD_REQUEST, 400],
  // 客户端选了不存在的模型路线（应先 GET /v1/models 查目录）
  'model-unavailable': [ENVELOPE_CODES.BAD_REQUEST, 400],
  // 以下两类说明伪 caller 构造被 coordinator 侧拒绝——桥侧集成故障
  'subagent-caller-denied': [ENVELOPE_CODES.UPSTREAM_ERROR, 502],
  'caller-unknown': [ENVELOPE_CODES.UPSTREAM_ERROR, 502],
  'resolve-failed': [ENVELOPE_CODES.UPSTREAM_ERROR, 502],
  // 孤儿会话已建但后续失败——upstreamCode + sessionId 透传供外部驱动方补救
  'model-select-failed': [ENVELOPE_CODES.UPSTREAM_ERROR, 502],
  'spawn-create-failed': [ENVELOPE_CODES.UPSTREAM_ERROR, 502],
  'kickoff-rejected': [ENVELOPE_CODES.UPSTREAM_ERROR, 502],
  'wait-failed': [ENVELOPE_CODES.UPSTREAM_ERROR, 500],
  // coordinator 侧深度治理（桥 spawn 恒 depth 1，正常不触发）
  'spawn-depth-exceeded': [ENVELOPE_CODES.POLICY_GATED, 429],
  'catalog-unavailable': [ENVELOPE_CODES.UPSTREAM_ERROR, 503],
});

// ---------------------------------------------------------------------------
// 防御骨架（照抄 dsh-webhook-github）
// ---------------------------------------------------------------------------

/** 桥内部拒绝异常：status + 信封 code + 静态文案（不回显请求数据）。 */
class HttpRefusal extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'HttpRefusal';
    this.status = status;
    this.code = code;
  }
}

/** 远端地址是否回环（含 IPv4-mapped 形态）。缺地址一律按非回环处理（fail-closed）。
 *  蓝图 §2.4 项6：webserver Config 允许 0.0.0.0，桥不假设宿主恒回环，逐请求自检。 */
export function isLoopbackAddress(remoteAddress) {
  if (typeof remoteAddress !== 'string' || remoteAddress.length === 0) return false;
  return remoteAddress === '127.0.0.1' || remoteAddress === '::1' || remoteAddress.startsWith('::ffff:127.');
}

/** Content-Type 是否 application/json（至多一个 utf-8 charset 参数）——照抄 webhook-github。 */
function isJsonContentType(value) {
  if (value === undefined) return false;
  const [mediaType, parameter, ...extra] = value.split(';').map((part) => part.trim());
  if (mediaType?.toLowerCase() !== 'application/json') return false;
  if (parameter === undefined) return true;
  return extra.length === 0 && /^charset=(?:utf-8|"utf-8")$/i.test(parameter);
}

/** 解析十进制 Content-Length；非法 400、不安全整数 413——照抄 webhook-github。 */
function contentLength(request) {
  const value = request.headers?.['content-length'];
  if (value === undefined) return undefined;
  if (!/^(0|[1-9]\d*)$/.test(value)) {
    throw new HttpRefusal(400, ENVELOPE_CODES.FORBIDDEN_BODY, 'invalid Content-Length');
  }
  const length = Number(value);
  if (!Number.isSafeInteger(length)) {
    throw new HttpRefusal(413, ENVELOPE_CODES.FORBIDDEN_BODY, 'request body is too large');
  }
  return length;
}

/** 有界读取请求体（CL 预检 + 流式累计双保险 + fatal UTF-8）——照抄 webhook-github。 */
async function readBoundedUtf8Body(request, maxBodyBytes) {
  const declared = contentLength(request);
  if (declared !== undefined && declared > maxBodyBytes) {
    request.resume?.();
    throw new HttpRefusal(413, ENVELOPE_CODES.FORBIDDEN_BODY, 'request body is too large');
  }
  const chunks = [];
  let size = 0;
  try {
    for await (const raw of request) {
      const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
      size += chunk.byteLength;
      if (size > maxBodyBytes) {
        request.resume?.();
        throw new HttpRefusal(413, ENVELOPE_CODES.FORBIDDEN_BODY, 'request body is too large');
      }
      chunks.push(chunk);
    }
  } catch (error) {
    if (error instanceof HttpRefusal) throw error;
    throw new HttpRefusal(400, ENVELOPE_CODES.FORBIDDEN_BODY, 'request body was aborted');
  }
  if (!request.complete) {
    throw new HttpRefusal(400, ENVELOPE_CODES.FORBIDDEN_BODY, 'request body was aborted');
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, size));
  } catch {
    throw new HttpRefusal(400, ENVELOPE_CODES.FORBIDDEN_BODY, 'request body is not valid UTF-8');
  }
}

// ---------------------------------------------------------------------------
// 信封 / 应答
// ---------------------------------------------------------------------------

/** 发送一次 JSON 信封应答（幂等安全：客户端已断开/已写完时静默吞掉）。 */
function sendJson(res, status, payload, extraHeaders) {
  try {
    if (res.writableEnded === true || res.destroyed === true) return;
    const body = JSON.stringify(payload);
    if (res.headersSent !== true) {
      res.writeHead(status, {
        ...(extraHeaders ?? {}),
        'content-type': 'application/json; charset=utf-8',
        'content-length': String(Buffer.byteLength(body)),
      });
    }
    res.end(body);
  } catch {
    /* 客户端已断开：无事可做（不回显、不记敏感数据） */
  }
}

/** 失败信封 {ok:false, code, error, ...extra}（extra 用于透传补救字段）。 */
function failEnvelope(code, error, extra) {
  return { ok: false, code, error, ...(extra ?? {}) };
}

/** 构造伪 caller。cwd 解析链（固定契约⑥）：请求 cwd ?? 配置 defaultCwd ?? 用户主目录。 */
export function makeCaller(requestCwd, config) {
  const pick = (value) => (typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined);
  const cwd = pick(requestCwd) ?? pick(config?.defaultCwd) ?? homedir();
  return { sessionId: BRIDGE_CALLER_SESSION_ID, origin: BRIDGE_CALLER_ORIGIN, cwd };
}

// ---------------------------------------------------------------------------
// 请求输入解析
// ---------------------------------------------------------------------------

/** 解析查询串（url 异常归 bad-request）。 */
function searchParams(request) {
  try {
    return new URL(request.url ?? '/', 'http://bridge.local').searchParams;
  } catch {
    throw new HttpRefusal(400, ENVELOPE_CODES.BAD_REQUEST, 'unparseable request URL');
  }
}

function requireString(value, name) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new HttpRefusal(400, ENVELOPE_CODES.BAD_REQUEST, `missing required field: ${name}`);
  }
  return value.trim();
}

function optionalString(value, name) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') {
    throw new HttpRefusal(400, ENVELOPE_CODES.BAD_REQUEST, `field ${name} must be a string`);
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/** externalRef 上限（wire 契约 C1，v0.2.0）：trim 后 ≤200 字符。 */
export const EXTERNAL_REF_MAX_CHARS = 200;

/**
 * 解析 /v1/spawn 的可选 externalRef（wire 契约 C1，dshq-ledger-mailbox-spec
 * Part C，两端锁死）：string、可选、trim 后 ≤200 字符；空串/仅空白视为缺席；
 * 非字符串或超长 → bad-request。null/undefined 与其他可选字段同规视为缺席
 * （optionalString 既定惯例）。语义=自由文本（建议 `<thread短id>:<波次名>`），
 * 桥只校验透传，不解析。
 */
function optionalExternalRef(value) {
  const trimmed = optionalString(value, 'externalRef'); // 非字符串（null/undefined 除外）→ bad-request
  if (trimmed !== undefined && trimmed.length > EXTERNAL_REF_MAX_CHARS) {
    throw new HttpRefusal(400, ENVELOPE_CODES.BAD_REQUEST, `field externalRef must be at most ${EXTERNAL_REF_MAX_CHARS} characters after trim`);
  }
  return trimmed;
}

function parseJsonBody(bodyText) {
  let parsed;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    throw new HttpRefusal(400, ENVELOPE_CODES.FORBIDDEN_BODY, 'request body is not valid JSON');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new HttpRefusal(400, ENVELOPE_CODES.FORBIDDEN_BODY, 'request body must be a JSON object');
  }
  return parsed;
}

function booleanParam(params, name) {
  const raw = params.get(name);
  if (raw === null || raw === 'false' || raw === '0') return false;
  if (raw === 'true' || raw === '1') return true;
  throw new HttpRefusal(400, ENVELOPE_CODES.BAD_REQUEST, `${name} (query) must be true or false`);
}

/**
 * 解析端点输入：POST 读 body（Content-Type 收窄 + 有界读取 + JSON 形态 + 字段校验）；
 * GET 解析查询串。校验失败抛 HttpRefusal（bad-request / forbidden-body）。
 */
async function parseEndpointInput(endpoint, request, config) {
  if (endpoint.method === 'POST') {
    if (!isJsonContentType(request.headers?.['content-type'])) {
      request.resume?.();
      throw new HttpRefusal(415, ENVELOPE_CODES.FORBIDDEN_BODY, 'content type must be application/json');
    }
    const bodyText = await readBoundedUtf8Body(request, config.maxBodyBytes);
    const body = parseJsonBody(bodyText);
    if (endpoint.kind === 'spawn') {
      // 注意：客户端的 reportBack 一律忽略——桥强制 false（PROTOCOL §17.2 约定5，结构性必须）
      return {
        prompt: requireString(body.prompt, 'prompt'),
        title: optionalString(body.title, 'title'),
        cwd: optionalString(body.cwd, 'cwd'),
        team: optionalString(body.team, 'team'),
        sessionId: optionalString(body.sessionId, 'sessionId'),
        provider: optionalString(body.provider, 'provider'),
        model: optionalString(body.model, 'model'),
        reasoningEffort: optionalString(body.reasoningEffort, 'reasoningEffort'),
        // externalRef（v0.2.0，wire 契约 C1）：外部派发方的自由文本对应标识
        externalRef: optionalExternalRef(body.externalRef),
      };
    }
    if (endpoint.kind === 'send') {
      const mode = body.mode === undefined ? 'queue' : body.mode;
      if (mode !== 'queue' && mode !== 'steer') {
        throw new HttpRefusal(400, ENVELOPE_CODES.BAD_REQUEST, "field mode must be 'queue' or 'steer'");
      }
      return {
        sessionId: requireString(body.sessionId, 'sessionId'),
        text: requireString(body.text, 'text'),
        mode,
        reference: optionalString(body.reference, 'reference'),
      };
    }
    throw new Error(`unreachable: POST endpoint kind ${endpoint.kind}`);
  }

  // GET 端点
  const params = searchParams(request);
  request.resume?.();
  if (endpoint.kind === 'progress') {
    return { sessionId: requireString(params.get('sessionId'), 'sessionId (query)'),
      cursor: optionalString(params.get('cursor'), 'cursor'), messageId: optionalString(params.get('messageId'), 'messageId') };
  }
  if (endpoint.kind === 'wait') {
    const ids = [...params.getAll('sessionId')];
    const combined = params.get('sessionIds');
    if (combined !== null) {
      for (const part of combined.split(',')) {
        const trimmed = part.trim();
        if (trimmed.length > 0) ids.push(trimmed);
      }
    }
    if (ids.length === 0) {
      throw new HttpRefusal(400, ENVELOPE_CODES.BAD_REQUEST, 'sessionId or sessionIds (query) is required');
    }
    const rawTimeout = params.get('timeoutMs');
    let timeoutMs = WAIT_DEFAULT_TIMEOUT_MS;
    if (rawTimeout !== null) {
      const n = Number(rawTimeout);
      if (!Number.isInteger(n) || n < 1) {
        throw new HttpRefusal(400, ENVELOPE_CODES.BAD_REQUEST, 'timeoutMs (query) must be a positive integer');
      }
      timeoutMs = Math.min(n, WAIT_MAX_TIMEOUT_MS); // 固定契约⑤：单次封顶 ≤50000ms
    }
    const mode = params.get('mode') ?? 'all';
    if (mode !== 'all' && mode !== 'any') {
      throw new HttpRefusal(400, ENVELOPE_CODES.BAD_REQUEST, "mode (query) must be 'all' or 'any'");
    }
    return { sessionIds: ids, timeoutMs, mode };
  }
  if (endpoint.kind === 'list') {
    const rawLimit = params.get('limit');
    let limit = 50;
    if (rawLimit !== null) {
      const n = Number(rawLimit);
      if (!Number.isInteger(n) || n < 1 || n > 500) {
        throw new HttpRefusal(400, ENVELOPE_CODES.BAD_REQUEST, 'limit (query) must be an integer in 1..500');
      }
      limit = n;
    }
    return {
      filter: optionalString(params.get('filter'), 'filter'),
      team: optionalString(params.get('team'), 'team'),
      includeSubagents: booleanParam(params, 'includeSubagents'),
      ungrouped: booleanParam(params, 'ungrouped'),
      limit,
    };
  }
  if (endpoint.kind === 'models' || endpoint.kind === 'capabilities') return {};
  throw new Error(`unreachable: GET endpoint kind ${endpoint.kind}`);
}

// ---------------------------------------------------------------------------
// ops 调用与信封映射
// ---------------------------------------------------------------------------

/**
 * 调用一个 ops 方法并把结果映射成桥信封。
 * 服务缺席 / 无 ops（coordinator disabled）→ 503（PROTOCOL §17.1 降级信号）。
 * @returns {Promise<{ status: number, payload: object, extraHeaders?: object }>}
 */
async function callOps(deps, method, args) {
  const service = deps.getCoordinator();
  const ops = service?.ops;
  if (!ops || typeof ops[method] !== 'function') {
    return {
      status: 503,
      payload: failEnvelope(
        ENVELOPE_CODES.UPSTREAM_ERROR,
        'task coordinator ops unavailable — install/enable dsh-plugin-task-coordinator (0.24.0+ service seam: provide payload with ops) first',
      ),
    };
  }
  let raw;
  try {
    raw = await ops[method](...args);
  } catch (error) {
    deps.logger?.warn?.(`task-bridge: ops.${method} threw: ${error?.message ?? error}`);
    return { status: 500, payload: failEnvelope(ENVELOPE_CODES.UPSTREAM_ERROR, 'task coordinator operation failed') };
  }
  if (raw && typeof raw === 'object' && raw.ok === true) {
    return { status: 200, payload: raw };
  }
  if (raw && typeof raw === 'object' && raw.ok === false && typeof raw.code === 'string') {
    const [code, status] = OPS_CODE_MAP[raw.code] ?? [ENVELOPE_CODES.UPSTREAM_ERROR, 500];
    const payload = failEnvelope(
      code,
      typeof raw.error === 'string' && raw.error.length > 0 ? raw.error : 'task coordinator operation failed',
      { upstreamCode: raw.code },
    );
    // 保留 ops 失败回执中的补救字段（如 model-select-failed / kickoff-rejected
    // 携带的孤儿 sessionId / depth / team），外部驱动方需要它做补救（蓝图 §3.3.1）。
    for (const [key, value] of Object.entries(raw)) {
      if (key !== 'ok' && key !== 'code' && key !== 'error' && !(key in payload)) payload[key] = value;
    }
    // rate-limited 附结构化 retryAfterMs（PROTOCOL §17.1：从 config.minSendIntervalMs 计算）
    let extraHeaders;
    if (raw.code === 'rate-limited') {
      const interval = service?.config?.minSendIntervalMs;
      if (Number.isInteger(interval) && interval > 0) {
        payload.retryAfterMs = interval;
        extraHeaders = { 'retry-after': String(Math.ceil(interval / 1000)) };
      }
    }
    return { status, payload, ...(extraHeaders ? { extraHeaders } : {}) };
  }
  deps.logger?.warn?.(`task-bridge: ops.${method} returned an unrecognized result`);
  return { status: 500, payload: failEnvelope(ENVELOPE_CODES.UPSTREAM_ERROR, 'task coordinator returned an unrecognized result') };
}

/** 执行端点业务（策略闸 + ops 调用）。返回 {status, payload, extraHeaders?}。 */
async function executeEndpoint(endpoint, deps, input, response) {
  switch (endpoint.kind) {
    case 'capabilities': {
      const service = deps.getCoordinator();
      const enabled = !!service?.ops;
      return { status: 200, payload: { ok: true, protocolVersion: 1, bridgeVersion: BRIDGE_VERSION,
        coordinatorVersion: typeof service?.version === 'string' ? service.version : null, coordinatorEnabled: enabled,
        capabilities: enabled ? { ...(service.capabilities ?? {}) } : {},
        endpoints: ENDPOINTS.map(e => e.path), limits: { waitMaxMs: WAIT_MAX_TIMEOUT_MS,
          spawnMaxPerWindow: deps.config.spawnMaxPerWindow, spawnWindowMs: deps.config.spawnWindowMs },
        reportBack: false, cwdDefault: 'bridge-config-or-user-home',
      } };
    }
    case 'spawn': {
      // 策略闸（固定契约⑦）：先于 ops 调用；被闸的请求不消耗 ops，也不到达 coordinator
      const admission = deps.gate.tryAcquire();
      if (!admission.ok) {
        const retrySeconds = String(Math.ceil(admission.retryAfterMs / 1000));
        return {
          status: 429,
          payload: failEnvelope(
            ENVELOPE_CODES.POLICY_GATED,
            `spawn rate policy: at most ${deps.config.spawnMaxPerWindow} spawns per ${deps.config.spawnWindowMs}ms window; retry after ~${retrySeconds}s`,
            { retryAfterMs: admission.retryAfterMs },
          ),
          extraHeaders: { 'retry-after': retrySeconds },
        };
      }
      const caller = makeCaller(input.cwd, deps.config);
      const opsArgs = {
        prompt: input.prompt,
        ...(input.title !== undefined ? { title: input.title } : {}),
        ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
        ...(input.team !== undefined ? { team: input.team } : {}),
        ...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}),
        ...(input.provider !== undefined ? { provider: input.provider } : {}),
        ...(input.model !== undefined ? { model: input.model } : {}),
        ...(input.reasoningEffort !== undefined ? { reasoningEffort: input.reasoningEffort } : {}),
        // externalRef（v0.2.0，wire 契约 C1）：透传 ops.spawnTask（0.25.0 起接受
        // 并持久化/回显；coordinator 0.24.x 会静默忽略——peerDependencies 已抬到
        // >=0.25.0）。成功回执经 callOps 原样透传，externalRef 随之回显。
        ...(input.externalRef !== undefined ? { externalRef: input.externalRef } : {}),
        reportBack: false, // 固定契约⑥：结构性强制——伪 caller 非真实会话，回报后缀会指向不存在的目标
      };
      return callOps(deps, 'spawnTask', [opsArgs, caller]);
    }
    case 'send': {
      const caller = makeCaller(undefined, deps.config);
      return callOps(deps, 'sendMessage', [{
        targetId: input.sessionId,
        text: input.text,
        mode: input.mode,
        ...(input.reference !== undefined ? { reference: input.reference } : {}),
      }, caller]);
    }
    case 'progress': {
      if ((input.cursor !== undefined || input.messageId !== undefined) && deps.getCoordinator()?.capabilities?.progressCursor !== true) {
        return { status: 503, payload: failEnvelope(ENVELOPE_CODES.UPSTREAM_ERROR, 'coordinator does not support incremental progress', { upstreamCode: 'capability-unavailable' }) };
      }
      return callOps(deps, 'progress', [input.sessionId, makeCaller(undefined, deps.config), undefined,
        { cursor: input.cursor, messageId: input.messageId }]);
    }
    case 'wait': {
      // 断连即中止（蓝图 §3.2 项2）：res 'close' 且响应未写完 → AbortController.abort()
      // → ops.waitFor 的 aborted 分支即刻释放服务端等待，不留悬挂 Promise。
      const controller = new AbortController();
      const onClose = () => {
        if (response.writableEnded !== true) controller.abort();
      };
      if (typeof response.on === 'function') response.on('close', onClose);
      try {
        return await callOps(deps, 'waitFor', [{
          sessionIds: input.sessionIds,
          timeoutMs: input.timeoutMs,
          mode: input.mode,
          signal: controller.signal,
        }, makeCaller(undefined, deps.config)]);
      } finally {
        if (typeof response.off === 'function') response.off('close', onClose);
      }
    }
    case 'list': {
      return callOps(deps, 'listTasks', [{
        ...(input.filter !== undefined ? { filter: input.filter } : {}),
        ...(input.team !== undefined ? { team: input.team } : {}),
        includeSubagents: input.includeSubagents,
        ungrouped: input.ungrouped,
        limit: input.limit,
      }, makeCaller(undefined, deps.config)]);
    }
    case 'models': {
      return callOps(deps, 'models', [{}, makeCaller(undefined, deps.config)]);
    }
    default:
      throw new Error(`unknown endpoint kind: ${endpoint.kind}`);
  }
}

// ---------------------------------------------------------------------------
// handler 工厂（中间件链内联）
// ---------------------------------------------------------------------------

/** Content-Length 预检（只看头，不读 body）：非法 400 / 超限 413。契约链③，先于 token。 */
function preflightContentLength(request, maxBodyBytes) {
  const declared = contentLength(request); // 可能抛 400/413
  if (declared !== undefined && declared > maxBodyBytes) {
    request.resume?.();
    throw new HttpRefusal(413, ENVELOPE_CODES.FORBIDDEN_BODY, 'request body is too large');
  }
}

/**
 * 构造一个端点的完整 HTTP handler（中间件链内联，顺序即固定契约）。
 * @param {{ path: string, method: string, kind: string }} endpoint
 * @param {{ config: object, tokenStore: import('./bridge-auth.mjs').TokenStore,
 *           gate: import('./bridge-policy.mjs').RollingWindowGate,
 *           getCoordinator: () => (object | undefined | null), logger?: object }} deps
 */
export function createEndpointHandler(endpoint, deps) {
  return async (request, response) => {
    try {
      // ① 回环自检：非回环远端直接拒绝并记日志（固定契约⑧）
      const remote = request.socket?.remoteAddress;
      if (!isLoopbackAddress(remote)) {
        deps.logger?.warn?.(`task-bridge: refused non-loopback remote ${remote ?? '(none)'} on ${endpoint.path}`);
        request.resume?.();
        sendJson(response, 403, failEnvelope(ENVELOPE_CODES.UNAUTHORIZED, 'bridge accepts loopback connections only'));
        return;
      }
      // ② 方法白名单
      if (request.method !== endpoint.method) {
        request.resume?.();
        sendJson(response, 405, failEnvelope(ENVELOPE_CODES.BAD_REQUEST, `method not allowed; use ${endpoint.method}`), { allow: endpoint.method });
        return;
      }
      // ③ body 限长·预检（Content-Length 头；先于 token——超大 body 在鉴权前即被拒）
      preflightContentLength(request, deps.config.maxBodyBytes);
      // ④ token 恒时比较（重复/畸形头 400；缺失/错值 401；token 文件不可用 503）
      const headerValues = request.headersDistinct?.[TOKEN_HEADER_KEY];
      if (headerValues !== undefined && (!Array.isArray(headerValues) || headerValues.length !== 1)) {
        request.resume?.();
        sendJson(response, 400, failEnvelope(ENVELOPE_CODES.BAD_REQUEST, 'malformed X-Task-Bridge-Token header (must appear exactly once)'));
        return;
      }
      const presented = headerValues?.[0] ?? request.headers?.[TOKEN_HEADER_KEY];
      const verdict = deps.tokenStore.verify(presented);
      if (!verdict.ok) {
        request.resume?.();
        if (verdict.reason === 'unavailable') {
          sendJson(response, 503, failEnvelope(ENVELOPE_CODES.UPSTREAM_ERROR, 'bridge token is unavailable'));
        } else {
          deps.logger?.warn?.(`task-bridge: unauthorized request on ${endpoint.path}`);
          sendJson(response, 401, failEnvelope(ENVELOPE_CODES.UNAUTHORIZED, 'unauthorized'));
        }
        return;
      }
      // ⑤+⑥ 输入解析（含 body 读取）与端点分发
      const input = await parseEndpointInput(endpoint, request, deps.config);
      const { status, payload, extraHeaders } = await executeEndpoint(endpoint, deps, input, response);
      sendJson(response, status, payload, extraHeaders);
    } catch (error) {
      if (error instanceof HttpRefusal) {
        sendJson(response, error.status, failEnvelope(error.code, error.message));
        return;
      }
      // 兜底：未分类异常 → 503 静态文案 + warn（照 webhook-github，不回显请求数据）
      deps.logger?.warn?.(`task-bridge: handler error on ${endpoint.path}: ${error?.message ?? error}`);
      try { request.resume?.(); } catch { /* 忽略 */ }
      sendJson(response, 500, failEnvelope(ENVELOPE_CODES.UPSTREAM_ERROR, 'bridge internal error'));
    }
  };
}
