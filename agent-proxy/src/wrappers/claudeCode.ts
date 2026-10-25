// Claude Code wrapper: spawn `claude` per request with stream-json output, then
// read & parse stdout line-by-line into SSE deltas. Injects the minimax
// anthropic-compatible base URL + api key from ~/.hermes/config.yaml so the
// child process doesn't need its own /login.

import { spawn } from 'child_process';
import { logger } from '../logger';
import { config as appConfig } from '../config';
import { cliProcessRegistry } from '../processRegistry';
import {
  buildPrompt,
  childProcessEnv,
  expandHome,
  resolveCommand,
} from '../utils';
import { getAnthropicBaseUrl, getDefaultClaudeModel, loadMinimaxApiKey } from '../hermesConfig';
import { extractDelta } from '../streamParser';
import { newCompletionId, sseChunk, sseDone, sseError } from '../sse';
import type { ChatCompletionRequest, CliAgentConfig } from '../types';
import type { CliAgentWrapper, SseWriter } from './types';

/** Map of session IDs that have already been started; used to switch between
 *  --session-id (first request) and --resume (subsequent). */
const activeSessions = new Set<string>();

/** 会话被空闲超时释放后，从 --resume 集合里摘掉，
 *  下次同 id 请求会以 --session-id 重新起。 */
export function releaseClaudeSession(sessionId: string): void {
  activeSessions.delete(sessionId);
}

export class ClaudeCodeWrapper implements CliAgentWrapper {
  supports(type: string): boolean {
    return type === 'claude-code';
  }

  async streamChat(
    cfg: CliAgentConfig,
    req: ChatCompletionRequest,
    sse: SseWriter
  ): Promise<string> {
    const prompt = buildPrompt(req.messages);
    const completionId = newCompletionId();
    const created = Math.floor(Date.now() / 1000);
    const model = cfg.type;
    let full = '';

    const proc = this.spawnProcess(cfg, prompt, req.sessionId);
    const onData = (chunk: Buffer) => {
      const text = chunk.toString('utf-8');
      for (const line of text.split(/\r?\n/)) {
        const delta = extractDelta(line);
        if (delta != null && delta.length > 0) {
          full += delta;
          sse.write(sseChunk(completionId, model, created, delta));
        }
      }
    };
    proc.stdout.on('data', onData);

    let stderr = '';
    proc.stderr.on('data', (b) => (stderr += b.toString()));

    const exitCode: number | null = await new Promise((resolve) => {
      const timer = setTimeout(() => {
        logger.warn(`Claude Code timeout after ${appConfig.processTimeoutMs}ms, killing`);
        proc.kill('SIGKILL');
        resolve(-1);
      }, appConfig.processTimeoutMs);
      proc.on('close', (code) => {
        clearTimeout(timer);
        resolve(code);
      });
      proc.on('error', (err) => {
        clearTimeout(timer);
        logger.warn('Claude Code process error:', err);
        resolve(1);
      });
    });

    if (exitCode !== 0 && exitCode !== -1) {
      logger.warn(`Claude Code exited with code ${exitCode}: ${stderr.trim()}`);
      if (full.length === 0) {
        sse.write(sseError(`Claude Code exited with code ${exitCode}: ${stderr.trim()}`));
      }
    } else if (exitCode === -1) {
      sse.write(sseError('Claude Code process timeout'));
    }
    sse.write(sseDone());
    return full;
  }

  async syncChat(
    cfg: CliAgentConfig,
    req: ChatCompletionRequest
  ): Promise<string> {
    const prompt = buildPrompt(req.messages);
    const proc = this.spawnProcess(cfg, prompt, req.sessionId);
    let full = '';
    let stderr = '';

    proc.stdout.on('data', (b) => {
      for (const line of b.toString('utf-8').split(/\r?\n/)) {
        const delta = extractDelta(line);
        if (delta) full += delta;
      }
    });
    proc.stderr.on('data', (b) => (stderr += b.toString()));

    const exitCode: number | null = await new Promise((resolve) => {
      const timer = setTimeout(() => {
        proc.kill('SIGKILL');
        resolve(-1);
      }, appConfig.processTimeoutMs);
      proc.on('close', (code) => {
        clearTimeout(timer);
        resolve(code);
      });
      proc.on('error', () => {
        clearTimeout(timer);
        resolve(1);
      });
    });

    if (exitCode !== 0 && full.length === 0) {
      throw new Error(
        `Claude Code exited with code ${exitCode}: ${stderr.trim()}`
      );
    }
    if (exitCode === -1) throw new Error('Claude Code process timeout');
    return full;
  }

  // ──────────── internals ────────────

  private spawnProcess(cfg: CliAgentConfig, prompt: string, sessionId: string | undefined) {
    const resolved = resolveCommand(cfg.command) || cfg.command;
    const baseArgs = this.resolveArgs(cfg, prompt);

    // Track which flags the user already supplied so we don't double-add.
    let hasModel = false;
    let hasIncludePartial = false;
    for (const a of baseArgs) {
      if (a === '--model') hasModel = true;
      if (a === '--include-partial-messages') hasIncludePartial = true;
    }

    const args: string[] = [...baseArgs];
    if (!hasModel) {
      args.push('--model', getDefaultClaudeModel());
    }
    if (!hasIncludePartial) {
      // Real streaming requires this flag; without it, claude prints one
      // complete assistant message and we lose delta-level granularity.
      args.push('--include-partial-messages');
    }

    if (sessionId) {
      if (activeSessions.has(sessionId)) {
        args.push('--resume', sessionId);
        logger.info(`Injected --resume=${sessionId} (resuming session)`);
      } else {
        activeSessions.add(sessionId);
        args.push('--session-id', sessionId);
        logger.info(`Injected --session-id=${sessionId} (new session)`);
      }
    }

    const env = childProcessEnv();
    const apiKey = loadMinimaxApiKey();
    if (apiKey) {
      env.ANTHROPIC_BASE_URL = getAnthropicBaseUrl();
      env.ANTHROPIC_API_KEY = apiKey;
      logger.info(
        `Injected ANTHROPIC_BASE_URL=${env.ANTHROPIC_BASE_URL} ANTHROPIC_API_KEY=${apiKey.slice(0, 15)}...`
      );
    } else {
      logger.warn('minimax api key not found in ~/.hermes/config.yaml; claude code may fail without /login');
    }

    logger.info(`Spawning Claude Code: command=${resolved} args=${JSON.stringify(args)}`);
    const cwd = cfg.workingDir ? expandHome(cfg.workingDir) : undefined;
    const proc = spawn(resolved, args, {
      env,
      cwd: cwd || process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    // 登记：proxy 退出 / 会话空闲超时 / 意外死亡都要能按会话找到它
    cliProcessRegistry.register(sessionId, 'claude-code', proc);
    return proc;
  }

  private resolveArgs(cfg: CliAgentConfig, prompt: string): string[] {
    return (cfg.args || []).map((a) => a.replace(/\{prompt\}/g, prompt));
  }
}
