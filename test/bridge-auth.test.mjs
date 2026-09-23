// bridge-auth.test.mjs — token 文件生命周期：ensureTokenFile（固定契约①的合并后接替者）。
// 背景：0.27.0 合并把独立包 install.ps1（唯一的 token 生成者）废弃后无人接替，
// 「GUI 开关一开、七条路由全 503」而文档仍写着「首次挂载自动生成」。本套件钉住
// 接替者的语义：缺则生成、**已存在绝不覆盖**、失败不抛、脱敏。
// 离线单测：真 fs + mkdtemp 独占临时目录，不碰宿主、不碰用户 ~/.dsh。
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ensureTokenFile, TokenStore, tokenMatches, defaultTokenFile } from '../bridge-auth.mjs';

function makeTempDir() {
  return mkdtempSync(join(tmpdir(), 'dsh-bridge-auth-'));
}

function cleanup(dir) {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* 尽力清理 */ }
}

test('ensureTokenFile：文件缺失即生成 64 位小写十六进制（32 随机字节）', (t) => {
  const dir = makeTempDir();
  t.after(() => cleanup(dir));
  const file = join(dir, 'task-bridge-token');

  const result = ensureTokenFile(file);

  assert.equal(result.created, true);
  assert.equal(result.reason, 'generated');
  assert.equal(result.path, file);
  const token = readFileSync(file, 'utf8');
  assert.match(token, /^[0-9a-f]{64}$/u, '必须是 64 位小写 hex——与原 install.ps1 的 RandomNumberGenerator(32)→hex 等价');
  assert.ok(!token.endsWith('\n'), '无尾换行：热轮换覆写后长度语义须与 -NoNewline 一致');
});

test('ensureTokenFile：每次生成都是不同的随机 token', (t) => {
  const dir = makeTempDir();
  t.after(() => cleanup(dir));
  const a = join(dir, 'a');
  const b = join(dir, 'b');

  ensureTokenFile(a);
  ensureTokenFile(b);

  assert.notEqual(readFileSync(a, 'utf8'), readFileSync(b, 'utf8'), '两次生成不得相同（否则不是随机源）');
});

test('ensureTokenFile：已存在绝不覆盖——保护用户轮换过的 token', (t) => {
  const dir = makeTempDir();
  t.after(() => cleanup(dir));
  const file = join(dir, 'task-bridge-token');
  // 故意用一个不像自动生成的值：模拟用户手工轮换后的 token
  const rotated = 'my-own-rotated-token-value';
  writeFileSync(file, rotated, 'ascii');
  const before = statSync(file).mtimeMs;

  const result = ensureTokenFile(file);

  assert.equal(result.created, false);
  assert.equal(result.reason, 'exists');
  assert.equal(readFileSync(file, 'utf8'), rotated, '内容必须原样保留');
  assert.equal(statSync(file).mtimeMs, before, '连 mtime 都不该动：动了会让 TokenStore 的 (mtime,size) 缓存戳失效、把未变更误读成一次轮换');
});

test('ensureTokenFile：已存在的 token 立即可被 TokenStore 读到并通过恒时比较', (t) => {
  const dir = makeTempDir();
  t.after(() => cleanup(dir));
  const file = join(dir, 'task-bridge-token');

  ensureTokenFile(file);
  const store = new TokenStore(file);
  const current = store.current();

  assert.ok('token' in current, '生成后必须立刻可用，不该出现 unavailable/empty');
  assert.equal(tokenMatches(current.token, readFileSync(file, 'utf8')), true);
});

test('ensureTokenFile：父目录缺失时递归创建（~/.dsh 不存在的全新机器）', (t) => {
  const dir = makeTempDir();
  t.after(() => cleanup(dir));
  const file = join(dir, '.dsh', 'nested', 'task-bridge-token');

  const result = ensureTokenFile(file);

  assert.equal(result.created, true);
  assert.match(readFileSync(file, 'utf8'), /^[0-9a-f]{64}$/u);
});

test('ensureTokenFile：生成失败一律不抛出，只留 warn（不炸 coordinator apply）', (t) => {
  const dir = makeTempDir();
  t.after(() => cleanup(dir));
  const file = join(dir, 'task-bridge-token');
  const warns = [];
  const failingFs = {
    statSync: () => { throw new Error('EPERM: stat denied'); },
    mkdirSync: () => { throw new Error('EPERM: mkdir denied'); },
    writeFileSync: () => { throw new Error('EPERM: write denied'); },
    chmodSync: () => {},
  };

  let result;
  assert.doesNotThrow(() => {
    result = ensureTokenFile(file, { fs: failingFs, logger: { warn: (m) => warns.push(m) } });
  }, '开关不该有让宿主起不来的能力');

  assert.equal(result.created, false);
  assert.match(result.reason, /^generate-failed: /u);
  assert.match(result.reason, /EPERM: mkdir denied/u, 'reason 要带底层原因（首个抛出点），便于运维定位');
  assert.equal(warns.length, 1);
  assert.match(warns[0], /could not generate token file/u);
  assert.match(warns[0], /503/u, 'warn 必须说明后果是 503，否则现象无从归因');
});

test('ensureTokenFile：日志与返回值绝不含 token 值（脱敏红线）', (t) => {
  const dir = makeTempDir();
  t.after(() => cleanup(dir));
  const file = join(dir, 'task-bridge-token');
  const infos = [];
  const warns = [];

  const result = ensureTokenFile(file, {
    logger: { info: (m) => infos.push(m), warn: (m) => warns.push(m) },
  });
  const token = readFileSync(file, 'utf8');

  assert.equal(result.created, true);
  const everything = [...infos, ...warns].join('\n') + JSON.stringify(result);
  assert.ok(!everything.includes(token), '日志/返回值不得出现 token 明文');
  assert.equal(infos.length, 1);
  assert.match(infos[0], /generated bridge token file/u);
  assert.ok(infos[0].includes(file), '日志应含路径，便于运维确认落在哪');
});

test('ensureTokenFile：写入请求 0o600 权限（POSIX 生效、Windows 尽力而为）', (t) => {
  const dir = makeTempDir();
  t.after(() => cleanup(dir));
  const file = join(dir, 'task-bridge-token');
  const writeModes = [];
  const chmodModes = [];

  ensureTokenFile(file, {
    fs: {
      statSync: (p, o) => statSync(p, o),
      mkdirSync: (p, o) => mkdirSync(p, o),
      writeFileSync: (p, data, opts) => { writeModes.push(opts?.mode); return writeFileSync(p, data, opts); },
      chmodSync: (p, m) => { chmodModes.push(m); return chmodSync(p, m); },
    },
  });

  assert.deepEqual(writeModes, [0o600], 'writeFileSync 必须带 mode 0o600');
  assert.deepEqual(chmodModes, [0o600], 'chmod 双写作为兜底（writeFileSync 的 mode 受 umask 影响）');
});

test('ensureTokenFile：chmod 失败不影响结果（Windows 等平台语义有限）', (t) => {
  const dir = makeTempDir();
  t.after(() => cleanup(dir));
  const file = join(dir, 'task-bridge-token');

  const result = ensureTokenFile(file, {
    fs: {
      statSync: (p, o) => statSync(p, o),
      mkdirSync: (p, o) => mkdirSync(p, o),
      writeFileSync: (p, data, opts) => writeFileSync(p, data, opts),
      chmodSync: () => { throw new Error('ENOSYS: chmod unsupported'); },
    },
  });

  assert.equal(result.created, true, 'chmod 抛错不得让整体失败');
  assert.equal(result.reason, 'generated');
});

test('ensureTokenFile：可注入随机源（确定性测试友好）', (t) => {
  const dir = makeTempDir();
  t.after(() => cleanup(dir));
  const file = join(dir, 'task-bridge-token');

  ensureTokenFile(file, { randomBytes: () => Buffer.alloc(32, 0xab) });

  assert.equal(readFileSync(file, 'utf8'), 'ab'.repeat(32));
});

test('defaultTokenFile：契约路径仍是 <homedir>/.dsh/task-bridge-token', () => {
  const p = defaultTokenFile();
  assert.ok(p.endsWith(join('.dsh', 'task-bridge-token')), `实际值：${p}`);
});
