// POST /v1/session/close 的路由单测（W-01：Agent 被删除时回收 CLI）。
// 用真的 HTTP server + 假进程，不起真 CLI。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as http from 'node:http';
import { EventEmitter } from 'node:events';
import type { AddressInfo } from 'node:net';
import { makeSessionCloseHandler } from '../src/handlers/session';
import { SessionRegistry } from '../src/sessionRegistry';
import { CliProcessRegistry } from '../src/processRegistry';
import type { ChildProcess } from 'node:child_process';

class FakeProc extends EventEmitter {
  readonly pid: number;
  readonly killCalls: string[] = [];
  exitCode: number | null = null;
  signalCode: string | null = null;

  constructor(pid: number) {
    super();
    this.pid = pid;
  }

  kill(signal?: number | string): boolean {
    this.killCalls.push(String(signal ?? 'SIGTERM'));
    return true;
  }

  asChild(): ChildProcess {
    return this as unknown as ChildProcess;
  }
}

function startServer(handler: http.RequestListener): Promise<{ server: http.Server; url: string }> {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port;
      resolve({ server, url: `http://127.0.0.1:${port}` });
    });
  });
}

test('close: 杀掉该会话 CLI + 状态 ended + 返回 closed', async () => {
  const sessions = new SessionRegistry(null); // 不落盘
  const procs = new CliProcessRegistry({ idleMs: 60_000, killGraceMs: 20 });
  const sid = sessions.openSession('hermes', 'agent-1');
  const proc = new FakeProc(2001);
  procs.register(sid, 'hermes', proc.asChild());

  const handler = makeSessionCloseHandler(sessions, procs);
  const { server, url } = await startServer((req, res) => {
    void handler(req, res);
  });
  try {
    const resp = await fetch(`${url}/v1/session/close`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: sid }),
    });
    assert.equal(resp.status, 200);
    const body = (await resp.json()) as { sessionId: string; closed: number; status: string };
    assert.equal(body.sessionId, sid);
    assert.equal(body.closed, 1);
    assert.equal(body.status, 'ended');
    assert.deepEqual(proc.killCalls, ['SIGTERM', 'SIGKILL']);
    assert.equal(sessions.getStatus(sid)?.status, 'ended');
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test('close: 缺 sessionId ⇒ 400，不静默成功', async () => {
  const sessions = new SessionRegistry(null);
  const procs = new CliProcessRegistry({ idleMs: 60_000 });
  const handler = makeSessionCloseHandler(sessions, procs);
  const { server, url } = await startServer((req, res) => {
    void handler(req, res);
  });
  try {
    const resp = await fetch(`${url}/v1/session/close`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(resp.status, 400);
    const body = (await resp.json()) as { error: string };
    assert.match(body.error, /sessionId/);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});
