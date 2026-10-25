// Hermes wrapper. Two execution paths:
//
//   1. **Subprocess (default)** — `hermes chat -q "{prompt}" -Q`. The local
//      `hermes` CLI is itself a full LLM client; no external service needed.
//      `streamParser.extractDelta` already filters the `session_id: ...`
//      header line and treats the remainder as plain text.
//
//   2. **HTTP gateway (legacy)** — POST to the local hermes gateway at
//      127.0.0.1:8642 with `Authorization: Bearer <key>`. Used by the Java
//      proxy and assumed available in some internal deployments. We fall
//      back to this path when the subprocess is not available, OR when the
//      caller sets the legacy `AGENT_PROXY_HERMES_LEGACY=1` env var.
//
// Session reuse for the subprocess path: we spawn a fresh `hermes chat` per
// request, but if the caller passes a `sessionId` we feed it back via
// `--resume` using a previously-observed hermes session id. The first
// invocation of a given proxy session id captures hermes's `session_id: …`
// header for that purpose.

import { spawn } from 'child_process';
import * as http from 'http';
import { logger } from '../logger';
import { config as appConfig } from '../config';
import { cliProcessRegistry } from '../processRegistry';
import { buildPrompt, childProcessEnv, expandHome, readFileOrNull, resolveCommand } from '../utils';
import { extractDelta } from '../streamParser';
import { newCompletionId, sseChunk, sseDone, sseError } from '../sse';
import type { ChatCompletionRequest, ChatMessage, CliAgentConfig } from '../types';
import type { CliAgentWrapper, SseWriter } from './types';

const sessionHistories = new Map<string, ChatMessage[]>();
/** proxySessionId -> last hermes session_id we saw (so we can --resume). */
const hermesSessionIds = new Map<string, string>();

/** 会话被空闲超时释放后，清掉 hermes 侧的 per-session 缓存，
 *  否则这两个 Map 会随会话数无限增长。 */
export function releaseHermesSession(proxySessionId: string): void {
  sessionHistories.delete(proxySessionId);
  hermesSessionIds.delete(proxySessionId);
}

export class HermesProcessWrapper implements CliAgentWrapper {
  supports(type: string): boolean {
    return type === 'hermes';
  }

  async streamChat(
    cfg: CliAgentConfig,
    req: ChatCompletionRequest,
    sse: SseWriter
  ): Promise<string> {
    // Subprocess path by default; HTTP path only when explicitly requested
    // and the binary isn't available.
    const useHttp =
      process.env.AGENT_PROXY_HERMES_LEGACY === '1' &&
      !resolveCommand('hermes');
    if (useHttp) return this.streamViaGateway(req, sse);

    const completionId = newCompletionId();
    const created = Math.floor(Date.now() / 1000);
    const model = cfg.type;
    let full = '';
    let errored = false;
    try {
      const proc = this.spawnHermesChat(cfg, req);
      let buf = '';
      proc.stdout.on('data', (chunk: Buffer) => {
        buf += chunk.toString('utf-8');
        let idx;
        while ((idx = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, idx);
          buf = buf.slice(idx + 1);
          const captured = captureSessionId(line, req.sessionId);
          const delta = extractDelta(line);
          if (delta) {
            full += delta;
            sse.write(sseChunk(completionId, model, created, delta));
          } else if (captured) {
            // session id line — already logged
          }
        }
      });
      // Hermes (-Q mode) writes the `session_id: ...` header to stderr, not
      // stdout. Drain stderr so the OS pipe doesn't block, and run the same
      // captureSessionId against stderr lines.
      let stderr = '';
      let stderrBuf = '';
      proc.stderr.on('data', (b) => {
        stderr += b.toString();
        stderrBuf += b.toString();
        let idx;
        while ((idx = stderrBuf.indexOf('\n')) >= 0) {
          const line = stderrBuf.slice(0, idx);
          stderrBuf = stderrBuf.slice(idx + 1);
          captureSessionId(line, req.sessionId);
        }
      });
      const code = await waitForExit(proc, appConfig.processTimeoutMs);
      // flush any tail without trailing newline
      if (buf.length > 0) {
        const delta = extractDelta(buf);
        if (delta) {
          full += delta;
          sse.write(sseChunk(completionId, model, created, delta));
        }
        buf = '';
      }
      if (code === -1) {
        sse.write(sseError('Hermes process timeout'));
        errored = true;
      } else if (code !== 0 && full.length === 0) {
        sse.write(sseError(`Hermes exited with code ${code}: ${stderr.trim()}`));
        errored = true;
      } else if (code !== 0) {
        logger.warn(`Hermes exited with code ${code}: ${stderr.trim()}`);
      }
    } catch (e: any) {
      errored = true;
      logger.warn('Hermes subprocess error:', e);
      if (full.length === 0) sse.write(sseError('Hermes error: ' + (e?.message || String(e))));
    }
    if (!errored) sse.write(sseDone());
    return full;
  }

  async syncChat(
    cfg: CliAgentConfig,
    req: ChatCompletionRequest
  ): Promise<string> {
    const useHttp =
      process.env.AGENT_PROXY_HERMES_LEGACY === '1' &&
      !resolveCommand('hermes');
    if (useHttp) return this.consumeGateway(req, false, () => undefined, (m) => { throw new Error(m); });

    const proc = this.spawnHermesChat(cfg, req);
    let full = '';
    let buf = '';
    let stderr = '';
    let stderrBuf = '';
    proc.stdout.on('data', (b) => {
      buf += b.toString('utf-8');
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        captureSessionId(line, req.sessionId);
        const delta = extractDelta(line);
        if (delta) full += delta;
      }
    });
    proc.stderr.on('data', (b) => {
      stderr += b.toString();
      stderrBuf += b.toString();
      let idx;
      while ((idx = stderrBuf.indexOf('\n')) >= 0) {
        const line = stderrBuf.slice(0, idx);
        stderrBuf = stderrBuf.slice(idx + 1);
        captureSessionId(line, req.sessionId);
      }
    });
    const code = await waitForExit(proc, appConfig.processTimeoutMs);
    if (buf.length > 0) {
      const delta = extractDelta(buf);
      if (delta) full += delta;
    }
    if (code === -1) throw new Error('Hermes process timeout');
    if (code !== 0 && full.length === 0) {
      throw new Error(`Hermes exited with code ${code}: ${stderr.trim()}`);
    }
    return full;
  }

  // ──────────── subprocess path ────────────

  private spawnHermesChat(cfg: CliAgentConfig, req: ChatCompletionRequest) {
    const prompt = buildPrompt(req.messages);
    const resolved = resolveCommand(cfg.command) || cfg.command;

    // base args: 'chat -q "{prompt}" -Q' (quiet mode for programmatic use)
    const baseArgs: string[] = ['chat', '-q', prompt, '-Q'];

    // session reuse: if we have a stored hermes session id for this proxy
    // session, pass --resume so the model sees prior context.
    if (req.sessionId) {
      const hermesId = hermesSessionIds.get(req.sessionId);
      if (hermesId) {
        baseArgs.push('--resume', hermesId);
        logger.info(`Resuming hermes session ${hermesId} for proxy session ${req.sessionId}`);
      }
    }

    const env = childProcessEnv();
    const cwd = cfg.workingDir ? expandHome(cfg.workingDir) : process.cwd();
    logger.info(`Spawning hermes chat: command=${resolved} args=${JSON.stringify(baseArgs).slice(0, 200)}`);
    const proc = spawn(resolved, baseArgs, {
      env,
      cwd: cwd || process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    // 登记：proxy 退出 / 会话空闲超时 / 意外死亡都要能按会话找到它
    cliProcessRegistry.register(req.sessionId, 'hermes', proc);
    return proc;
  }

  // ──────────── HTTP gateway path (legacy fallback) ────────────

  private async streamViaGateway(req: ChatCompletionRequest, sse: SseWriter): Promise<string> {
    const completionId = newCompletionId();
    const created = Math.floor(Date.now() / 1000);
    const model = 'hermes';
    const full = await this.consumeGateway(
      req,
      true,
      (delta) => sse.write(sseChunk(completionId, model, created, delta)),
      (errMsg) => sse.write(sseError(errMsg))
    );
    sse.write(sseDone());
    return full;
  }

  private async consumeGateway(
    req: ChatCompletionRequest,
    stream: boolean,
    onDelta: (d: string) => void,
    onError: (msg: string) => void
  ): Promise<string> {
    const messages = this.resolveSessionMessages(req);
    const apiKey = readApiKey();
    if (!apiKey) {
      onError('Hermes gateway API key not found at ' + appConfig.hermesApiKeyFile);
      return '';
    }
    let full = '';
    try {
      await new Promise<void>((resolve, reject) => {
        const url = new URL(appConfig.hermesGatewayUrl);
        const body = buildGatewayBody(messages, stream);
        const req2 = http.request(
          {
            hostname: url.hostname,
            port: url.port || 80,
            path: url.pathname + url.search,
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Content-Length': Buffer.byteLength(body),
              Authorization: 'Bearer ' + apiKey,
            },
          },
          (res) => {
            const code = res.statusCode || 0;
            if (code !== 200) {
              readAllText(res).then((txt) =>
                reject(new Error(`Hermes gateway returned HTTP ${code}: ${txt}`))
              );
              return;
            }
            res.setEncoding('utf-8');
            let buffer = '';
            res.on('data', (chunk: string) => {
              buffer += chunk;
              let idx;
              while ((idx = buffer.indexOf('\n')) >= 0) {
                const line = buffer.slice(0, idx).trim();
                buffer = buffer.slice(idx + 1);
                if (!line.startsWith('data:')) continue;
                const payload = line.slice(5).trim();
                if (payload === '[DONE]') {
                  res.destroy();
                  resolve();
                  return;
                }
                const delta = extractDelta(payload);
                if (delta) {
                  full += delta;
                  onDelta(delta);
                }
              }
            });
            res.on('end', () => resolve());
            res.on('error', (e) => reject(e));
          }
        );
        req2.on('error', (e) => reject(e));
        req2.write(body);
        req2.end();
      });
    } catch (e: any) {
      logger.warn('Hermes gateway error:', e?.message);
      if (full.length === 0) onError('Gateway error: ' + (e?.message || String(e)));
    }
    return full;
  }

  private resolveSessionMessages(req: ChatCompletionRequest): ChatMessage[] {
    const sessionId = req.sessionId;
    if (!sessionId) return req.messages || [];
    const hist = sessionHistories.get(sessionId) || [];
    if (req.messages && req.messages.length > 0) hist.push(...req.messages);
    sessionHistories.set(sessionId, hist);
    return hist;
  }
}

// ──────────── helpers ────────────

/** If a line is "session_id: ...", record it under the proxy session so the
 *  next request can --resume. Returns true if captured. */
function captureSessionId(line: string, proxySessionId: string | undefined): boolean {
  if (process.env.AGENT_PROXY_DEBUG === '1') {
    process.stderr.write(`[hermes-wrapper] saw line: ${JSON.stringify(line)} sessionId=${proxySessionId}\n`);
  }
  const m = line.match(/^session_id:\s*(\S+)/);
  if (!m || !proxySessionId) return false;
  hermesSessionIds.set(proxySessionId, m[1]);
  logger.info(`Captured hermes session_id=${m[1]} for proxy session ${proxySessionId}`);
  if (process.env.AGENT_PROXY_DEBUG === '1') {
    process.stderr.write(`[hermes-wrapper] map now has ${hermesSessionIds.size} entries\n`);
  }
  return true;
}

function readApiKey(): string | null {
  const raw = readFileOrNull(appConfig.hermesApiKeyFile);
  if (!raw) return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function buildGatewayBody(messages: ChatMessage[], stream: boolean): string {
  const parts: string[] = [];
  for (const m of messages || []) {
    const role = m.role || 'user';
    const content = m.content || '';
    // reuse escapeJson for safe embedding
    const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t');
    parts.push(`{"role":"${esc(role)}","content":"${esc(content)}"}`);
  }
  return `{"messages":[${parts.join(',')}],"stream":${stream}}`;
}

function readAllText(stream: NodeJS.ReadableStream): Promise<string> {
  return new Promise((resolve) => {
    let buf = '';
    stream.setEncoding('utf-8');
    stream.on('data', (c) => (buf += c));
    stream.on('end', () => resolve(buf));
    stream.on('error', () => resolve(buf));
  });
}

function waitForExit(proc: ReturnType<typeof spawn>, timeoutMs: number): Promise<number> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      proc.kill('SIGKILL');
      resolve(-1);
    }, timeoutMs);
    proc.on('close', (code) => {
      clearTimeout(timer);
      resolve(code ?? 0);
    });
    proc.on('error', () => {
      clearTimeout(timer);
      resolve(1);
    });
  });
}
