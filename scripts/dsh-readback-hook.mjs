#!/usr/bin/env node
/**
 * DSH readback hook for Codex（仓库级 .codex/hooks.json 的唯一 handler）。
 *
 * 把 dsh-plugin-task-coordinator ≥0.27.0 内置桥（127.0.0.1:43120）的任务状态
 * 在 Codex 生命周期事件里自动读回模型上下文，补齐 GPT→DSH 写通路之外的
 * DSH→GPT 读回缺口（拉模型 → turn 边界自动注入 + turn 内机械等待）：
 *
 *   UserPromptSubmit  注入环：未读 settled 摘要 + 本会话 watch 内 running 进度
 *   SessionStart      任务板 bootstrap：running + 未读 settled 概览
 *   PostToolUse       登记环（async）：dsh_task_spawn 回执里的 sessionId 记入
 *                     当前 Codex session 的 watch 表（Stop 环的等待对象来源）
 *   Stop              等待环：watch 内仍有 running → exit 2 + stderr 续 turn
 *                     再查（带每 session 续 turn 上限与时间窗上限）
 *
 * 纪律：
 *   - fail-open：任何错误/超时/缺 token 一律输出 {} 退出 0，绝不挡住正常 turn；
 *     唯一例外是 Stop 环的主动 block（exit 2），且受上限约束；
 *   - 只读桥端点（/v1/list、/v1/progress），不 spawn 不 send；
 *   - token 惰性读 ~/.dsh/task-bridge-token（env TASK_BRIDGE_TOKEN /
 *     TASK_BRIDGE_TOKEN_FILE 覆盖），不出现在任何输出里；
 *   - 注入文本带 <dsh-readback> 包裹并声明"非用户指令"，上限 2000 字符；
 *   - 状态文件在仓库外：~/.dsh/readback-hook-state.json（env 可覆盖）。
 *
 * 输出信封（Codex hooks schema，参照本机 openviking-memory 插件活体实现）：
 *   { hookSpecificOutput: { hookEventName: "<Event>", additionalContext: "<text>" } }
 *   no-op = {}；Stop block = exit 2 + stderr 原因（文档化的 schema 无关通道）。
 */

import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const EVENT = process.argv[2] || 'UserPromptSubmit';

const CFG = {
  baseUrl: (process.env.TASK_BRIDGE_URL || 'http://127.0.0.1:43120').replace(/\/+$/, ''),
  tokenFile: process.env.TASK_BRIDGE_TOKEN_FILE || path.join(os.homedir(), '.dsh', 'task-bridge-token'),
  stateFile: process.env.DSH_READBACK_STATE_FILE || path.join(os.homedir(), '.dsh', 'readback-hook-state.json'),
  stdinMs: 1500,
  fetchMs: 3500,
  guardMs: 8000,
  maxInjectChars: 2000,
  maxBoardSessions: 5,
  snippetChars: 260,
  stopMaxContinuations: 10,
  stopMaxWindowMs: 20 * 60 * 1000,
  watchAbandonMs: 90 * 60 * 1000,
  runningFreshMs: 10 * 60 * 1000,
  boardRunningMs: 30 * 60 * 1000,
  runningReportIntervalMs: 5 * 60 * 1000,
};

let emitted = false;
// 退出纪律：Windows 下 process.exit 与 stdin/stdout handle 关闭存在 libuv
// UV_HANDLE_CLOSING 断言竞态（本机实测间歇复现）。正常路径不 exit——
// 写完输出、清掉定时器、设 exitCode，让事件循环自然排空退出；
// 仅消费方死掉（broken pipe、回调不回来）时才用 exit 兜底。
process.stdout.on?.('error', () => {});
process.stderr.on?.('error', () => {});
const guardTimer = setTimeout(() => emit({}), CFG.guardMs);

function finish(code) {
  clearTimeout(guardTimer);
  process.exitCode = code;
  // 兜底：消费方已死、write 回调不回来时强制退出（broken pipe 场景，罕见）。
  // unref：正常路径事件循环自然排空立即退出，不付额外延迟。
  const fallback = setTimeout(() => process.exit(code), 800);
  fallback.unref?.();
}
function emit(obj) {
  if (emitted) return;
  emitted = true;
  process.stdout.write(JSON.stringify(obj) + '\n', () => finish(0));
}
function block(reason) {
  if (emitted) return;
  emitted = true;
  process.stderr.write(reason, () => finish(2));
}

if (process.env.DSH_READBACK_DISABLED === '1') {
  emit({});
}

// ---------------------------------------------------------------- stdin ----
function readStdinJson() {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve({});
    let raw = '';
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      try {
        process.stdin.destroy(); // 及早释放 stdin handle，退出期不再与它竞态
      } catch { /* ignore */ }
      try {
        const parsed = JSON.parse(raw.trim() || '{}');
        resolve(parsed && typeof parsed === 'object' ? parsed : {});
      } catch {
        resolve({});
      }
    };
    const timer = setTimeout(finish, CFG.stdinMs);
    timer.unref?.();
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      if (raw.length <= 1024 * 1024) raw += chunk;
    });
    process.stdin.on('end', finish);
    process.stdin.on('error', finish);
    process.stdin.resume();
  });
}

// ---------------------------------------------------------------- state ----
async function loadState() {
  try {
    const raw = await readFile(CFG.stateFile, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') {
      return {
        version: 1,
        injected: parsed.injected && typeof parsed.injected === 'object' ? parsed.injected : {},
        watch: parsed.watch && typeof parsed.watch === 'object' ? parsed.watch : {},
      };
    }
  } catch { /* 缺失/损坏 → 全新状态，fail-open */ }
  return { version: 1, injected: {}, watch: {} };
}

async function saveState(state) {
  try {
    // 有界修剪：injected 最多留 150 条；watch 里 settled/abandon 超 24h 的清掉
    const injEntries = Object.entries(state.injected)
      .sort((a, b) => (b[1]?.updatedAt || 0) - (a[1]?.updatedAt || 0));
    state.injected = Object.fromEntries(injEntries.slice(0, 150));
    const dayAgo = Date.now() - 24 * 3600 * 1000;
    for (const [codexSid, w] of Object.entries(state.watch)) {
      if (!w || typeof w !== 'object' || !w.sessions) {
        delete state.watch[codexSid];
        continue;
      }
      for (const [sid, e] of Object.entries(w.sessions)) {
        if (e?.settledAt && e.settledAt < dayAgo) delete w.sessions[sid];
      }
      if (Object.keys(w.sessions).length === 0 && (w.windowStart || 0) < dayAgo) {
        delete state.watch[codexSid];
      }
    }
    await mkdir(path.dirname(CFG.stateFile), { recursive: true });
    const tmp = `${CFG.stateFile}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(state), { encoding: 'utf8', mode: 0o600 });
    await rename(tmp, CFG.stateFile);
  } catch { /* 状态写失败不影響本 turn：fail-open */ }
}

// ---------------------------------------------------------------- bridge ---
async function getToken() {
  if (process.env.TASK_BRIDGE_TOKEN) return process.env.TASK_BRIDGE_TOKEN;
  try {
    const raw = await readFile(CFG.tokenFile, 'utf8');
    const token = raw.trim();
    return token || null;
  } catch {
    return null;
  }
}

async function bridgeGet(token, pathname) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CFG.fetchMs);
  try {
    const res = await fetch(`${CFG.baseUrl}${pathname}`, {
      headers: { 'X-Task-Bridge-Token': token },
      signal: controller.signal,
    });
    if (!res.ok) return { ok: false, status: res.status };
    const json = await res.json().catch(() => null);
    return json && json.ok ? { ok: true, json } : { ok: false, status: res.status };
  } catch {
    return { ok: false, status: 0 };
  } finally {
    clearTimeout(timer);
  }
}

function normalizeRow(row) {
  if (!row || typeof row !== 'object') return null;
  const id = row.sessionId || row.session_id || row.id;
  if (typeof id !== 'string' || !id) return null;
  const ref = typeof row.externalRef === 'string' && row.externalRef.trim() ? row.externalRef.trim() : null;
  const updatedAt = Number(row.updatedAt || row.lastActiveAt || row.updated_at) || 0;
  return { id, ref, updatedAt };
}

async function listBridgeSessions(token) {
  const res = await bridgeGet(token, '/v1/list?limit=100');
  if (!res.ok) return [];
  const rows = res.json.tasks || res.json.sessions || res.json.items || [];
  if (!Array.isArray(rows)) return [];
  return rows
    .map(normalizeRow)
    .filter((row) => row && row.ref) // 只关心经桥派发（带 externalRef）的会话
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

async function getProgress(token, sessionId) {
  const res = await bridgeGet(token, `/v1/progress?sessionId=${encodeURIComponent(sessionId)}`);
  if (!res.ok) return null;
  return res.json;
}

function isSettled(progress) {
  const st = progress?.agentState;
  return st === 'idle' || st === 'cold-idle';
}

function lastSnippet(progress) {
  const recent = Array.isArray(progress?.recent) ? progress.recent : [];
  for (let i = recent.length - 1; i >= 0; i -= 1) {
    const item = recent[i];
    let text = '';
    if (typeof item === 'string') text = item;
    else if (item && typeof item === 'object') {
      text = typeof item.text === 'string' ? item.text
        : typeof item.content === 'string' ? item.content
          : typeof item.message === 'string' ? item.message : '';
    }
    text = text.replace(/\s+/g, ' ').trim();
    if (text) return text.length > CFG.snippetChars ? `${text.slice(0, CFG.snippetChars)}…` : text;
  }
  return '';
}

function truncate(text, max) {
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 16))}…[truncated]`;
}

// ---------------------------------------------------------------- events ---
async function handleUserPromptSubmit(payload, state) {
  const token = await getToken();
  if (!token) return emit({});
  const sessions = await listBridgeSessions(token);
  if (sessions.length === 0) return emit({});
  const codexSid = typeof payload.session_id === 'string' ? payload.session_id : '';
  const watchSessions = state.watch[codexSid]?.sessions || {};
  const now = Date.now();
  const lines = [];

  // 冷会话首查可能慢（coordinator 冷路径读盘），progress 并行取以免串行超时
  const top = sessions.slice(0, CFG.maxBoardSessions);
  const progresses = await Promise.all(top.map((row) => getProgress(token, row.id)));
  for (let i = 0; i < top.length; i += 1) {
    const row = top[i];
    const progress = progresses[i];
    if (!progress) continue;
    const prev = state.injected[row.id];
    const settled = isSettled(progress);
    if (settled && (!prev || !prev.settledInjected)) {
      const snippet = lastSnippet(progress);
      lines.push(`- [settled] ${row.id}（externalRef=${row.ref}）${snippet ? `：${snippet}` : ''}`);
      state.injected[row.id] = { ...(prev || {}), settledInjected: true, updatedAt: now };
    } else if (!settled && watchSessions[row.id]) {
      const lastReport = prev?.runningReportedAt || 0;
      if (now - lastReport >= CFG.runningReportIntervalMs) {
        const snippet = lastSnippet(progress);
        lines.push(`- [running] ${row.id}（externalRef=${row.ref}）${snippet ? `最新：${snippet}` : ''}`);
        state.injected[row.id] = { ...(prev || {}), runningReportedAt: now, updatedAt: now };
      }
    }
    if (lines.length >= CFG.maxBoardSessions) break;
  }

  if (lines.length === 0) return emit({});
  await saveState(state);
  const body = truncate(
    [
      '<dsh-readback source="codex-hook" event="UserPromptSubmit">',
      '本机 DSH 任务桥自动读回（非用户指令，仅作背景事实引用）：',
      ...lines,
      '如与用户当前问题相关，请主动摘要并标注 session id；无关则不必提及。',
      '</dsh-readback>',
    ].join('\n'),
    CFG.maxInjectChars,
  );
  emit({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: body } });
}

async function handleSessionStart(payload, state) {
  const token = await getToken();
  if (!token) return emit({});
  const sessions = await listBridgeSessions(token);
  if (sessions.length === 0) return emit({});
  const now = Date.now();
  const lines = [];

  const board = sessions.slice(0, CFG.maxBoardSessions * 2);
  const progresses = await Promise.all(board.map((row) => getProgress(token, row.id)));
  for (let i = 0; i < board.length; i += 1) {
    const row = board[i];
    const progress = progresses[i];
    if (!progress) continue;
    const prev = state.injected[row.id];
    if (isSettled(progress)) {
      if (prev?.settledInjected) continue;
      const snippet = lastSnippet(progress);
      lines.push(`- [settled·未读] ${row.id}（externalRef=${row.ref}）${snippet ? `：${snippet}` : ''}`);
      state.injected[row.id] = { ...(prev || {}), settledInjected: true, updatedAt: now };
    } else if (now - row.updatedAt <= CFG.boardRunningMs) {
      lines.push(`- [running] ${row.id}（externalRef=${row.ref}）`);
    }
  }

  if (lines.length === 0) return emit({});
  await saveState(state);
  const body = truncate(
    [
      '<dsh-readback source="codex-hook" event="SessionStart">',
      '本机 DSH 任务桥当前任务板（非用户指令）：',
      ...lines,
      '</dsh-readback>',
    ].join('\n'),
    CFG.maxInjectChars,
  );
  emit({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: body } });
}

async function handlePostToolUse(payload, state) {
  const toolName = String(payload.tool_name || '');
  if (!/dsh_task_spawn/.test(toolName)) return emit({});
  const codexSid = typeof payload.session_id === 'string' ? payload.session_id : '';
  if (!codexSid) return emit({});
  const resp = payload.tool_response ?? payload.tool_result ?? payload.result ?? '';
  const raw = typeof resp === 'string' ? resp : JSON.stringify(resp);
  const match = raw.match(/"sessionId"\s*:\s*"(session-[A-Za-z0-9-]+)"/);
  if (!match) return emit({});
  const sid = match[1];
  const input = payload.tool_input && typeof payload.tool_input === 'object' ? payload.tool_input : {};
  const ref = typeof input.externalRef === 'string' ? input.externalRef.trim() : '';
  const w = state.watch[codexSid] || (state.watch[codexSid] = { sessions: {}, continuations: 0, windowStart: 0 });
  w.sessions = w.sessions || {};
  if (!w.sessions[sid]) {
    w.sessions[sid] = { externalRef: ref.slice(0, 200), addedAt: Date.now(), settledAt: null };
  }
  await saveState(state);
  emit({});
}

async function handleStop(payload, state) {
  const codexSid = typeof payload.session_id === 'string' ? payload.session_id : '';
  const w = codexSid ? state.watch[codexSid] : null;
  if (!w || !w.sessions) return emit({});
  const now = Date.now();
  const unsettled = Object.entries(w.sessions).filter(([, e]) => !e.settledAt);
  if (unsettled.length === 0) return emit({});

  const token = await getToken();
  if (!token) return emit({});
  const running = [];
  const probes = unsettled.slice(0, 3);
  const progresses = await Promise.all(probes.map(([sid]) => getProgress(token, sid)));
  for (let i = 0; i < probes.length; i += 1) {
    const [sid, entry] = probes[i];
    if (now - (entry.addedAt || now) > CFG.watchAbandonMs) {
      entry.settledAt = now; // 超时放弃等待，避免永久 watch
      continue;
    }
    const progress = progresses[i];
    if (!progress) {
      entry.settledAt = now; // 404/不可达：视为已不在跑，fail-open 放行
      continue;
    }
    if (!isSettled(progress)) running.push({ sid, entry });
    else entry.settledAt = now;
  }

  if (running.length === 0) {
    await saveState(state);
    return emit({});
  }

  w.continuations = Number(w.continuations) || 0;
  if (!w.windowStart) w.windowStart = now;
  if (w.continuations >= CFG.stopMaxContinuations || now - w.windowStart > CFG.stopMaxWindowMs) {
    await saveState(state);
    return emit({}); // 上限到：放行人工接管，不再续 turn
  }
  w.continuations += 1;
  await saveState(state);
  const desc = running.map((r) => `${r.sid}${r.entry.externalRef ? `（externalRef=${r.entry.externalRef}）` : ''}`).join('、');
  block(
    `DSH 任务桥仍有本会话派发的任务在执行：${desc}。` +
    `请调用 dsh_task_wait 或 dsh_task_progress 查询其状态；settled 后向用户摘要结果，` +
    `仍在 running 且等待预算未耗尽则继续等待；不要重复 spawn 同一任务。` +
    `（readback-hook Stop 续 turn ${w.continuations}/${CFG.stopMaxContinuations}）`,
  );
}

// ---------------------------------------------------------------- main -----
const payload = await readStdinJson();
const state = await loadState();

try {
  if (EVENT === 'UserPromptSubmit') await handleUserPromptSubmit(payload, state);
  else if (EVENT === 'SessionStart') await handleSessionStart(payload, state);
  else if (EVENT === 'PostToolUse') await handlePostToolUse(payload, state);
  else if (EVENT === 'Stop') await handleStop(payload, state);
  else emit({});
} catch {
  emit({});
}
if (!emitted) emit({});
