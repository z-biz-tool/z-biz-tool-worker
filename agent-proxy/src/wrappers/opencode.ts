// Opencode wrapper: HTTP against the local opencode server (127.0.0.1:8643).
// The server is session-based: we POST /session once per proxy session, cache
// the opencode session id, and reuse it on subsequent turns. Replies come back
// as one full message body; we slice the text by newline and stream each line
// as an SSE delta so the client still sees line-level progress.

import { logger } from '../logger';
import { config as appConfig } from '../config';
import { buildPrompt, escapeJson, readAllText, requestJson } from '../utils';
import { newCompletionId, sseChunk, sseDone, sseError } from '../sse';
import type { ChatCompletionRequest, CliAgentConfig } from '../types';
import type { CliAgentWrapper, SseWriter } from './types';

const opencodeSessions = new Map<string, string>();

/** 会话被空闲超时释放后，清掉 proxySessionId -> opencode session 的缓存。
 *  注意这只释放 proxy 侧映射；opencode server 上的 session 由它自己管理。 */
export function releaseOpencodeSession(proxySessionId: string): void {
  opencodeSessions.delete(proxySessionId);
}

export class OpencodeProcessWrapper implements CliAgentWrapper {
  supports(type: string): boolean {
    return type === 'opencode';
  }

  async streamChat(
    cfg: CliAgentConfig,
    req: ChatCompletionRequest,
    sse: SseWriter
  ): Promise<string> {
    const completionId = newCompletionId();
    const created = Math.floor(Date.now() / 1000);
    const model = cfg.type;
    let full = '';
    let errored = false;

    try {
      const ocSessionId = await this.resolveOrCreateSession(req.sessionId);
      const prompt = buildPrompt(req.messages);
      const responseBody = await this.sendMessage(ocSessionId, prompt);
      const parts = extractTextParts(responseBody);
      full = parts.join('');
      for (const text of parts) {
        if (text == null || text.length === 0) continue;
        for (const line of text.split('\n')) {
          sse.write(sseChunk(completionId, model, created, line + '\n'));
        }
      }
    } catch (e: any) {
      errored = true;
      logger.warn('opencode server error:', e?.message);
      if (full.length === 0) {
        sse.write(sseError('opencode server error: ' + (e?.message || String(e))));
      }
    }
    if (!errored) sse.write(sseDone());
    return full;
  }

  async syncChat(
    cfg: CliAgentConfig,
    req: ChatCompletionRequest
  ): Promise<string> {
    const ocSessionId = await this.resolveOrCreateSession(req.sessionId);
    const prompt = buildPrompt(req.messages);
    const responseBody = await this.sendMessage(ocSessionId, prompt);
    return extractTextParts(responseBody).join('');
  }

  // ──────────── internals ────────────

  private async resolveOrCreateSession(proxySessionId: string | undefined): Promise<string> {
    if (proxySessionId) {
      const existing = opencodeSessions.get(proxySessionId);
      if (existing) {
        logger.info(`Reusing opencode session: ${existing} for proxy session ${proxySessionId}`);
        return existing;
      }
    }
    const id = await createOpencodeSession();
    if (proxySessionId) opencodeSessions.set(proxySessionId, id);
    return id;
  }

  private async sendMessage(sessionId: string, prompt: string): Promise<string> {
    const body = `{"parts":[{"type":"text","text":"${escapeJson(prompt)}"}]}`;
    const url = `${appConfig.opencodeServerUrl}/session/${encodeURIComponent(sessionId)}/message`;
    // The Java version uses a single POST and parses the response body directly.
    // The /message endpoint returns the full reply, so we do the same here.
    return postRaw(url, body);
  }
}

// ──────────── free helpers (kept outside the class for testability) ────────────

async function createOpencodeSession(): Promise<string> {
  const url = `${appConfig.opencodeServerUrl}/session`;
  const body = await postRaw(url, '{}');
  let json: any = null;
  try {
    json = JSON.parse(body);
  } catch {
    throw new Error(`opencode createSession: non-JSON response: ${body.slice(0, 200)}`);
  }
  const id = typeof json?.id === 'string' ? json.id : null;
  if (!id) throw new Error('opencode createSession: no session id in response');
  logger.info(`opencode session created: ${id}`);
  return id;
}

function postRaw(urlStr: string, body: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const http = require('http') as typeof import('http');
    const url = new URL(urlStr);
    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port || 80,
        path: url.pathname + url.search,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (res) => {
        const code = res.statusCode || 0;
        if (code < 200 || code >= 300) {
          readAllText(res).then((txt) =>
            reject(new Error(`HTTP ${code} from ${urlStr}: ${txt}`))
          );
          return;
        }
        readAllText(res).then((txt) => resolve(txt));
      }
    );
    req.on('error', (e) => reject(e));
    req.write(body);
    req.end();
  });
}

function extractTextParts(body: string): string[] {
  try {
    const json = JSON.parse(body);
    const parts = Array.isArray(json?.parts) ? json.parts : null;
    if (!parts) return [];
    const texts: string[] = [];
    for (const p of parts) {
      if (p && p.type === 'text' && typeof p.text === 'string') texts.push(p.text);
    }
    return texts;
  } catch {
    return [];
  }
}
