// 进程登记表 / 空闲超时 / 看门狗的单测。
// 跑法：npm test（先 tsc 编译到 dist-test，再 node --test）。
// 这里全部用假 ChildProcess（EventEmitter + kill 探针），不起真进程。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'child_process';
import {
  CliProcessRegistry,
  parentProcessDied,
} from '../src/processRegistry';
import { parseIdleMs, DEFAULT_SESSION_IDLE_MS } from '../src/config';

/** 假 CLI 子进程：kill() 只记录收到的信号，不发真信号。 */
class FakeProc extends EventEmitter {
  readonly pid: number;
  readonly killCalls: string[] = [];
  exitCode: number | null = null;
  signalCode: string | null = null;
  /** 模拟进程自行退出（SIGTERM 生效）。 */
  exited = false;

  constructor(pid: number) {
    super();
    this.pid = pid;
  }

  kill(signal?: number | string): boolean {
    this.killCalls.push(String(signal ?? 'SIGTERM'));
    return true;
  }

  /** 模拟进程退出并触发 exit/close 事件。 */
  simulateExit(code: number | null, signal: string | null = null): void {
    if (this.exited) return;
    this.exited = true;
    this.exitCode = code;
    this.signalCode = signal;
    this.emit('exit', code, signal);
    this.emit('close', code, signal);
  }

  asChild(): ChildProcess {
    return this as unknown as ChildProcess;
  }
}

// ──────────── 纯函数 ────────────

test('parseIdleMs: 合法值采用，非法值回落默认 30 分钟', () => {
  assert.equal(parseIdleMs('60000'), 60_000);
  assert.equal(parseIdleMs('1.9'), 1); // 向下取整
  assert.equal(parseIdleMs(undefined), DEFAULT_SESSION_IDLE_MS);
  assert.equal(parseIdleMs(''), DEFAULT_SESSION_IDLE_MS);
  assert.equal(parseIdleMs('   '), DEFAULT_SESSION_IDLE_MS);
  assert.equal(parseIdleMs('abc'), DEFAULT_SESSION_IDLE_MS);
  assert.equal(parseIdleMs('0'), DEFAULT_SESSION_IDLE_MS);
  assert.equal(parseIdleMs('-5'), DEFAULT_SESSION_IDLE_MS);
  assert.equal(DEFAULT_SESSION_IDLE_MS, 30 * 60 * 1000);
});

test('parentProcessDied: ppid 变化即父亡', () => {
  assert.equal(parentProcessDied(100, 100), false);
  assert.equal(parentProcessDied(100, 1), true);
  assert.equal(parentProcessDied(100, 0), true);
});

// ──────────── 登记表 ────────────

test('register 后 runningCount 增加，close 后移除', () => {
  const reg = new CliProcessRegistry({ idleMs: 1000 });
  const p = new FakeProc(1001);
  reg.register('s1', 'hermes', p.asChild());
  assert.equal(reg.runningCount(), 1);
  p.simulateExit(0);
  assert.equal(reg.runningCount(), 0);
});

test('CLI 被信号杀死（无退出码）→ 会话标记 error 且带详情', () => {
  const reg = new CliProcessRegistry({ idleMs: 1000 });
  const statuses: Array<[string, string, string | undefined]> = [];
  reg.onStatusChange((id, status, detail) => statuses.push([id, status, detail]));
  const p = new FakeProc(1002);
  reg.register('s1', 'claude-code', p.asChild());

  // OOM / 外部 kill：code === null，signal 有值
  p.simulateExit(null, 'SIGKILL');

  assert.equal(reg.getStatus('s1'), 'error');
  assert.match(reg.getStatusDetail('s1') || '', /died unexpectedly/);
  assert.deepEqual(statuses.at(-1)?.slice(0, 2), ['s1', 'error']);
});

test('CLI 正常退出（code 0）不标 error', () => {
  const reg = new CliProcessRegistry({ idleMs: 1000 });
  const p = new FakeProc(1003);
  reg.register('s1', 'hermes', p.asChild());
  p.simulateExit(0);
  assert.equal(reg.getStatus('s1'), 'active');
});

test('spawn 失败（error 事件）→ 会话标记 error', () => {
  const reg = new CliProcessRegistry({ idleMs: 1000 });
  const p = new FakeProc(1004);
  reg.register('s1', 'hermes', p.asChild());
  p.emit('error', new Error('spawn hermes ENOENT'));
  assert.equal(reg.getStatus('s1'), 'error');
  assert.match(reg.getStatusDetail('s1') || '', /failed to start/);
});

test('killSession: 先 SIGTERM；不退再补 SIGKILL', async () => {
  const reg = new CliProcessRegistry({ idleMs: 1000, killGraceMs: 50 });
  const stubborn = new FakeProc(1005);
  reg.register('s1', 'hermes', stubborn.asChild());

  const killed = await reg.killSession('s1');
  assert.equal(killed, 1);
  assert.deepEqual(stubborn.killCalls, ['SIGTERM', 'SIGKILL']);
  // 被我们自己杀的 close 不算意外死亡
  stubborn.simulateExit(null, 'SIGKILL');
  assert.equal(reg.getStatus('s1'), 'active');
});

test('killSession: 收到 SIGTERM 后自行退出则不再补 SIGKILL', async () => {
  const reg = new CliProcessRegistry({ idleMs: 1000, killGraceMs: 5000 });
  const polite = new FakeProc(1006);
  reg.register('s1', 'hermes', polite.asChild());

  const promise = reg.killSession('s1');
  setTimeout(() => polite.simulateExit(0), 10);
  await promise;
  assert.deepEqual(polite.killCalls, ['SIGTERM']);
});

// ──────────── 空闲超时 ────────────

test('idleSessionIds: 只挑超过阈值的会话', () => {
  let now = 10_000;
  const reg = new CliProcessRegistry({ idleMs: 1000, now: () => now });
  reg.touch('fresh');
  now = 10_500;
  reg.touch('stale');
  now = 12_000; // fresh 已闲置 2000ms，stale 1500ms
  assert.deepEqual(reg.idleSessionIds(now).sort(), ['fresh', 'stale']);
  now = 11_400; // fresh 闲置 1400，stale 闲置 900
  assert.deepEqual(reg.idleSessionIds(now), ['fresh']);
});

test('sweep: 空闲会话的 CLI 被杀、状态置 idle、释放钩子触发、不再重复扫', async () => {
  let now = 0;
  const reg = new CliProcessRegistry({ idleMs: 1000, killGraceMs: 50, now: () => now });
  const p = new FakeProc(1007);
  reg.register('s1', 'claude-code', p.asChild());
  const released: string[] = [];
  reg.onRelease((id) => released.push(id));

  now = 500; // 未超时
  assert.deepEqual(await reg.sweep(now), []);
  assert.equal(p.killCalls.length, 0);

  now = 2000; // 超阈值
  const handled = await reg.sweep(now);
  assert.deepEqual(handled, ['s1']);
  assert.deepEqual(p.killCalls, ['SIGTERM', 'SIGKILL']);
  assert.equal(reg.getStatus('s1'), 'idle');
  assert.deepEqual(released, ['s1']);
  // 已释放：不再出现在后续巡检里
  now = 9000;
  assert.deepEqual(await reg.sweep(now), []);
});

test('touch 把 error 会话复活成 active（新请求到来）', () => {
  const reg = new CliProcessRegistry({ idleMs: 1000 });
  const p = new FakeProc(1008);
  reg.register('s1', 'hermes', p.asChild());
  p.simulateExit(null, 'SIGKILL');
  assert.equal(reg.getStatus('s1'), 'error');
  reg.touch('s1');
  assert.equal(reg.getStatus('s1'), 'active');
});

test('allStatuses 汇总所有被跟踪会话', () => {
  const reg = new CliProcessRegistry({ idleMs: 1000 });
  reg.touch('s1');
  reg.touch('s2');
  const all = reg.allStatuses();
  assert.equal(all.s1.status, 'active');
  assert.equal(all.s2.status, 'active');
});
