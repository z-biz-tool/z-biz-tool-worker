/**
 * src/utils/taskFilters.ts 的纯逻辑回归（无 React、无 DOM、无 store、无 IPC）。
 *
 * 为什么这个文件该有测试：
 *   它是整个看板的"数据入口函数"——轮询回来的整包任务先经过 tasksSignature 比对决定要不要换引用，
 *   再经过 filterTasks 决定列表显示什么。两者任何一处行为漂移都不会抛错、不会白屏，
 *   只会表现为"界面不刷新了"或"筛选看着像坏了"这类极难定位的静默故障。
 *   本文件所有断言值均由实际运行 node --experimental-strip-types 探针实测得到，
 *   其中若干条锁定的是"当前实现的真实行为（含疑似缺陷）"，已在注释中逐条标注。
 *
 * 跑法：node --experimental-strip-types --test tests/*.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  EMPTY_FILTERS,
  agentsSignature,
  collectTagOptions,
  filterTasks,
  hasActiveFilter,
  projectsSignature,
  statsSignature,
  tasksSignature,
} from "../src/utils/taskFilters.ts";
import type { TaskFilterState } from "../src/utils/taskFilters.ts";
import type { Agent, Project, ProjectStats, Task } from "../src/types/index.ts";

// ── 测试夹具：只填被测函数真正读取的字段，其余走实现里的 ?? 兜底 ──────────────

function task(over: Partial<Task> = {}): Task {
  return {
    id: "t1",
    project_id: "p1",
    parent_id: null,
    title: "登录页改版",
    description: "重做登录页",
    status: "todo",
    priority: 1,
    start_date: null,
    due_date: null,
    milestone: false,
    assigned_agent_id: "a1",
    children: [],
    output: null,
    custom_fields: {},
    tags: [],
    sort_order: 0,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-02T00:00:00Z",
    ...over,
  };
}

function agent(over: Partial<Agent> = {}): Agent {
  return {
    id: "a1",
    project_id: "p1",
    name: "小工",
    system_prompt: "你是助手",
    model: "claude-code",
    status: "working",
    current_task_id: "t1",
    source: "local",
    cli_type: null,
    local_agent_id: null,
    cli_version: null,
    cli_path: null,
    created_at: "2026-01-01T00:00:00Z",
    last_used_at: "2026-01-02T00:00:00Z",
    ...over,
  };
}

function project(over: Partial<Project> = {}): Project {
  return {
    id: "p1",
    name: "官网",
    description: "官网改版",
    icon: "i",
    color: "#ffffff",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-02T00:00:00Z",
    ...over,
  };
}

function stats(over: Partial<ProjectStats> = {}): ProjectStats {
  return {
    tasks: { total: 10, todo: 4, doing: 2, waiting: 1, review: 1, done: 2 },
    agents: { total: 3, working: 1, idle: 1, offline: 1 },
    ...over,
  };
}

/** 以 EMPTY_FILTERS 为底覆盖个别字段，避免每个用例重复写四个键 */
function withFilters(over: Partial<TaskFilterState> = {}): TaskFilterState {
  return { ...EMPTY_FILTERS, ...over };
}

/** 故意违反类型契约，用来观察函数面对脏数据时的真实表现（而非假装它合法） */
function dirty<T>(v: unknown): T {
  return v as T;
}

// ── EMPTY_FILTERS ────────────────────────────────────────────────────────

test("EMPTY_FILTERS 是全空状态：hasActiveFilter 为 false 且 filterTasks 放行全部任务", () => {
  assert.equal(hasActiveFilter(EMPTY_FILTERS), false);
  const tasks = [task({ id: "a" }), task({ id: "b" })];
  assert.deepEqual(
    filterTasks(tasks, EMPTY_FILTERS).map((t) => t.id),
    ["a", "b"],
  );
});

test("filterTasks 不修改传入的过滤器状态：调用后 EMPTY_FILTERS.tags 仍为空数组", () => {
  // 防的是"过滤器被就地改脏"——EMPTY_FILTERS 是模块级共享对象，一旦被清空/污染就会全局失效
  const tasks = [task({ id: "a", tags: ["前端"] })];
  filterTasks(tasks, withFilters({ query: "登录", priority: 1, agentId: "a1", tags: ["前端"] }));
  assert.deepEqual(EMPTY_FILTERS.tags, []);
  assert.equal(EMPTY_FILTERS.query, "");
  assert.equal(EMPTY_FILTERS.priority, null);
  assert.equal(EMPTY_FILTERS.agentId, null);
  assert.equal(hasActiveFilter(EMPTY_FILTERS), false);
});

// ── hasActiveFilter ──────────────────────────────────────────────────────

test("hasActiveFilter：纯空白 query 不算已筛选（防'用户明明清空了输入框却还显示着筛选中'）", () => {
  assert.equal(hasActiveFilter(withFilters({ query: "   " })), false);
  assert.equal(hasActiveFilter(withFilters({ query: "\t\n " })), false);
  assert.equal(hasActiveFilter(withFilters({ query: "" })), false);
  assert.equal(hasActiveFilter(withFilters({ query: "登录" })), true);
});

test("hasActiveFilter：priority 为 0 也算已筛选（防有人把 !== null 改成真值判断，把 0 级筛选吃掉）", () => {
  assert.equal(hasActiveFilter(withFilters({ priority: 0 })), true);
  assert.equal(hasActiveFilter(withFilters({ priority: 1 })), true);
  assert.equal(hasActiveFilter(withFilters({ priority: null })), false);
});

test("hasActiveFilter：空串 agentId 与空串标签都算已筛选（当前实现只判 !== null / length > 0）", () => {
  assert.equal(hasActiveFilter(withFilters({ agentId: "" })), true);
  assert.equal(hasActiveFilter(withFilters({ tags: [""] })), true);
  assert.equal(hasActiveFilter(withFilters({ agentId: null, tags: [] })), false);
});

test("hasActiveFilter：f 为 null / undefined 时抛 TypeError，不静默返回 false", () => {
  // 防的是"筛选控件尚未初始化就被调用"被当成'没有筛选'从而悄悄放行全部数据
  assert.throws(() => hasActiveFilter(dirty<TaskFilterState>(null)), TypeError);
  assert.throws(() => hasActiveFilter(dirty<TaskFilterState>(undefined)), TypeError);
});

test("hasActiveFilter：query / tags 字段缺失或类型不符时抛 TypeError，而非假阴性", () => {
  assert.throws(() => hasActiveFilter(dirty<TaskFilterState>({ priority: null, agentId: null, tags: [] })), TypeError);
  assert.throws(() => hasActiveFilter(withFilters({ query: dirty<string>(null) })), TypeError);
  assert.throws(() => hasActiveFilter(withFilters({ query: dirty<string>(42) })), TypeError);
  assert.throws(() => hasActiveFilter(withFilters({ tags: dirty<string[]>(null) })), TypeError);
  assert.throws(() => hasActiveFilter(dirty<TaskFilterState>({ query: "", priority: null, agentId: null })), TypeError);
});

// ── filterTasks ──────────────────────────────────────────────────────────

test("filterTasks：空过滤器原样返回全部任务、保持入参顺序，并返回新数组", () => {
  const tasks = [task({ id: "m2" }), task({ id: "m1" }), task({ id: "m3" })];
  const out = filterTasks(tasks, EMPTY_FILTERS);
  assert.deepEqual(
    out.map((t) => t.id),
    ["m2", "m1", "m3"],
  );
  assert.notEqual(out, tasks, "必须返回新数组，否则调用方排序会就地改脏轮询拿到的缓存");
  assert.deepEqual(
    tasks.map((t) => t.id),
    ["m2", "m1", "m3"],
    "入参数组顺序不能被就地重排");
});

test("filterTasks：返回的是浅拷贝，改结果不影响入参数组", () => {
  const src = [task({ id: "s1" })];
  const out = filterTasks(src, EMPTY_FILTERS);
  assert.equal(out[0], src[0], "元素是同一对象引用（浅拷贝）");
  out.push(task({ id: "injected" }));
  assert.deepEqual(
    src.map((t) => t.id),
    ["s1"],
  );
});

test("filterTasks：空任务集返回空数组而不是抛错", () => {
  assert.deepEqual(filterTasks([], EMPTY_FILTERS), []);
  assert.deepEqual(filterTasks([], withFilters({ query: "任意", priority: 3, tags: ["x"] })), []);
});

test("filterTasks：query 大小写不敏感，且是子串匹配而非整词匹配", () => {
  const en = [task({ id: "e1", title: "Login Page", description: "Refactor UI" })];
  for (const q of ["login", "LOGIN", "LoGiN", "ogin Pag"]) {
    assert.deepEqual(
      filterTasks(en, withFilters({ query: q })).map((t) => t.id),
      ["e1"],
      `query=${q} 应命中`,
    );
  }
  assert.deepEqual(filterTasks(en, withFilters({ query: "zzz" })), []);
});

test("filterTasks：query 同时匹配 title 与 description，任一命中即保留", () => {
  const tasks = [
    task({ id: "in-title", title: "登录页改版", description: "无关键词" }),
    task({ id: "in-desc", title: "无关键词", description: "重做登录页" }),
    task({ id: "neither", title: "支付回调", description: "回调重试" }),
  ];
  assert.deepEqual(
    filterTasks(tasks, withFilters({ query: "登录" })).map((t) => t.id),
    ["in-title", "in-desc"],
  );
});

test("filterTasks：query 两端空白被 trim，纯空白等于不过滤", () => {
  const tasks = [task({ id: "p1", title: "支付回调" })];
  assert.deepEqual(
    filterTasks(tasks, withFilters({ query: "  支付  " })).map((t) => t.id),
    ["p1"],
  );
  assert.deepEqual(
    filterTasks(tasks, withFilters({ query: "   " })).map((t) => t.id),
    ["p1"],
  );
});

test("filterTasks：title 与 description 之间以换行相连，只有显式换行才能跨字段命中", () => {
  // 锁定"haystack 用 \\n 连接"这一实现细节：改成空格会让本用例的红/绿翻转
  const tasks = [task({ id: "c1", title: "Login", description: "Refactor" })];
  assert.deepEqual(
    filterTasks(tasks, withFilters({ query: "Login\nRefactor" })).map((t) => t.id),
    ["c1"],
  );
  assert.deepEqual(filterTasks(tasks, withFilters({ query: "Login Refactor" })), []);
});

test("filterTasks：priority 精确匹配，命中不到时返回空集；0 是有效取值", () => {
  const tasks = [
    task({ id: "hi", priority: 1 }),
    task({ id: "zero", priority: 0 }),
    task({ id: "mid", priority: 2 }),
  ];
  assert.deepEqual(
    filterTasks(tasks, withFilters({ priority: 1 })).map((t) => t.id),
    ["hi"],
  );
  assert.deepEqual(
    filterTasks(tasks, withFilters({ priority: 0 })).map((t) => t.id),
    ["zero"],
  );
  assert.deepEqual(filterTasks(tasks, withFilters({ priority: 99 })), []);
  assert.equal(tasks.length, 3, "过滤后入参长度不变");
});

test("filterTasks【疑似缺陷】：任务 priority 为 null/undefined 时被当作 0 参与筛选", () => {
  // 实测行为：`(t.priority ?? 0) !== f.priority`。若后端某条任务缺优先级，用户筛 0 级
  // 会看到它混在真正的 0 级任务里。锁定现状，等业务确认后再改。
  const tasks = [task({ id: "null-prio", priority: dirty<number>(null) }), task({ id: "undef-prio", priority: dirty<number>(undefined) })];
  assert.deepEqual(
    filterTasks(tasks, withFilters({ priority: 0 })).map((t) => t.id),
    ["null-prio", "undef-prio"],
  );
  assert.deepEqual(filterTasks(tasks, withFilters({ priority: 1 })), []);
});

test("filterTasks：agentId 严格相等匹配；空串会筛掉全部任务", () => {
  const tasks = [task({ id: "x", assigned_agent_id: "a1" }), task({ id: "y", assigned_agent_id: null })];
  assert.deepEqual(
    filterTasks(tasks, withFilters({ agentId: "a1" })).map((t) => t.id),
    ["x"],
  );
  assert.deepEqual(filterTasks(tasks, withFilters({ agentId: "a2" })), []);
  assert.deepEqual(
    filterTasks(tasks, withFilters({ agentId: "" })),
    [],
    "空串 !== null，会走严格比较从而筛掉一切",
  );
});

test("filterTasks：多标签按'命中任一'（OR）而非全部命中（AND）", () => {
  const tasks = [
    task({ id: "fe", tags: ["前端"] }),
    task({ id: "be", tags: ["后端"] }),
    task({ id: "none", tags: [] }),
  ];
  assert.deepEqual(
    filterTasks(tasks, withFilters({ tags: ["前端", "后端"] })).map((t) => t.id),
    ["fe", "be"],
  );
  assert.deepEqual(
    filterTasks(tasks, withFilters({ tags: ["前端", "不存在的标签"] })).map((t) => t.id),
    ["fe"],
    "OR 语义下未命中的那一个应被忽略",
  );
  assert.deepEqual(
    filterTasks(tasks, withFilters({ tags: ["完全不存在"] })),
    [],
  );
});

test("filterTasks【疑似缺陷】：筛选标签只含空串时会筛掉全部任务，而 UI 仍显示'筛选中'", () => {
  // 实测行为：hasActiveFilter 判 tags.length>0 为 true，但 t.tags.includes("") 恒 false。
  // 只要还有一个能命中的标签在，some 会短路命中、空串被忽略；一旦空串是唯一的标签就全被筛掉。
  const tasks = [task({ id: "fe", tags: ["前端"] }), task({ id: "be", tags: ["后端"] })];
  const onlyEmpty = withFilters({ tags: [""] });
  assert.equal(hasActiveFilter(onlyEmpty), true, "UI 会显示'筛选中'");
  assert.deepEqual(filterTasks(tasks, onlyEmpty), [], "却一条都匹配不上");
  assert.deepEqual(
    filterTasks(tasks, withFilters({ tags: ["前端", ""] })).map((t) => t.id),
    ["fe"],
    "混着正常标签时空串被忽略",
  );
  assert.deepEqual(
    filterTasks(tasks, withFilters({ tags: ["", "后端"] })).map((t) => t.id),
    ["be"],
  );
});

test("filterTasks：任务 tags 缺失或为 null 时不崩，且匹配不上任何标签", () => {
  const tasks = [
    task({ id: "no-tags", tags: dirty<string[]>(null) }),
    task({ id: "undef-tags", tags: dirty<string[]>(undefined) }),
    task({ id: "ok", tags: ["前端"] }),
  ];
  assert.deepEqual(
    filterTasks(tasks, withFilters({ tags: ["前端"] })).map((t) => t.id),
    ["ok"],
  );
  assert.deepEqual(
    filterTasks(tasks, EMPTY_FILTERS).map((t) => t.id),
    ["no-tags", "undef-tags", "ok"],
    "无标签不该被空标签过滤误伤",
  );
});

test("filterTasks：title / description 为 null 时不崩，只是搜不到", () => {
  const tasks = [task({ id: "null-text", title: dirty<string>(null), description: dirty<string>(null) })];
  assert.deepEqual(
    filterTasks(tasks, EMPTY_FILTERS).map((t) => t.id),
    ["null-text"],
  );
  assert.deepEqual(filterTasks(tasks, withFilters({ query: "任何" })), []);
});

test("filterTasks：多个条件同时生效时取交集，交集为空时返回空数组", () => {
  const tasks = [
    task({ id: "match", title: "登录页", priority: 1, assigned_agent_id: "a1", tags: ["前端"] }),
    task({ id: "priority-diff", title: "登录页", priority: 2, assigned_agent_id: "a1", tags: ["前端"] }),
  ];
  const hit = withFilters({ query: "登录", priority: 1, agentId: "a1", tags: ["前端"] });
  assert.deepEqual(
    filterTasks(tasks, hit).map((t) => t.id),
    ["match"],
  );
  assert.deepEqual(filterTasks(tasks, withFilters({ query: "登录", priority: 2, agentId: "a1" })), [
    task({ id: "priority-diff", title: "登录页", priority: 2, assigned_agent_id: "a1", tags: ["前端"] }),
  ]);
});

test("filterTasks：入参里的重复任务原样保留，不做去重", () => {
  const dup = [task({ id: "d1" }), task({ id: "d1" })];
  assert.deepEqual(
    filterTasks(dup, EMPTY_FILTERS).map((t) => t.id),
    ["d1", "d1"],
  );
});

test("filterTasks：tasks 为 null / undefined 时抛 TypeError，不静默返回空列表", () => {
  assert.throws(() => filterTasks(dirty<Task[]>(null), EMPTY_FILTERS), TypeError);
  assert.throws(() => filterTasks(dirty<Task[]>(undefined), EMPTY_FILTERS), TypeError);
});

test("filterTasks：f 为 null / 字段缺失 / tags 非数组时抛 TypeError", () => {
  const tasks = [task()];
  assert.throws(() => filterTasks(tasks, dirty<TaskFilterState>(null)), TypeError);
  assert.throws(() => filterTasks(tasks, dirty<TaskFilterState>(undefined)), TypeError);
  assert.throws(() => filterTasks(tasks, dirty<TaskFilterState>({ priority: null, agentId: null, tags: [] })), TypeError);
  assert.throws(() => filterTasks(tasks, withFilters({ query: dirty<string>(null) })), TypeError);
  assert.throws(() => filterTasks(tasks, withFilters({ query: dirty<string>(42) })), TypeError);
  assert.throws(() => filterTasks(tasks, withFilters({ tags: dirty<string[]>(null) })), TypeError);
  assert.throws(() => filterTasks(tasks, withFilters({ tags: dirty<string[]>("前端") })), TypeError);
});

test("filterTasks【疑似缺陷】：priority 传入字符串 '1' 时不抛错，直接静默返回空集", () => {
  // 实测行为：严格不等比较让类型不符退化成"什么都没匹配上"，用户看到的是空列表而非报错
  const tasks = [task({ id: "x", priority: 1 })];
  assert.deepEqual(filterTasks(tasks, withFilters({ priority: dirty<number>("1") })), []);
});

// ── collectTagOptions ────────────────────────────────────────────────────

test("collectTagOptions：空任务集与无标签任务都返回空数组", () => {
  assert.deepEqual(collectTagOptions([]), []);
  assert.deepEqual(collectTagOptions([task({ tags: [] })]), []);
  assert.deepEqual(collectTagOptions([task({ tags: dirty<string[]>(null) })]), []);
  assert.deepEqual(collectTagOptions([dirty<Task>({ id: "q" })]), []);
});

test("collectTagOptions：跨任务与任务内部都去重", () => {
  // 输出按 zh-CN 拼音排序：后(hou) < 前(qian)，所以是 ["后端","前端"] 而非码点序
  assert.deepEqual(collectTagOptions([task({ tags: ["前端", "前端"] }), task({ tags: ["前端", "后端"] })]), [
    "后端",
    "前端",
  ]);
});

test("collectTagOptions：按 zh-CN 拼音排序，不是码点排序（防有人改成默认 sort 导致中文顺序错乱）", () => {
  // 实测：zh-CN collation 下"安<北<中"；若换成默认码点排序会得到 ["中","北","安"]
  assert.deepEqual(collectTagOptions([task({ tags: ["中", "安", "北"] })]), ["安", "北", "中"]);
  assert.deepEqual(collectTagOptions([task({ tags: ["后端", "前端"] })]), ["后端", "前端"]);
  assert.deepEqual(collectTagOptions([task({ tags: ["前端", "后端"] })]), ["后端", "前端"]);
});

test("collectTagOptions：中英混排时中文按拼音排在 ASCII 之前，ASCII 之间按字母序（实测现状）", () => {
  // 实测 ["紧急","运维","API","bug"]；默认码点排序会得到 ["API","bug","紧急","运维"]
  assert.deepEqual(collectTagOptions([task({ tags: ["运维", "API", "bug", "紧急"] })]), [
    "紧急",
    "运维",
    "API",
    "bug",
  ]);
});

test("collectTagOptions：丢弃空串与 null 标签，但保留标签内的首尾空格与大小写差异", () => {
  assert.deepEqual(collectTagOptions([task({ tags: dirty<string[]>([null, "", "前端", ""]) })]), ["前端"]);
  assert.deepEqual(collectTagOptions([task({ tags: [" 前端 "] })]), [" 前端 "]);
  assert.deepEqual(collectTagOptions([task({ tags: ["Web", "web"] })]), ["web", "Web"]);
  assert.deepEqual(collectTagOptions([task({ tags: ["10", "9"] })]), ["10", "9"], "不做数字排序");
});

test("collectTagOptions：单个非字符串标签会原样漏出，两个以上则因 localeCompare 崩溃", () => {
  // 实测行为：sort 的比较器只在元素 >=2 时被调用，所以"一个脏标签"静默返回脏值
  assert.deepEqual(collectTagOptions([task({ tags: dirty<string[]>([1]) })]), [1]);
  assert.throws(() => collectTagOptions([task({ tags: dirty<string[]>([1, 2]) })]), TypeError);
  assert.throws(() => collectTagOptions([task({ tags: dirty<string[]>({}) })]), TypeError);
});

test("collectTagOptions：入参不是数组时抛 TypeError；传字符串则静默返回空数组", () => {
  // "ab" 可被 for...of 逐字符迭代，每个字符的 .tags 走 ?? [] 兜底，于是不报错也不报错数据
  assert.throws(() => collectTagOptions(dirty<Task[]>(null)), TypeError);
  assert.throws(() => collectTagOptions(dirty<Task[]>(undefined)), TypeError);
  assert.throws(() => collectTagOptions(dirty<Task[]>({})), TypeError);
  assert.deepEqual(collectTagOptions(dirty<Task[]>("ab")), []);
});

// ── tasksSignature ───────────────────────────────────────────────────────

test("tasksSignature：空数组返回空字符串，单条返回固定格式（id:status:priority:title:agent:due|tags:updated）", () => {
  assert.equal(tasksSignature([]), "");
  assert.equal(tasksSignature([task()]), "t1:todo:1:登录页改版:a1:|:2026-01-02T00:00:00Z");
});

test("tasksSignature：多任务以换行连接，顺序变化必须改变签名", () => {
  const a = task({ id: "a" });
  const b = task({ id: "b", title: "支付回调" });
  assert.equal(
    tasksSignature([a, b]),
    "a:todo:1:登录页改版:a1:|:2026-01-02T00:00:00Z\nb:todo:1:支付回调:a1:|:2026-01-02T00:00:00Z",
  );
  assert.notEqual(tasksSignature([a, b]), tasksSignature([b, a]), "顺序敏感是轮询去重的前提");
});

test("tasksSignature：参与指纹的任一字段变化都必须改变签名（漏一个字段 = 界面不刷新）", () => {
  const base = task();
  const baseSig = tasksSignature([base]);
  const variants: [string, Task][] = [
    ["status", task({ status: "doing" })],
    ["priority", task({ priority: 9 })],
    ["title", task({ title: "别的标题" })],
    ["assigned_agent_id", task({ assigned_agent_id: "a2" })],
    ["due_date", task({ due_date: "2026-02-01" })],
    ["tags", task({ tags: ["前端"] })],
    ["updated_at", task({ updated_at: "2026-01-03T00:00:00Z" })],
    ["id", task({ id: "other" })],
  ];
  for (const [field, changed] of variants) {
    assert.notEqual(tasksSignature([changed]), baseSig, `${field} 变化后签名必须不同`);
  }
});

test("tasksSignature：标签顺序不同视为不同内容（实测现状，会带来一次多余重渲染）", () => {
  assert.notEqual(tasksSignature([task({ tags: ["a", "b"] })]), tasksSignature([task({ tags: ["b", "a"] })]));
});

test("tasksSignature：description 不参与指纹，改描述不会触发换引用", () => {
  assert.equal(tasksSignature([task({ description: "换了个描述" })]), tasksSignature([task()]));
});

test("tasksSignature【疑似缺陷】：status 没有 ?? 兜底，字段缺失时会往签名里写进字面量 'undefined'", () => {
  // 其余字段都写了 `?? ""` / `?? 0`，唯独 status 直接插值；缺字段的脏数据会产生
  // "z:undefined:0:::|:" 这种签名，与真正的 status 值无法区分
  assert.equal(tasksSignature([dirty<Task>({ id: "z" })]), "z:undefined:0:::|:");
  assert.equal(tasksSignature([task({ status: dirty<Task["status"]>(undefined) })]), "t1:undefined:1:登录页改版:a1:|:2026-01-02T00:00:00Z");
  assert.equal(tasksSignature([task({ status: "todo" })]), "t1:todo:1:登录页改版:a1:|:2026-01-02T00:00:00Z");
});

test("tasksSignature：同内容不同数组实例必须得到相同值（轮询去重的地基）", () => {
  const p1 = [task({ id: "p1" })];
  const p2 = [task({ id: "p1" })];
  assert.notEqual(p1, p2);
  assert.equal(tasksSignature(p1), tasksSignature(p2));
  assert.equal(tasksSignature(p1), tasksSignature(p1));
});

test("tasksSignature【已证实的碰撞】：字段值里含换行时，1 条任务与 2 条任务签名完全相同", () => {
  // 实测：分隔符 \n 与 : 未做转义。只要任一文本字段里出现 \n，两种不同任务列表就会撞出同一签名，
  // 轮询比对会误判为"数据没变"从而跳过重渲染，界面停留在旧数据。锁定现状以便将来定位。
  const a = task({ id: "a", title: "x", updated_at: "U\nb:todo:1:x:a1:|:V" });
  const b = task({ id: "a", title: "x", updated_at: "U" });
  const c = task({ id: "b", title: "x", updated_at: "V" });
  assert.equal(tasksSignature([a]), tasksSignature([b, c]));
});

test("tasksSignature：入参为 null / undefined 时抛 TypeError", () => {
  assert.throws(() => tasksSignature(dirty<Task[]>(null)), TypeError);
  assert.throws(() => tasksSignature(dirty<Task[]>(undefined)), TypeError);
});

// ── agentsSignature ──────────────────────────────────────────────────────

test("agentsSignature：空数组返回空字符串，单条返回 id:name:status:model:current_task_id", () => {
  assert.equal(agentsSignature([]), "");
  assert.equal(agentsSignature([agent()]), "a1:小工:working:claude-code:t1");
});

test("agentsSignature：缺 model / current_task_id 时以空串占位，仍是五段", () => {
  assert.equal(agentsSignature([dirty<Agent>({ id: "a2", name: "小美", status: "idle" })]), "a2:小美:idle::");
  assert.equal(
    agentsSignature([agent({ model: dirty<string>(undefined), current_task_id: null })]),
    "a1:小工:working::",
  );
});

test("agentsSignature：last_used_at / system_prompt / cli_* 不参与指纹", () => {
  const base = agentsSignature([agent()]);
  assert.equal(agentsSignature([agent({ last_used_at: "2099-01-01T00:00:00Z" })]), base);
  assert.equal(agentsSignature([agent({ system_prompt: "换了个提示词" })]), base);
  assert.equal(agentsSignature([agent({ cli_version: "9.9.9", cli_path: "/x" })]), base);
});

test("agentsSignature：多 agent 按换行连接，顺序变化改变签名；入参为 null 抛 TypeError", () => {
  assert.equal(agentsSignature([agent(), agent({ id: "a2" })]), "a1:小工:working:claude-code:t1\na2:小工:working:claude-code:t1");
  assert.notEqual(agentsSignature([agent(), agent({ id: "a2" })]), agentsSignature([agent({ id: "a2" }), agent()]));
  assert.throws(() => agentsSignature(dirty<Agent[]>(null)), TypeError);
  assert.throws(() => agentsSignature(dirty<Agent[]>(undefined)), TypeError);
});

// ── projectsSignature ────────────────────────────────────────────────────

test("projectsSignature：空数组返回空字符串，单条返回 id:name:description:updated_at", () => {
  assert.equal(projectsSignature([]), "");
  assert.equal(projectsSignature([project()]), "p1:官网:官网改版:2026-01-02T00:00:00Z");
});

test("projectsSignature：缺 description / updated_at 时以空串占位，name 或 updated_at 变化会改签名", () => {
  assert.equal(projectsSignature([dirty<Project>({ id: "p2", name: "后台" })]), "p2:后台::");
  assert.notEqual(projectsSignature([project({ name: "官网改版" })]), projectsSignature([project()]));
  assert.notEqual(
    projectsSignature([project({ updated_at: "2026-03-01T00:00:00Z" })]),
    projectsSignature([project()]),
  );
});

test("projectsSignature：多项目按换行连接；入参为 null 抛 TypeError", () => {
  assert.equal(projectsSignature([project(), project({ id: "p2" })]), "p1:官网:官网改版:2026-01-02T00:00:00Z\np2:官网:官网改版:2026-01-02T00:00:00Z");
  assert.throws(() => projectsSignature(dirty<Project[]>(null)), TypeError);
  assert.throws(() => projectsSignature(dirty<Project[]>(undefined)), TypeError);
});

// ── statsSignature ───────────────────────────────────────────────────────

test("statsSignature：null 与 undefined 都返回 'null' 字面量", () => {
  // undefined 不在签名声明（ProjectStats | null）内，运行时却因 `!stats` 兜住，这里如实记录
  assert.equal(statsSignature(null), "null");
  assert.equal(statsSignature(dirty<ProjectStats | null>(undefined)), "null");
  assert.notEqual(statsSignature(null), statsSignature(stats()), "有数据时不能与 'null' 混淆");
});

test("statsSignature：正常返回 任务6项/agents4项 的 'a/b/c/d/e/f|g/h/i/j' 格式", () => {
  assert.equal(statsSignature(stats()), "10/4/2/1/1/2|3/1/1/1");
});

test("statsSignature：任一计数字段变化都必须改变签名（含全 0 的边界）", () => {
  const base = statsSignature(stats());
  const taskKeys = ["total", "todo", "doing", "waiting", "review", "done"] as const;
  for (const k of taskKeys) {
    const mutated = stats();
    mutated.tasks = { ...mutated.tasks, [k]: 99 };
    assert.notEqual(statsSignature(mutated), base, `tasks.${k} 变化后签名必须不同`);
  }
  for (const k of ["total", "working", "idle", "offline"] as const) {
    const mutated = stats();
    mutated.agents = { ...mutated.agents, [k]: 99 };
    assert.notEqual(statsSignature(mutated), base, `agents.${k} 变化后签名必须不同`);
  }
  const zeroed = stats({ tasks: { total: 0, todo: 0, doing: 0, waiting: 0, review: 0, done: 0 }, agents: { total: 0, working: 0, idle: 0, offline: 0 } });
  assert.equal(statsSignature(zeroed), "0/0/0/0/0/0|0/0/0/0");
  assert.notEqual(statsSignature(zeroed), base);
});

test("statsSignature【疑似缺陷】：计数子对象缺字段时不抛错，而是把 'undefined' 拼进签名", () => {
  assert.equal(
    statsSignature(dirty<ProjectStats>({ tasks: {}, agents: {} })),
    "undefined/undefined/undefined/undefined/undefined/undefined|undefined/undefined/undefined/undefined",
  );
  assert.throws(() => statsSignature(dirty<ProjectStats>({ tasks: null, agents: null })), TypeError);
  assert.throws(() => statsSignature(dirty<ProjectStats>({})), TypeError);
});
