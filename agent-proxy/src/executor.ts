// CliChatExecutor: dispatches to the right wrapper. Mirrors Java's executor
// (which prefers the registry over a fallback spawn path). We keep the fallback
// so a future unknown CLI type can still be spawned generically.

import { spawn } from 'child_process';
import { logger } from './logger';
import { config as appConfig } from './config';
import { cliProcessRegistry } from './processRegistry';
import type { CliProcessRegistry } from './processRegistry';
import { buildPrompt, childProcessEnv, expandHome, resolveCommand } from './utils';
import { extractDelta } from './streamParser';
import { CliAgentWrapperRegistry } from './wrappers/registry';
import { newCompletionId, sseChunk, sseDone, sseError } from './sse';
import type { CliAgentConfig, ChatCompletionRequest } from './types';
import type { SseWriter } from './wrappers/types';

export class CliChatExecutor {
  constructor(
    private registry: CliAgentWrapperRegistry,
    /** CLI 子进程登记表。默认用进程级单例；测试可注入隔离实例。 */
    private procs: CliProcessRegistry = cliProcessRegistry
  ) {}

  async executeStream(
    cfg: CliAgentConfig,
    req: ChatCompletionRequest,
    sse: SseWriter
  ): Promise<string> {
    this.procs.touch(req.sessionId);
    const w = this.registry.get(cfg.type);
    if (w) {
      logger.info(`Delegating stream to ${w.constructor.name} for type=${cfg.type}`);
      return w.streamChat(cfg, req, sse);
    }
    logger.info(`No wrapper for type=${cfg.type}, fallback to spawn`);
    return this.fallbackStream(cfg, req, sse);
  }

  async executeSync(cfg: CliAgentConfig, req: ChatCompletionRequest): Promise<string> {
    this.procs.touch(req.sessionId);
    const w = this.registry.get(cfg.type);
    if (w) {
      logger.info(`Delegating sync to ${w.constructor.name} for type=${cfg.type}`);
      return w.syncChat(cfg, req);
    }
    logger.info(`No wrapper for type=${cfg.type}, fallback to spawn`);
    return this.fallbackSync(cfg, req);
  }

  // ──────────── generic subprocess fallback (for unknown types) ────────────

  private async fallbackStream(
    cfg: CliAgentConfig,
    req: ChatCompletionRequest,
    sse: SseWriter
  ): Promise<string> {
    const prompt = buildPrompt(req.messages);
    const completionId = newCompletionId();
    const created = Math.floor(Date.now() / 1000);
    const model = cfg.type;
    const proc = this.spawnProcess(cfg, prompt, req.sessionId);
    let full = '';
    proc.stdout.on('data', (b) => {
      for (const line of b.toString('utf-8').split(/\r?\n/)) {
        const delta = extractDelta(line);
        if (delta) {
          full += delta;
          sse.write(sseChunk(completionId, model, created, delta));
        }
      }
    });
    let stderr = '';
    proc.stderr.on('data', (b) => (stderr += b.toString()));
    const code = await waitForExit(proc, appConfig.processTimeoutMs);
    if (code === -1) {
      sse.write(sseError(`CLI process timeout after ${appConfig.processTimeoutMs / 1000}s`));
    } else if (code !== 0 && full.length === 0) {
      sse.write(sseError(`CLI process exited with code ${code}: ${stderr.trim()}`));
    }
    sse.write(sseDone());
    return full;
  }

  private async fallbackSync(cfg: CliAgentConfig, req: ChatCompletionRequest): Promise<string> {
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
    const code = await waitForExit(proc, appConfig.processTimeoutMs);
    if (code === -1) throw new Error('CLI process timeout');
    if (code !== 0 && full.length === 0) {
      throw new Error(`CLI process exited with code ${code}: ${stderr.trim()}`);
    }
    return full;
  }

  private spawnProcess(cfg: CliAgentConfig, prompt: string, sessionId?: string) {
    const resolved = resolveCommand(cfg.command) || cfg.command;
    const args = (cfg.args || []).map((a) => a.replace(/\{prompt\}/g, prompt));
    const env = childProcessEnv();
    const cwd = cfg.workingDir ? expandHome(cfg.workingDir) : process.cwd();
    logger.info(
      `Spawning CLI agent (fallback): command=${resolved} args=${JSON.stringify(args)} type=${cfg.type}`
    );
    const proc = spawn(resolved, args, {
      env,
      cwd: cwd || process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    // 登记：退出/空闲超时/意外死亡都要能按会话找到它
    this.procs.register(sessionId, `fallback:${cfg.type}`, proc);
    return proc;
  }
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
