// CLI 子进程登记表。
//
// 存在的原因：agent-proxy 拉起的 claude / hermes / opencode CLI 是
// 真正烧 token 的进程。原先它们只被各自的 wrapper 持有，proxy 自己
// 不知道「现在有哪些 CLI 在跑、挂在哪个会话下」，于是：
//   - 收 SIGTERM/SIGINT 时只关了 HTTP server，CLI 全部变孤儿；
//   - 客户端断线后没有机制收回挂死的 CLI；
//   - CLI 意外死亡（OOM / 被外部杀）时会话状态无人更新，UI 无感知。
//
// 这个模块把三件事收到一起：
//   1. register —— executor 的 fallback 和各 wrapper 拉起 CLI 时全部登记；
//   2. killSession / killAll —— SIGTERM → 宽限 → SIGKILL（先礼后兵）；
//   3. sweep —— 会话空闲超过 AGENT_SESSION_IDLE_MS 就结束它的 CLI 并释放；
//   4. 意外死亡 → 会话标记 error，经 SessionRegistry 持久化 + GET /v1/sessions
//      暴露给 UI。
//
// 注意：这里杀的是**直接子进程**。CLI 若自己再 fork 孙子进程，
// 由 Rust 侧（agent_proxy.rs）对整个进程组 killpg 兜底 —— CLI 没有
// 自建进程组，天然落在 agent-proxy 的组里。

import type { ChildProcess } from 'child_process';
import { config as appConfig } from './config';
import { logger } from './logger';

/** SIGTERM 之后等 CLI 自行退出的宽限。 */
export const DEFAULT_KILL_GRACE_MS = 3_000;
/** 空闲巡检间隔。 */
export const DEFAULT_SWEEP_INTERVAL_MS = 60_000;

export type SessionStatus = 'active' | 'idle' | 'error' | 'ended';

/** 父进程（Tauri）是否已死。Unix 上父死会被 reaper（launchd/init）收养，
 *  ppid 随之改变；Rust 的 RunEvent::Exit 在这种猝死路径上不会触发，
 *  node 不变孤儿的话，它拉起的 CLI 会继续烧 token。
 *  纯函数便于单测。Windows 不用这套：pid 会复用，有误报风险。 */
export function parentProcessDied(originalPpid: number, currentPpid: number): boolean {
  return currentPpid !== originalPpid;
}

export interface StatusListener {
  (sessionId: string, status: SessionStatus, detail?: string): void;
}

interface TrackedProc {
  sessionId: string;
  label: string;
  proc: ChildProcess;
  /** 被我们自己 kill 的 close 不算「意外死亡」，不标 error。 */
  killedByUs: boolean;
}

export interface CliProcessRegistryOptions {
  idleMs: number;
  killGraceMs?: number;
  now?: () => number;
}

export class CliProcessRegistry {
  private readonly byPid = new Map<number, TrackedProc>();
  /** sessionId -> 最近一次活动时间戳（chat 请求 / CLI 拉起都算活动）。 */
  private readonly lastActivity = new Map<string, number>();
  private readonly statuses = new Map<string, { status: SessionStatus; detail?: string; at: number }>();
  private readonly listeners = new Set<StatusListener>();
  private readonly releaseHooks = new Set<(sessionId: string) => void>();
  private sweepTimer: NodeJS.Timeout | null = null;
  private readonly idleMs: number;
  private readonly killGraceMs: number;
  private readonly now: () => number;

  constructor(opts: CliProcessRegistryOptions) {
    this.idleMs = opts.idleMs;
    this.killGraceMs = opts.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
    this.now = opts.now ?? (() => Date.now());
  }

  // ──────────── 活动跟踪 ────────────

  /** 记录会话活动（每次 chat 请求调用）。 */
  touch(sessionId: string | null | undefined): void {
    if (!sessionId) return;
    this.lastActivity.set(sessionId, this.now());
    // 新请求到来：error/idle 状态让位给 active，UI 不再显示红/灰。
    this.setStatus(sessionId, 'active');
  }

  /** 登记一个 CLI 子进程。挂上 close/error 监听：意外死亡 → 会话 error。 */
  register(sessionId: string | null | undefined, label: string, proc: ChildProcess): void {
    if (!sessionId) return;
    const pid = proc.pid;
    if (pid == null) return;
    this.lastActivity.set(sessionId, this.now());
    this.setStatus(sessionId, 'active');
    const entry: TrackedProc = { sessionId, label, proc, killedByUs: false };
    this.byPid.set(pid, entry);
    proc.on('error', (err) => {
      // spawn 失败（ENOENT 等）：CLI 根本没起来，算错误。
      logger.warn(`CLI ${label} (session ${sessionId}) process error:`, err?.message || err);
      this.setStatus(sessionId, 'error', `${label} failed to start: ${err?.message || String(err)}`);
      this.byPid.delete(pid);
    });
    proc.on('close', (code, signal) => {
      this.byPid.delete(pid);
      if (entry.killedByUs) return; // 我们自己杀的，静默
      if (code === 0) return; // 正常退出
      // 被信号杀（OOM killer、外部 kill、段错误）才算意外死亡；
      // 非零退出码由 wrapper 已有的 sseError 路径报给客户端，
      // 这里只升级「连退出码都没有」的情况，避免误报。
      if (code === null) {
        const detail = `${label} died unexpectedly (signal=${signal ?? 'unknown'})`;
        logger.warn(`CLI ${detail} (session ${sessionId})`);
        this.setStatus(sessionId, 'error', detail);
      }
    });
  }

  /** 登记「释放会话」钩子：wrapper 用它清理自己的 per-session 缓存。 */
  onRelease(hook: (sessionId: string) => void): void {
    this.releaseHooks.add(hook);
  }

  /** 订阅会话状态变化（index.ts 用来持久化到 SessionRegistry）。 */
  onStatusChange(listener: StatusListener): void {
    this.listeners.add(listener);
  }

  getStatus(sessionId: string): SessionStatus | undefined {
    return this.statuses.get(sessionId)?.status;
  }

  getStatusDetail(sessionId: string): string | undefined {
    return this.statuses.get(sessionId)?.detail;
  }

  allStatuses(): Record<string, { status: SessionStatus; detail?: string }> {
    const out: Record<string, { status: SessionStatus; detail?: string }> = {};
    for (const [id, s] of this.statuses) out[id] = { status: s.status, detail: s.detail };
    return out;
  }

  /** 当前在跑的 CLI 数量（探针 / 日志用）。 */
  runningCount(): number {
    return this.byPid.size;
  }

  // ──────────── 空闲超时 ────────────

  /** 空闲超过阈值的会话 id。纯逻辑（不碰进程），可单测。 */
  idleSessionIds(nowMs: number): string[] {
    const out: string[] = [];
    for (const [sessionId, last] of this.lastActivity) {
      if (nowMs - last >= this.idleMs) out.push(sessionId);
    }
    return out;
  }

  /** 巡检一轮：结束空闲会话的 CLI 并释放。返回被处理的会话 id。 */
  async sweep(nowMs: number = this.now()): Promise<string[]> {
    const handled: string[] = [];
    for (const sessionId of this.idleSessionIds(nowMs)) {
      const killed = await this.killSession(sessionId);
      this.lastActivity.delete(sessionId);
      this.setStatus(sessionId, 'idle', `idle timeout after ${Math.round(this.idleMs / 1000)}s`);
      for (const hook of this.releaseHooks) {
        try {
          hook(sessionId);
        } catch (e) {
          logger.warn('release hook failed for session', sessionId, ':', e);
        }
      }
      handled.push(sessionId);
      if (killed > 0) {
        logger.info(`Session ${sessionId} idle-timed out; killed ${killed} CLI process(es)`);
      } else {
        logger.info(`Session ${sessionId} idle-timed out; released`);
      }
    }
    return handled;
  }

  /** 启动定时巡检。定时器 unref，不拖住事件循环。 */
  startSweeper(intervalMs: number = DEFAULT_SWEEP_INTERVAL_MS): void {
    if (this.sweepTimer) return;
    this.sweepTimer = setInterval(() => {
      this.sweep().catch((e) => logger.warn('idle sweep failed:', e));
    }, intervalMs);
    this.sweepTimer.unref();
  }

  stopSweeper(): void {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
  }

  // ──────────── 杀进程 ────────────

  /** 结束某个会话的所有 CLI：SIGTERM → 宽限 → SIGKILL。返回杀掉的个数。 */
  async killSession(sessionId: string): Promise<number> {
    const entries = [...this.byPid.values()].filter((e) => e.sessionId === sessionId);
    const results = await Promise.all(entries.map((e) => {
      e.killedByUs = true;
      return this.termThenKill(e.proc);
    }));
    return results.filter(Boolean).length;
  }

  /** 结束所有 CLI（SIGTERM/SIGINT 退出路径用）。返回杀掉的个数。 */
  async killAll(): Promise<number> {
    const entries = [...this.byPid.values()];
    const results = await Promise.all(entries.map((e) => {
      e.killedByUs = true;
      return this.termThenKill(e.proc);
    }));
    return results.filter(Boolean).length;
  }

  /** 先礼后兵：SIGTERM，宽限内没退再 SIGKILL，等到真退出才 resolve。
   *  没在跑返回 false。 */
  private async termThenKill(proc: ChildProcess): Promise<boolean> {
    if (proc.exitCode !== null || proc.signalCode !== null) return false;
    if (!proc.kill('SIGTERM')) {
      // 进程可能刚在这一瞬退出；补一发 KILL 确认，容错处理。
      if (proc.exitCode === null && proc.signalCode === null) {
        try {
          proc.kill('SIGKILL');
        } catch {
          // ignore
        }
      }
      return false;
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        if (proc.exitCode === null && proc.signalCode === null) {
          try {
            proc.kill('SIGKILL');
          } catch {
            // ignore
          }
        }
        resolve();
      }, this.killGraceMs);
      proc.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
    return true;
  }

  // ──────────── 内部 ────────────

  private setStatus(sessionId: string, status: SessionStatus, detail?: string): void {
    const prev = this.statuses.get(sessionId);
    this.statuses.set(sessionId, { status, detail, at: this.now() });
    if (prev?.status !== status || prev?.detail !== detail) {
      for (const listener of this.listeners) {
        try {
          listener(sessionId, status, detail);
        } catch (e) {
          logger.warn('status listener failed:', e);
        }
      }
    }
  }
}

/** 进程级单例：executor / 三个 wrapper 共用一个登记表。 */
export const cliProcessRegistry = new CliProcessRegistry({
  idleMs: appConfig.sessionIdleMs,
});
