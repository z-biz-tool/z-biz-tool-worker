/**
 * **MiniMax 真实 API 实测 + hermes key 解析回归**（2026-10-20）
 *
 * worker 的 agent-proxy 是家族里**唯一**走「anthropic 兼容」协议的工具：
 * 它把 `https://api.minimaxi.com/anthropic` 与 `MiniMax-M3` 注入给 claude-code 子进程，
 * 凭据从 `~/.hermes/config.yaml` 的 minimax provider 里读。
 * 也就是说：**MiniMax 在 worker 里的落点，与其它仓完全不同** ——
 * 别的仓填「OpenAI 兼容 base URL」，worker 填「anthropic 兼容 base URL + 一个外部配置文件里的 key」。
 *
 * 这条测试钉三件事：
 *
 * 1. **key 真的读得出来**（单测，钉形状）：
 *    2026-10-20 实测发现 —— 真实 `~/.hermes/config.yaml` 里 `api_key:` 用的是
 *    **YAML 块标量**（值在下一行、缩进更深），而旧实现只取同一行 ⇒
 *    `loadMinimaxApiKey()` 返回 **null** ⇒ 子进程路径拿不到凭据 ⇒
 *    症状是「代理起来了但一请求就 401」，看着像 key 过期，其实是解析没覆盖块标量。
 *    这里用夹具把两种形状（同行内联 / 块标量）都钉住，
 *    外加「下一行是兄弟键时不能当 key」这个陷阱。
 *
 * 2. **真实 anthropic 兼容端点跑得通**（live）：
 *    打 `https://api.minimaxi.com/anthropic/v1/messages`（worker 注入的那条），
 *    断言 200 且内容非空。
 *
 * 3. **反向钉**：假 key 必须被服务端拒（401/403）。
 *
 * ## 为什么用「即时转译」而不是 require dist
 *
 * agent-proxy 是独立包（`"type": "commonjs"`，源码是 ESM 语法的 .ts），
 * node 的 `--experimental-strip-types` **加载不了**它（会按 CJS 解析，报
 * "Cannot use import statement outside a module"）；而 `agent-proxy/dist` 是
 * **gitignore 的构建产物**，CI 在 `npm test` 那一步也还没构建它。
 * ⇒ 这里用根仓本来就有的 `typescript` devDep 把**真实源码**即时转译成 CJS 再载入，
 * 测的是源码本身，不依赖构建产物、不改 CI、不新增依赖。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import * as ts from 'typescript';

const ROOT = path.resolve(import.meta.dirname, '..');
const AGENT_PROXY_SRC = path.join(ROOT, 'agent-proxy', 'src');

/** 即时转译并载入 agent-proxy 的真实源码（stub 掉只在被测函数外用到的 logger）。 */
function loadAgentProxySource(file: string): Record<string, (...a: never[]) => unknown> {
  const full = path.join(AGENT_PROXY_SRC, file);
  const source = fs.readFileSync(full, 'utf-8');
  const js = ts.transpileModule(source, {
    fileName: full,
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const mod = { exports: {} as Record<string, unknown> };
  const realRequire = createRequire(full);
  const stubRequire = (id: string): unknown => {
    if (id === './logger') {
      return { logger: { info() {}, warn() {}, error() {}, debug() {} } };
    }
    return realRequire(id);
  };
  const factory = new Function(
    'exports',
    'require',
    'module',
    '__filename',
    '__dirname',
    js
  );
  factory(mod.exports, stubRequire, mod, full, path.dirname(full));
  return mod.exports as Record<string, (...a: never[]) => unknown>;
}

// ------------------------------------------------------------ 1. 解析形状

const YAML_INLINE = `custom_providers:
  - name: minimax
    base_url: https://api.minimaxi.com/v1
    api_key: sk-cp-inline-value
    api_mode: chat_completions
  - name: maas
    api_key: sk-other-provider
`;

/** 真实 ~/.hermes/config.yaml 的形状：值在下一行、缩进更深（YAML 块标量）。 */
const YAML_BLOCK_SCALAR = `custom_providers:
  - name: minimax
    base_url: https://api.minimaxi.com/v1
    api_key:
      sk-cp-block-scalar-value
    api_mode: chat_completions
  - name: maas
    api_key: sk-other-provider
`;

/** `api_key:` 后面跟的是**兄弟键**（同缩进）—— 它不是 key。 */
const YAML_EMPTY_THEN_SIBLING = `custom_providers:
  - name: minimax
    api_key:
    api_mode: chat_completions
  - name: maas
    api_key: sk-other-provider
`;

test('hermes key 解析：同行内联', () => {
  const mod = loadAgentProxySource('hermesConfig.ts');
  const parse = mod.parseMinimaxApiKey as unknown as (t: string) => string | null;
  assert.equal(parse(YAML_INLINE), 'sk-cp-inline-value');
});

test('hermes key 解析：YAML 块标量（值在下一行）—— 这就是真实配置的形状', () => {
  const mod = loadAgentProxySource('hermesConfig.ts');
  const parse = mod.parseMinimaxApiKey as unknown as (t: string) => string | null;
  assert.equal(parse(YAML_BLOCK_SCALAR), 'sk-cp-block-scalar-value');
});

test('hermes key 解析：块标量指示符 | 与 > 也认', () => {
  const mod = loadAgentProxySource('hermesConfig.ts');
  const parse = mod.parseMinimaxApiKey as unknown as (t: string) => string | null;
  assert.equal(
    parse(`custom_providers:\n  - name: minimax\n    api_key: |\n      sk-cp-pipe\n`),
    'sk-cp-pipe'
  );
  assert.equal(
    parse(`custom_providers:\n  - name: minimax\n    api_key: >\n      sk-cp-folded\n`),
    'sk-cp-folded'
  );
});

test('hermes key 解析：下一行是兄弟键时不能当 key', () => {
  const mod = loadAgentProxySource('hermesConfig.ts');
  const parse = mod.parseMinimaxApiKey as unknown as (t: string) => string | null;
  assert.equal(parse(YAML_EMPTY_THEN_SIBLING), null);
});

test('hermes key 解析：不越到下一个 provider 块去拿 key', () => {
  const mod = loadAgentProxySource('hermesConfig.ts');
  const parse = mod.parseMinimaxApiKey as unknown as (t: string) => string | null;
  const yaml = `custom_providers:
  - name: minimax
    base_url: https://api.minimaxi.com/v1
  - name: maas
    api_key: sk-other-provider
`;
  assert.equal(parse(yaml), null, '不能把 maas 的 key 当成 minimax 的');
});

test('hermes key 解析：worker 注入的端点与模型就是 MiniMax', () => {
  const mod = loadAgentProxySource('hermesConfig.ts');
  assert.equal(
    (mod.getAnthropicBaseUrl as unknown as () => string)(),
    'https://api.minimaxi.com/anthropic'
  );
  assert.equal(
    (mod.getDefaultClaudeModel as unknown as () => string)(),
    'MiniMax-M3'
  );
});

// ------------------------------------------------- 2. 真实配置 + 真实端点

const hermesConfigPath = path.join(os.homedir(), '.hermes', 'config.yaml');
const hasRealConfig = fs.existsSync(hermesConfigPath);
const KEY = process.env.MINIMAX_API_KEY;

test(
  'LIVE worker 注入的 anthropic 兼容端点：用真实 key 真打一次',
  {
    skip:
      hasRealConfig || KEY
        ? false
        : '既没有 ~/.hermes/config.yaml、也没设 MINIMAX_API_KEY —— 这是「没跑」，不是「跑过了」',
  },
  async () => {
    const mod = loadAgentProxySource('hermesConfig.ts');
    const load = mod.loadMinimaxApiKey as unknown as () => string | null;
    load(); // 走真实的读取路径（读 ~/.hermes/config.yaml）
    const key = KEY || load();
    assert.ok(key && key.length > 20, '没拿到 key');

    const res = await fetch('https://api.minimaxi.com/anthropic/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'MiniMax-M3',
        max_tokens: 64,
        messages: [{ role: 'user', content: '只回两个字：收到' }],
      }),
    });
    const body = (await res.json()) as {
      content?: { text?: string }[];
      usage?: Record<string, number>;
    };
    assert.equal(res.status, 200, `HTTP ${res.status}`);
    const text = (body.content ?? []).map((c) => c.text ?? '').join('');
    assert.ok(text.trim().length > 0, '返回内容为空');
    console.log(`  · anthropic 兼容端点真实调用成功：${text.slice(0, 40)}（${JSON.stringify(body.usage)}）`);
  }
);

test(
  'LIVE 反向钉：假 key 必须被 anthropic 兼容端点拒（401/403）',
  { skip: hasRealConfig ? false : '没有 ~/.hermes/config.yaml —— 这是「没跑」' },
  async () => {
    const res = await fetch('https://api.minimaxi.com/anthropic/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': 'sk-cp-definitely-invalid-key',
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'MiniMax-M3',
        max_tokens: 16,
        messages: [{ role: 'user', content: 'hi' }],
      }),
    });
    assert.ok(res.status === 401 || res.status === 403, `期望 401/403，实际 ${res.status}`);
  }
);
