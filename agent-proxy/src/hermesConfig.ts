// Read ~/.hermes/config.yaml to find the minimax (minimax) provider's api_key.
// The Java MinimaxConfigLoader does a line-based scan: it walks until it finds
// "- name: minimax", then reads the next api_key: line. We keep that simple
// shape — full YAML parsing would be overkill for a single field.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { logger } from './logger';

const PROVIDER_NAME = 'minimax';

let cachedKey: string | null | undefined; // undefined == not loaded yet

export function getAnthropicBaseUrl(): string {
  return 'https://api.minimaxi.com/anthropic';
}

export function getDefaultClaudeModel(): string {
  return 'MiniMax-M3';
}

/**
 * 从 hermes config 的 YAML 文本里取出 minimax 的 api_key（纯函数，可单测）。
 *
 * 2026-10-20 修的真 bug：旧实现只取 `api_key:` **同一行**的内容，
 * 而真实的 `~/.hermes/config.yaml` 用的是 **YAML 块标量**：
 *
 *     - name: minimax
 *       base_url: https://api.minimaxi.com/v1
 *       api_key:
 *         sk-cp-...            ← 值在这一行，缩进更深
 *       api_mode: chat_completions
 *
 * 旧实现于是取到**空串** → 整个 key 读不出来（`loadMinimaxApiKey()` 返回 null）
 * → 子进程路径（给 claude-code 注入 anthropic base URL + key）拿不到凭据。
 * 症状是「代理起来了但一请求就 401」，看起来像 key 过期，实际是解析没覆盖块标量。
 *
 * 现在两种形状都认：
 *   ① `api_key: sk-xxx`            —— 同行内联
 *   ② `api_key:` + 更深缩进的下一行  —— 块标量（`|` / `>` 开头也认）
 *
 * 「更深缩进」是 YAML 块标量的判据：下一行若与 `api_key:` **同缩进**，
 * 它是兄弟键（如 `api_mode:`），不能当成 key。
 */
export function parseMinimaxApiKey(text: string): string | null {
  const lines = text.split(/\r?\n/);
  let inBlock = false;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.trim();
    if (line === `- name: ${PROVIDER_NAME}`) {
      inBlock = true;
      continue;
    }
    if (!inBlock) continue;
    // 下一个 provider 块 ⇒ 本块结束
    if (line.startsWith('- name:')) break;
    if (!line.startsWith('api_key:')) continue;

    const idx = raw.indexOf(':');
    let key = idx >= 0 ? raw.slice(idx + 1).trim() : '';
    const keyIndent = raw.length - raw.trimStart().length;

    // 块标量：`api_key:` 后面是空（或 `|` / `>`），值在更深的缩进里
    if (key === '' || key === '|' || key === '|-' || key === '>' || key === '>-') {
      const folded = key.startsWith('>');
      const parts: string[] = [];
      for (let j = i + 1; j < lines.length; j++) {
        const r = lines[j];
        const t = r.trim();
        if (!t) {
          // 空行：块标量内部可以是空行，但块已结束时不再收
          if (parts.length) parts.push('');
          continue;
        }
        const indent = r.length - r.trimStart().length;
        if (indent <= keyIndent) break; // 同级或更浅 ⇒ 块结束
        if (t.startsWith('#')) continue;
        parts.push(t);
      }
      if (parts.length) {
        key = folded ? parts.join(' ').trim() : parts.join('').trim();
        i = lines.length; // 已消费到块尾
      }
    }
    if (key) return key;
  }
  return null;
}

/** Return the minimax api key from ~/.hermes/config.yaml (cached). */
export function loadMinimaxApiKey(): string | null {
  if (cachedKey !== undefined) return cachedKey;
  const configPath = path.join(os.homedir(), '.hermes', 'config.yaml');
  if (!fs.existsSync(configPath)) {
    logger.warn('hermes config not found:', configPath);
    cachedKey = null;
    return null;
  }
  try {
    const text = fs.readFileSync(configPath, 'utf-8');
    const key = parseMinimaxApiKey(text);
    if (key) {
      cachedKey = key;
      logger.info(
        'Loaded minimax api_key from hermes config:',
        key.slice(0, 15) + '...'
      );
      return key;
    }
  } catch (e) {
    logger.warn('Failed to read hermes config.yaml:', e);
  }
  cachedKey = null;
  return null;
}

/** Force the cache to reload on the next call. Useful for tests. */
export function _resetMinimaxApiKeyCache(): void {
  cachedKey = undefined;
}
