// POST /v1/session/open — bind a session to a CLI type / agent. Subsequent
// chat requests can route by session ID only.
// GET  /v1/sessions — list sessions with status (active/idle/error), so the
// UI can see when a CLI died unexpectedly or a session was released.

import type { IncomingMessage, ServerResponse } from 'http';
import { sendError, sendJson, setCors, readBody, handleCors } from './common';
import type { SessionRegistry } from '../sessionRegistry';
import type { CliProcessRegistry } from '../processRegistry';

export function makeSessionHandler(sessionRegistry: SessionRegistry) {
  return async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (handleCors(req, res)) return;
    if (req.method === 'GET') {
      // GET /v1/sessions：会话状态清单（CLI 意外死亡标 error，空闲释放标 idle）
      sendJson(res, 200, { sessions: sessionRegistry.listStatuses() });
      return;
    }
    if (req.method !== 'POST') {
      sendError(res, 405, `Method not allowed: ${req.method}`);
      return;
    }
    let cliType: string | null = null;
    let agentId: string | null = null;
    const body = await readBody(req);
    if (body && body.trim().length > 0) {
      try {
        const parsed = JSON.parse(body);
        if (typeof parsed?.cliType === 'string') cliType = parsed.cliType;
        if (typeof parsed?.agentId === 'string') agentId = parsed.agentId;
      } catch {
        // ignore — body is optional
      }
    }
    const sessionId = sessionRegistry.openSession(cliType, agentId);
    sendJson(res, 200, {
      sessionId,
      cliType: cliType || undefined,
      status: sessionRegistry.getStatus(sessionId)?.status || 'active',
    });
  };
}

/**
 * POST /v1/session/close — 结束一个会话（Agent 被删除时由 Tauri 调用）。
 *
 * 只删数据库行不管会话的话，CLI 会挂到空闲超时（默认 30 分钟）才回收。
 * 这里同步杀 CLI 并把状态标成 ended，UI（GET /v1/sessions）能看见。
 */
export function makeSessionCloseHandler(
  sessionRegistry: SessionRegistry,
  processRegistry: CliProcessRegistry
) {
  return async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (handleCors(req, res)) return;
    if (req.method !== 'POST') {
      sendError(res, 405, `Method not allowed: ${req.method}`);
      return;
    }
    let sessionId: string | null = null;
    const body = await readBody(req);
    if (body && body.trim().length > 0) {
      try {
        const parsed = JSON.parse(body);
        if (typeof parsed?.sessionId === 'string') sessionId = parsed.sessionId.trim();
      } catch {
        // 下面统一按「缺 sessionId」报错，不静默当成成功
      }
    }
    if (!sessionId) {
      sendError(res, 400, 'sessionId is required');
      return;
    }
    const closed = await processRegistry.closeSession(sessionId);
    sessionRegistry.setStatus(sessionId, 'ended', 'session closed');
    sendJson(res, 200, { sessionId, closed, status: 'ended' });
  };
}
