// Session registry: maps sessionId -> { cliType, agentId }, persisted to
// sessions.json. Lets clients open a session once and route by session ID only.
// Also carries per-session status (active / idle / error) so the UI can see
// when a CLI died unexpectedly or a session was released by the idle sweep.

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { config } from './config';
import { logger } from './logger';
import { expandHome } from './utils';
import type { SessionStatus } from './processRegistry';

interface PersistedSession {
  sessionId: string;
  cliType?: string | null;
  agentId?: string | null;
  createdAt?: number;
  status?: SessionStatus | null;
  statusDetail?: string | null;
  statusAt?: number | null;
}

export interface SessionStatusEntry {
  status: SessionStatus;
  detail?: string;
  at: number;
}

export class SessionRegistry {
  private readonly sessionCliTypes = new Map<string, string>();
  private readonly sessionAgentIds = new Map<string, string>();
  private readonly sessionStatuses = new Map<string, SessionStatusEntry>();
  private readonly persistFile: string | null;

  constructor(persistDir: string | null = config.persistDir) {
    if (persistDir && persistDir.trim().length > 0) {
      const expanded = expandHome(persistDir) || persistDir;
      this.persistFile = path.join(expanded, 'sessions.json');
      this.loadFromFile();
    } else {
      this.persistFile = null;
    }
  }

  openSession(cliType: string | null, agentId: string | null): string {
    const sessionId = crypto.randomUUID();
    if (cliType) this.sessionCliTypes.set(sessionId, cliType);
    if (agentId) this.sessionAgentIds.set(sessionId, agentId);
    this.saveToFile();
    logger.info(`Session opened: ${sessionId} cliType=${cliType || '-'} agentId=${agentId || '-'}`);
    return sessionId;
  }

  getCliType(sessionId: string | null | undefined): string | null {
    if (!sessionId) return null;
    return this.sessionCliTypes.get(sessionId) || null;
  }

  getAgentId(sessionId: string | null | undefined): string | null {
    if (!sessionId) return null;
    return this.sessionAgentIds.get(sessionId) || null;
  }

  // ──────────── status（CLI 意外死亡 / 空闲释放，供 UI 可见） ────────────

  setStatus(sessionId: string, status: SessionStatus, detail?: string): void {
    this.sessionStatuses.set(sessionId, { status, detail, at: Date.now() });
    this.saveToFile();
  }

  getStatus(sessionId: string | null | undefined): SessionStatusEntry | null {
    if (!sessionId) return null;
    return this.sessionStatuses.get(sessionId) || null;
  }

  listStatuses(): Array<{ sessionId: string } & SessionStatusEntry> {
    const out: Array<{ sessionId: string } & SessionStatusEntry> = [];
    for (const [sessionId, entry] of this.sessionStatuses) {
      out.push({ sessionId, ...entry });
    }
    return out;
  }

  // ──────────── persistence ────────────

  private loadFromFile(): void {
    if (!this.persistFile || !fs.existsSync(this.persistFile)) return;
    try {
      const raw = fs.readFileSync(this.persistFile, 'utf-8');
      const arr = JSON.parse(raw);
      if (!Array.isArray(arr)) return;
      for (const obj of arr as PersistedSession[]) {
        if (!obj || !obj.sessionId) continue;
        if (obj.cliType) this.sessionCliTypes.set(obj.sessionId, obj.cliType);
        if (obj.agentId) this.sessionAgentIds.set(obj.sessionId, obj.agentId);
        if (obj.status) {
          this.sessionStatuses.set(obj.sessionId, {
            status: obj.status,
            detail: obj.statusDetail || undefined,
            at: obj.statusAt || 0,
          });
        }
      }
      logger.info(`Loaded ${this.sessionCliTypes.size} sessions from ${this.persistFile}`);
    } catch (e) {
      logger.warn(`Failed to load sessions from ${this.persistFile}:`, e);
    }
  }

  private saveToFile(): void {
    if (!this.persistFile) return;
    try {
      const dir = path.dirname(this.persistFile);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const ids = new Set<string>([
        ...this.sessionCliTypes.keys(),
        ...this.sessionAgentIds.keys(),
        ...this.sessionStatuses.keys(),
      ]);
      const arr: PersistedSession[] = [];
      for (const id of ids) {
        const st = this.sessionStatuses.get(id);
        arr.push({
          sessionId: id,
          cliType: this.sessionCliTypes.get(id) || null,
          agentId: this.sessionAgentIds.get(id) || null,
          createdAt: Date.now(),
          status: st?.status || null,
          statusDetail: st?.detail || null,
          statusAt: st?.at || null,
        });
      }
      fs.writeFileSync(this.persistFile, JSON.stringify(arr, null, 2));
    } catch (e) {
      logger.warn(`Failed to save sessions to ${this.persistFile}:`, e);
    }
  }
}
