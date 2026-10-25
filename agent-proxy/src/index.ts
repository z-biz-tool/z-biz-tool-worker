// Entry point. Wires the registries, runs CLI discovery, starts the HTTP
// server, and registers shutdown handlers.

import { config as appConfig } from './config';
import { logger } from './logger';
import { createServer } from './server';
import { AgentRegistry } from './agentRegistry';
import { SessionRegistry } from './sessionRegistry';
import { CliChatExecutor } from './executor';
import { cliProcessRegistry, parentProcessDied } from './processRegistry';
import { CliAgentWrapperRegistry } from './wrappers/registry';
import { ClaudeCodeWrapper } from './wrappers/claudeCode';
import { HermesProcessWrapper, releaseHermesSession } from './wrappers/hermes';
import { OpencodeProcessWrapper, releaseOpencodeSession } from './wrappers/opencode';
import { releaseClaudeSession } from './wrappers/claudeCode';
import { discoverAndRegister } from './discovery';

async function main() {
  logger.info(`Starting agent-proxy on ${appConfig.host}:${appConfig.port}`);
  logger.info(`Persistence: ${appConfig.persistDir}`);

  const agentRegistry = new AgentRegistry(appConfig.persistDir);
  logger.info(`AgentRegistry loaded: ${agentRegistry.list().length} agents`);

  // discoverAndRegister is fire-and-forget; failures are logged.
  discoverAndRegister(agentRegistry)
    .then((found) => {
      logger.info(`After discovery: ${agentRegistry.list().length} agents registered`);
      const ok = found.filter((f) => f.available).length;
      logger.info(`Discovered ${ok}/${found.length} CLIs available locally`);
    })
    .catch((e) => logger.error('Discovery failed:', e));

  const sessionRegistry = new SessionRegistry(appConfig.persistDir);

  // ── CLI 子进程生命周期 ──
  // 1. 状态变化（CLI 意外死亡 / 空闲释放）持久化，GET /v1/sessions 可见；
  // 2. 空闲超时释放会话时，清掉各 wrapper 的 per-session 缓存；
  // 3. 定时巡检空闲会话。
  cliProcessRegistry.onStatusChange((sessionId, status, detail) => {
    sessionRegistry.setStatus(sessionId, status, detail);
  });
  cliProcessRegistry.onRelease((sessionId) => {
    releaseHermesSession(sessionId);
    releaseClaudeSession(sessionId);
    releaseOpencodeSession(sessionId);
  });
  cliProcessRegistry.startSweeper();
  logger.info(
    `CLI process registry armed: idle timeout ${appConfig.sessionIdleMs}ms ` +
      `(AGENT_SESSION_IDLE_MS), kill grace ${appConfig.cliKillGraceMs}ms`
  );

  const wrapperRegistry = new CliAgentWrapperRegistry(
    new ClaudeCodeWrapper(),
    new HermesProcessWrapper(),
    new OpencodeProcessWrapper()
  );
  const executor = new CliChatExecutor(wrapperRegistry);

  const server = createServer({ agentRegistry, sessionRegistry, executor });

  await new Promise<void>((resolve) => {
    server.listen(appConfig.port, appConfig.host, () => resolve());
  });

  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : appConfig.port;
  logger.info(`agent-proxy ready on http://${appConfig.host}:${port}`);
  logger.info('  GET  /v1/cli-agents       — list discovered CLI agents');
  logger.info('  POST /v1/session/open     — create session (binds cliType), returns sessionId');
  logger.info('  GET  /v1/sessions         — list sessions with status (idle/error visible)');
  logger.info('  POST /v1/chat/completions — chat (SSE/JSON, OpenAI compatible)');
  logger.info('  GET  /health              — health check');

  const shutdown = async (signal: string) => {
    logger.info(`Received ${signal}, shutting down...`);
    cliProcessRegistry.stopSweeper();
    // 先杀所有已登记的 CLI 再退出：否则 claude / hermes / opencode 会变
    // 孤儿继续烧 token。这是第一道关口（SIGTERM → 宽限 → SIGKILL）；
    // Rust 侧退出时还会对整个进程组补刀，是第二道。
    try {
      const killed = await cliProcessRegistry.killAll();
      logger.info(`Killed ${killed} CLI process(es) on ${signal}`);
    } catch (e) {
      logger.warn('killAll during shutdown failed:', e);
    }
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 5000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  // 父进程猝死监护：Tauri 被外部 SIGKILL 或在 setup 后 panic 时，
  // RunEvent::Exit 不会触发，node 会变孤儿、CLI 继续烧 token。
  // Unix 上父死后 ppid 被 reaper 改成 1，据此发现并走同一套收尾。
  // Windows 不用这套（pid 复用会误报），由 Rust 侧 Exit + taskkill 覆盖。
  const originalPpid = process.ppid;
  if (process.platform !== 'win32') {
    const watchdog = setInterval(() => {
      if (parentProcessDied(originalPpid, process.ppid)) {
        logger.error(
          `Parent process ${originalPpid} is gone; killing CLI children and exiting`
        );
        clearInterval(watchdog);
        shutdown('parent-death').catch(() => process.exit(1));
      }
    }, 10_000);
    watchdog.unref();
  }
}

main().catch((e) => {
  logger.error('Fatal:', e);
  process.exit(1);
});
