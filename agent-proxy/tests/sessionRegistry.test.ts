// SessionRegistry 状态持久化的单测：CLI 意外死亡标 error、空闲释放标 idle，
// 重启代理后 UI（GET /v1/sessions）仍能看见。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SessionRegistry } from '../src/sessionRegistry';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agent-proxy-session-test-'));
}

test('setStatus 跨实例持久化（error 重启后仍可见）', () => {
  const dir = tmpDir();
  const reg = new SessionRegistry(dir);
  const sid = reg.openSession('claude-code', null);
  reg.setStatus(sid, 'error', 'claude-code died unexpectedly (signal=SIGKILL)');

  // 模拟代理重启：同一个 persistDir 重新加载
  const reloaded = new SessionRegistry(dir);
  const entry = reloaded.getStatus(sid);
  assert.ok(entry, '重启后应仍能读到状态');
  assert.equal(entry!.status, 'error');
  assert.match(entry!.detail || '', /died unexpectedly/);
  // 会话绑定没丢
  assert.equal(reloaded.getCliType(sid), 'claude-code');

  fs.rmSync(dir, { recursive: true, force: true });
});

test('idle 状态持久化 + listStatuses 可见', () => {
  const dir = tmpDir();
  const reg = new SessionRegistry(dir);
  const sid = reg.openSession('hermes', 'agent-7');
  reg.setStatus(sid, 'idle', 'idle timeout after 1800s');

  const reloaded = new SessionRegistry(dir);
  const list = reloaded.listStatuses();
  assert.equal(list.length, 1);
  assert.equal(list[0].sessionId, sid);
  assert.equal(list[0].status, 'idle');
  assert.equal(reloaded.getAgentId(sid), 'agent-7');

  fs.rmSync(dir, { recursive: true, force: true });
});

test('没有状态写入时 listStatuses 为空', () => {
  const dir = tmpDir();
  const reg = new SessionRegistry(dir);
  reg.openSession('hermes', null);
  assert.deepEqual(reg.listStatuses(), []);
  fs.rmSync(dir, { recursive: true, force: true });
});
