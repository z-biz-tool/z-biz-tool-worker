// HTTP server using Node's built-in http. Routes by path prefix.

import * as http from 'http';
import { logger } from './logger';
import { handleHealth } from './handlers/health';
import { makeCliListHandler } from './handlers/cliList';
import { makeSessionHandler } from './handlers/session';
import { makeChatHandler } from './handlers/chat';
import { sendError, setCors } from './handlers/common';
import type { AgentRegistry } from './agentRegistry';
import type { CliChatExecutor } from './executor';
import type { SessionRegistry } from './sessionRegistry';

export interface ServerDeps {
  agentRegistry: AgentRegistry;
  sessionRegistry: SessionRegistry;
  executor: CliChatExecutor;
}

export function createServer(deps: ServerDeps): http.Server {
  const handlers = {
    health: handleHealth,
    cliList: makeCliListHandler(deps.agentRegistry),
    session: makeSessionHandler(deps.sessionRegistry),
    chat: makeChatHandler(deps.agentRegistry, deps.executor, deps.sessionRegistry),
  };

  return http.createServer(async (req, res) => {
    const url = req.url || '/';
    const path = url.split('?')[0];
    try {
      if (path === '/health') return handlers.health(req, res);
      if (path === '/v1/cli-agents') return handlers.cliList(req, res);
      if (path === '/v1/session/open') return handlers.session(req, res);
      if (path === '/v1/sessions') return handlers.session(req, res);
      if (path === '/v1/chat/completions') return handlers.chat(req, res);
      if (path === '/' || path === '') {
        setCors(res);
        return sendError(res, 200, {
          service: 'agent-proxy',
          endpoints: [
            'GET  /v1/cli-agents',
            'POST /v1/session/open',
            'GET  /v1/sessions',
            'POST /v1/chat/completions',
            'GET  /health',
          ],
        });
      }
      setCors(res);
      sendError(res, 404, `not found: ${path}`);
    } catch (e: any) {
      logger.error('Unhandled error in route', path, ':', e);
      try {
        if (!res.headersSent) sendError(res, 500, e?.message || 'internal error');
        else res.end();
      } catch {
        // ignore
      }
    }
  });
}
