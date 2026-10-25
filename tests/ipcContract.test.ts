/**
 * IPC 契约门（worker 仓）：后端注册的命令 vs 前端有没有入口。
 *
 * 跑法：`npm test`（= `node --experimental-strip-types --test tests/*.test.ts`）
 *
 * ── 为什么要有这道门 ────────────────────────────────────────────────
 * 这是**博采众长**从 z-biz-tool-note / z-biz-tool-box / z-biz-tool-mind 搬过来的
 * （家族第 4 个带上这道门的仓）。
 *
 * 它守两件事：
 *   1) **前端调的命令，后端必须真的注册了** —— 否则点了必崩
 *      （invoke 报 "command not found"，而本仓前端大量空 catch 会把错误吞掉
 *        ⇒ 按钮点了**毫无反应**，连报错都没有 —— 与 note 的「在文件管理器中显示」
 *        是同一族静默失败）；
 *   2) **后端注册的命令，要么被前端调用，要么在「预留未接线」清单里写明理由**
 *      —— 不许有「既没入口、也没登记」的功能。
 *      （家族探针 family_probe_orphan_commands.py 实测：worker 38 个注册命令里
 *        有 6 个前端一次都没碰过；本轮把其中 3 个接上、1 个删掉、2 个登记为预留。）
 *
 * ── 与 note/box 版本不同的地方（本仓形态决定的） ────────────────────
 *   · **Rust 侧必须先剥注释**：本仓 `generate_handler!` 体内有注释掉的条目
 *     （`// commands::xxx 已移除`）⇒ 不剥注释就会把**注释里的命令**当成已注册
 *     ⇒ 探针因此报出过「后端注册了一个叫 `commands` 的命令」这种胡说。
 *   · **handler 体按逗号切、一段必须完整匹配一条路径才算数**：
 *     `commands::list_projects` ⇒ `list_projects`（**不是** `commands`）。
 *   · 前端侧要认**嵌套泛型**：`invoke<Record<string, unknown>>("x")`
 *     （只认 `<[^>]*>` 会只认出前一半 ⇒ 漏掉调用点）。
 *
 * ⚠ **门禁自己也要能被证伪**：解析器坏了要**自己先红**（合成样本自证），
 *   否则它会变成一个永远绿的空门 —— 那比没有门更坏。
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

/**
 * 仓根 = 进程的工作目录。
 * 不能用 `import.meta.url` 反推（本仓测试不走打包，但换跑法就会踩到）。
 */
const repoRoot = process.cwd();

/* ────────────────────────── 词法层 ────────────────────────── */

/** 剥 JS/TS 注释，**字符串原样保留**。 */
function stripJsComments(src: string): string {
  let out = "";
  let i = 0;
  const n = src.length;
  let prev: string | null = null; // 前一个有效字符（判正则字面量用）
  while (i < n) {
    const c = src[i];
    if (c === "/" && src[i + 1] === "/") {
      const j = src.indexOf("\n", i);
      const end = j < 0 ? n : j;
      out += " ".repeat(end - i);
      i = end;
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      const j = src.indexOf("*/", i + 2);
      const end = j < 0 ? n : j + 2;
      out += src.slice(i, end).replace(/[^\n]/g, " ");
      i = end;
      continue;
    }
    // 正则字面量：/['"]/g 这种里含引号 ⇒ 不认它会把状态带歪、吞掉后面几百行。
    // 判据用标准启发式：前一个有效字符是标识符字符 / ) / ] / 引号 ⇒ 是除号。
    if (c === "/" && i + 1 < n && src[i + 1] !== "/" && src[i + 1] !== "*") {
      const isRegex =
        prev === null ||
        !(prev === ")" || prev === "]" || /[A-Za-z0-9_$]/.test(prev) || prev === '"' || prev === "'");
      if (isRegex) {
        let j = i + 1;
        let inClass = false;
        while (j < n) {
          if (src[j] === "\\") { j += 2; continue; }
          if (src[j] === "[") inClass = true;
          else if (src[j] === "]") inClass = false;
          else if (src[j] === "/" && !inClass) break;
          else if (src[j] === "\n") break;
          j++;
        }
        const end = Math.min(j + 1, n);
        out += src.slice(i, end);
        prev = "/";
        i = end;
        continue;
      }
    }
    if (c === '"' || c === "'" || c === "`") {
      const q = c;
      let j = i + 1;
      while (j < n) {
        if (src[j] === "\\") { j += 2; continue; }
        if (src[j] === q) break;
        j++;
      }
      const end = Math.min(j + 1, n);
      out += src.slice(i, end);
      prev = q;
      i = end;
      continue;
    }
    out += c;
    if (!/\s/.test(c)) prev = c;
    i++;
  }
  return out;
}

/** 剥 Rust 注释（`//` 行注释，与 C 风格块注释；块注释**可嵌套**）。 */
function stripRustComments(src: string): string {
  let out = "";
  let i = 0;
  const n = src.length;
  let depth = 0;
  while (i < n) {
    if (depth > 0) {
      if (src.startsWith("/*", i)) { depth++; i += 2; continue; }
      if (src.startsWith("*/", i)) { depth--; i += 2; continue; }
      out += src[i] === "\n" ? "\n" : " ";
      i++;
      continue;
    }
    if (src.startsWith("//", i)) {
      const j = src.indexOf("\n", i);
      const end = j < 0 ? n : j;
      out += " ".repeat(end - i);
      i = end;
      continue;
    }
    if (src.startsWith("/*", i)) { depth = 1; i += 2; continue; }
    const c = src[i];
    if (c === '"') {
      let j = i + 1;
      while (j < n) {
        if (src[j] === "\\") { j += 2; continue; }
        if (src[j] === '"') break;
        j++;
      }
      const end = Math.min(j + 1, n);
      out += src.slice(i, end);
      i = end;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/* ────────────────────────── Rust 侧：注册了什么 ────────────────────────── */

/** 从 src[start]（必须是 '['）配平到对应的 ']'，返回它的下标（找不到返回 -1）。 */
function matchBracket(src: string, start: number): number {
  let depth = 0;
  for (let i = start; i < src.length; i++) {
    if (src[i] === "[") depth++;
    else if (src[i] === "]") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * 解析 `generate_handler!` 体内的注册命令。
 *
 * ⚠ **先剥注释**：注释掉的条目不是「已注册」。
 * ⚠ **一段必须完整匹配一条路径才算数**：`commands::list_projects` ⇒ `list_projects`。
 */
function registeredCommandsFrom(libRs: string): string[] {
  const src = stripRustComments(libRs);
  const m = /generate_handler!\s*\[/.exec(src);
  if (!m) return [];
  const openIdx = m.index + m[0].length - 1;
  const closeIdx = matchBracket(src, openIdx);
  if (closeIdx < 0) return [];
  const body = src.slice(openIdx + 1, closeIdx);
  const out: string[] = [];
  for (const raw of body.split(",")) {
    const item = raw.trim();
    if (!item) continue;
    const pm = /^(?:[A-Za-z_][A-Za-z0-9_]*::)*([A-Za-z_][A-Za-z0-9_]*)$/.exec(item);
    if (pm) out.push(pm[1]);
  }
  return out;
}

/* ────────────────────────── TS 侧：前端调了什么 ────────────────────────── */

/** 从 src[start]（必须是 '<'）配平尖括号，返回闭区间右端（不含）；找不到返回 -1。 */
function matchAngle(src: string, start: number): number {
  let depth = 0;
  for (let i = start; i < src.length; i++) {
    if (src[i] === "<") depth++;
    else if (src[i] === ">") {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

/** 调用点里第一个实参是字符串字面量吗？是则返回内容，否则 null。 */
function firstArgLiteral(src: string, openParen: number): string | null {
  let i = openParen + 1;
  while (i < src.length && /\s/.test(src[i])) i++;
  const q = src[i];
  if (q !== '"' && q !== "'") return null;
  let j = i + 1;
  while (j < src.length) {
    if (src[j] === "\\") { j += 2; continue; }
    if (src[j] === q) return src.slice(i + 1, j);
    j++;
  }
  return null;
}

/**
 * 找出源码里所有 `invoke(...)` 的**字面量**实参。
 *
 * 认：双引号 / 单引号 / 嵌套泛型 `invoke<Record<string, unknown>>("x")`。
 * 认不出（实参是变量）就**不认** —— 绝不用别处的字符串充数。
 */
function calledCommandsFrom(src: string): string[] {
  const out: string[] = [];
  const re = /(?<![\w$.])invoke\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    let i = m.index + "invoke".length;
    while (i < src.length && /\s/.test(src[i])) i++;
    if (src[i] === "<") {
      const end = matchAngle(src, i);
      if (end < 0) continue;
      i = end;
      while (i < src.length && /\s/.test(src[i])) i++;
    }
    if (src[i] !== "(") continue;
    const lit = firstArgLiteral(src, i);
    if (lit) out.push(lit);
    re.lastIndex = i;
  }
  return out;
}

/** 走目录（跳过构建产物与依赖）。 */
function walk(dir: string, exts: string[]): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir)) {
    if (e === "node_modules" || e === "dist" || e === "target" || e === ".git") continue;
    const p = path.join(dir, e);
    if (statSync(p).isDirectory()) out.push(...walk(p, exts));
    else if (exts.some((x) => e.endsWith(x))) out.push(p);
  }
  return out;
}

/* ────────────────────────── 本仓的读数 ────────────────────────── */

function readRegistered(): string[] {
  const lib = path.join(repoRoot, "src-tauri", "src", "lib.rs");
  return registeredCommandsFrom(readFileSync(lib, "utf-8"));
}

function readCalled(): Set<string> {
  const files = walk(path.join(repoRoot, "src"), [".ts", ".tsx"]);
  const set = new Set<string>();
  for (const f of files) {
    const src = stripJsComments(readFileSync(f, "utf-8"));
    for (const cmd of calledCommandsFrom(src)) set.add(cmd);
  }
  return set;
}

/**
 * 「预留未接线」清单：后端注册了、前端**故意**还没有入口的命令。
 *
 * 规矩（家族通用）：**接上了就必须从这张清单里删掉**（下面有一条断言在守）。
 * 每条都要写清「为什么现在不接」——不然它就是「忘了接线」的遮羞布。
 */
const RESERVED: Record<string, string> = {
  get_agent_status:
    "与 list_agents 返回的 agent.status 重复；要单独接它，得先有「Agent 实时状态」面板（UI 未定）",
  batch_update_tasks:
    "看板多选批量改状态是**独立需求**，交互（多选框放哪、能不能跨列）要先定；本轮不动",
  list_agent_sessions:
    "会话总览是诊断视图；等有「Agent 会话面板」这个需求时，和它一起做",
};

/* ────────────────────────── 门禁 ────────────────────────── */

test("IPC 契约：前端调的命令，后端必须真的注册（点了必崩 = 0）", () => {
  const registered = new Set(readRegistered());
  const called = readCalled();
  const missing = [...called].filter((c) => !registered.has(c)).sort();
  assert.deepEqual(
    missing,
    [],
    `前端调了后端没注册的命令（点了必崩，且本仓前端常把错误吞掉 ⇒ 点了毫无反应）：${missing.join(", ")}`,
  );
});

test("IPC 契约：后端注册的命令，要么被前端调用，要么登记为预留未接线", () => {
  const registered = readRegistered();
  const called = readCalled();
  const orphans = registered
    .filter((c) => !called.has(c))
    .filter((c) => !(c in RESERVED))
    .sort();
  assert.deepEqual(
    orphans,
    [],
    `这些命令后端注册了、前端一次都没调、也没登记为预留：${orphans.join(", ")}\n` +
      `⇒ 要么接上，要么在 RESERVED 里写明理由。`,
  );
});

test("IPC 契约：「预留未接线」清单不能有已经接上了的命令（接了就要删掉）", () => {
  const called = readCalled();
  const stale = Object.keys(RESERVED).filter((c) => called.has(c)).sort();
  assert.deepEqual(
    stale,
    [],
    `这些命令已经接上前端了 ⇒ 必须从 RESERVED 里删掉：${stale.join(", ")}`,
  );
});

test("IPC 契约：「预留未接线」清单里的命令，后端必须真的注册着", () => {
  const registered = new Set(readRegistered());
  const ghosts = Object.keys(RESERVED).filter((c) => !registered.has(c)).sort();
  assert.deepEqual(
    ghosts,
    [],
    `RESERVED 里列了后端**没有**注册的命令 ⇒ 清单本身是假的：${ghosts.join(", ")}`,
  );
});

test("IPC 契约：每条预留都要写清理由（空理由 = 没登记）", () => {
  const empty = Object.entries(RESERVED)
    .filter(([, why]) => !why || !why.trim())
    .map(([cmd]) => cmd)
    .sort();
  assert.deepEqual(empty, [], `这些预留条目没写理由：${empty.join(", ")}`);
});

/* ────────────────────────── 解析器自证 ────────────────────────── */

test("解析器自证：注释里的命令不算数", () => {
  const src = `
    // invoke('cmd_in_line_comment');
    /* invoke('cmd_in_block_comment'); */
    invoke('cmd_real');
  `;
  const cmds = calledCommandsFrom(stripJsComments(src));
  assert.deepEqual(cmds, ["cmd_real"], "注释里的命令名不该被当成调用点");
});

test("解析器自证：嵌套泛型 + 单引号 + 双引号都认得", () => {
  const src = `
    invoke<Record<string, unknown>>("nested_generic");
    invoke('single_quoted');
    invoke("double_quoted");
    invoke<{ success: boolean; error?: string }>("optional_prop_generic");
  `;
  const cmds = calledCommandsFrom(stripJsComments(src));
  for (const want of [
    "nested_generic",
    "single_quoted",
    "double_quoted",
    "optional_prop_generic",
  ]) {
    assert.ok(cmds.includes(want), `没认出 ${want}（实际：${cmds.join(", ")}）`);
  }
});

test("解析器自证：Rust 侧剥注释 + 路径前缀只取末段", () => {
  const lib = `
    fn main() {
      tauri::generate_handler![
        commands::real_cmd, // 保留
        commands::last_cmd // 末尾没有逗号
        // commands::ghost_cmd, 已移除
      ]
    }
  `;
  const cmds = registeredCommandsFrom(lib);
  assert.deepEqual(
    cmds.sort(),
    ["last_cmd", "real_cmd"],
    "注释里的 ghost_cmd 不算注册；commands::x 要取末段 x；末尾没逗号的也要认出来",
  );
});

test("解析器自证：正则字面量里的引号不能把状态带歪", () => {
  // ⚠ 样本要挑对：只放「正则 + 一条真命令」**测不到东西** ——
  //   剥注释器把字符串**原样保留** ⇒ 文本没变 ⇒ 读数没变 ⇒ 等价变异。
  // ⇒ 这里让正则里的引号把**后面那行注释**吞进「字符串」：
  //   不认正则 ⇒ 注释被当成字符串内容保留下来 ⇒ 注释里的命令被误认成调用点（多读）。
  const src = `
    const re = /["]/g;
    const s = "x"; // invoke('cmd_in_comment_after_regex');
    invoke('cmd_real');
  `;
  const cmds = calledCommandsFrom(stripJsComments(src));
  assert.deepEqual(
    cmds,
    ["cmd_real"],
    "正则里的引号不该把后面的注释当成字符串内容（那会把注释里的命令误认成调用点）",
  );
});
