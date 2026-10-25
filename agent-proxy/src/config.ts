// Centralized config: port, persistence dir, gateway URLs, command defaults.
// Mirrors the Java ProxyApplication defaults; lives at the top so every module
// can import a single source of truth.

import * as os from 'os';
import * as path from 'path';

export interface AppConfig {
  host: string;
  port: number;
  persistDir: string;
  sessionPersistFile: string;
  agentsPersistFile: string;
  /** Local hermes gateway HTTP base (Java proxy hardcoded this same address). */
  hermesGatewayUrl: string;
  /** File containing the hermes API key. Java reads /tmp/hermes_api_key.txt. */
  hermesApiKeyFile: string;
  /** Local opencode server HTTP base. */
  opencodeServerUrl: string;
  /** Subprocess timeout for fallback path. */
  processTimeoutMs: number;
  /** Session idle timeout: an idle session's CLI is killed and released.
   *  Overridable via AGENT_SESSION_IDLE_MS. */
  sessionIdleMs: number;
  /** Grace between SIGTERM and SIGKILL when reaping CLI processes. */
  cliKillGraceMs: number;
  /** Anthropic-compatible base URL injected into claude-code child process. */
  anthropicBaseUrl: string;
  /** Default model name injected into claude-code when config omits --model. */
  defaultClaudeModel: string;
}

const DEFAULT_PORT = 9099;
const DEFAULT_PERSIST_DIR = path.join(os.homedir(), '.future-team');
const HERMES_GATEWAY_URL = 'http://127.0.0.1:8642/v1/chat/completions';
const OPENCODE_SERVER_URL = 'http://127.0.0.1:8643';
const HERMES_API_KEY_FILE = '/tmp/hermes_api_key.txt';
const ANTHROPIC_BASE_URL = 'https://api.minimaxi.com/anthropic';
const DEFAULT_CLAUDE_MODEL = 'MiniMax-M3';
const PROCESS_TIMEOUT_MS = 10 * 60 * 1000; // 10 min
/** AGENT_SESSION_IDLE_MS 缺省：30 分钟。 */
export const DEFAULT_SESSION_IDLE_MS = 30 * 60 * 1000;
const CLI_KILL_GRACE_MS = 3_000;

/** 解析 AGENT_SESSION_IDLE_MS。纯函数，便于单测。
 *  非法值（非数字 / <= 0）回落默认值 —— 一个错别字不该把超时关掉，
 *  那等于让孤儿 CLI 无限期烧 token。 */
export function parseIdleMs(raw: string | undefined): number {
  if (raw == null || raw.trim().length === 0) return DEFAULT_SESSION_IDLE_MS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_SESSION_IDLE_MS;
  return Math.floor(n);
}

function parsePort(): number {
  const flag = process.argv.find((a) => a === '--port' || a.startsWith('--port='));
  if (!flag) return DEFAULT_PORT;
  const val = flag.includes('=') ? flag.split('=')[1] : process.argv[process.argv.indexOf(flag) + 1];
  const n = Number(val);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_PORT;
}

function parsePersistDir(): string {
  const flag = process.argv.find((a) => a === '--persist-dir' || a.startsWith('--persist-dir='));
  if (!flag) return DEFAULT_PERSIST_DIR;
  const val = flag.includes('=') ? flag.split('=')[1] : process.argv[process.argv.indexOf(flag) + 1];
  return val && val.trim().length > 0 ? expandHome(val) : DEFAULT_PERSIST_DIR;
}

function expandHome(p: string): string {
  if (p.startsWith('~')) return path.join(os.homedir(), p.slice(1));
  return p;
}

export const config: AppConfig = {
  host: '127.0.0.1',
  port: parsePort(),
  persistDir: parsePersistDir(),
  sessionPersistFile: path.join(parsePersistDir(), 'sessions.json'),
  agentsPersistFile: path.join(parsePersistDir(), 'cli-agents.json'),
  hermesGatewayUrl: HERMES_GATEWAY_URL,
  hermesApiKeyFile: HERMES_API_KEY_FILE,
  opencodeServerUrl: OPENCODE_SERVER_URL,
  processTimeoutMs: PROCESS_TIMEOUT_MS,
  sessionIdleMs: parseIdleMs(process.env.AGENT_SESSION_IDLE_MS),
  cliKillGraceMs: CLI_KILL_GRACE_MS,
  anthropicBaseUrl: ANTHROPIC_BASE_URL,
  defaultClaudeModel: DEFAULT_CLAUDE_MODEL,
};
