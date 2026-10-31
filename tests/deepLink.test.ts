// worker 深链语义层（src/_shared/deepLink.ts）的纯函数回归。
// 跑法：node --experimental-strip-types --test tests/*.test.ts
//
// 这一层要防的是：
//   1. 白名单外视图被当成合法视图透传给 setView（界面闪到不存在的页）
//   2. 未知 action 被静默忽略（用户「点了没反应」）
//   3. task 不带 project 就被透传 —— 任务是项目下的孩子，没有项目定位不了
//   4. 参数前后空格 / 空串被当成合法值
//
// 注意：项目 / 任务 id 是否存在**不在纯函数职责内**（要查库），这里只校验
// 「参数合法、动作认识」，id 真不存在由运行时 onEffect 报可见提示。
import { test } from "node:test";
import assert from "node:assert/strict";

import { resolveWorkerDeepLink, WORKER_VIEWS } from "../src/_shared/deepLink.ts";
import type { Handoff } from "z-biz-tool-shared/protocol";

/** 造一条深链，默认 product=worker、action=open */
function mk(params: Record<string, string>, action = "open"): Handoff {
  return { product: "worker", action, params };
}

test("正常：open 不带参数 = 仅唤起，不报错", () => {
  const out = resolveWorkerDeepLink(mk({}));
  assert.equal(out.problem, null);
  assert.equal(out.view, null);
  assert.equal(out.projectId, null);
  assert.equal(out.taskId, null);
});

test("正常：open + 合法 view 切到该视图", () => {
  const out = resolveWorkerDeepLink(mk({ view: "kanban" }));
  assert.equal(out.problem, null);
  assert.equal(out.view, "kanban");
});

test("正常：每个合法视图都被认得出", () => {
  for (const v of WORKER_VIEWS) {
    const out = resolveWorkerDeepLink(mk({ view: v }));
    assert.equal(out.problem, null);
    assert.equal(out.view, v);
  }
});

test("不认识 view：白名单外视图给出 problem", () => {
  const out = resolveWorkerDeepLink(mk({ view: "nope" }));
  assert.equal(out.problem, "不认识的视图 nope");
  assert.equal(out.view, null);
});

test("正常：open + project 记录项目 id", () => {
  const out = resolveWorkerDeepLink(mk({ project: "abc123" }));
  assert.equal(out.problem, null);
  assert.equal(out.projectId, "abc123");
});

test("task 缺 project：给出 problem 不静默吞掉", () => {
  const out = resolveWorkerDeepLink(mk({ task: "t1" }));
  assert.equal(out.problem, "定位任务需要同时指定 project");
  assert.equal(out.taskId, null);
});

test("正常：task + project 同时给，都记录", () => {
  const out = resolveWorkerDeepLink(mk({ project: "p1", task: "t1" }));
  assert.equal(out.problem, null);
  assert.equal(out.projectId, "p1");
  assert.equal(out.taskId, "t1");
});

test("组合：view + project + task 三者齐全互不覆盖", () => {
  const out = resolveWorkerDeepLink(mk({ view: "list", project: "p1", task: "t1" }));
  assert.equal(out.problem, null);
  assert.equal(out.view, "list");
  assert.equal(out.projectId, "p1");
  assert.equal(out.taskId, "t1");
});

test("未知动作：非 open 一律报不认识的动作", () => {
  const out = resolveWorkerDeepLink(mk({}, "launch"));
  assert.equal(out.problem, "不认识的动作 launch");
});

test("参数前后空格：view 被 trim 后仍认得出", () => {
  const out = resolveWorkerDeepLink(mk({ view: "  kanban  " }));
  assert.equal(out.problem, null);
  assert.equal(out.view, "kanban");
});

test("空串参数：view 给空串等同于不带 view，不报错", () => {
  const out = resolveWorkerDeepLink(mk({ view: "" }));
  assert.equal(out.problem, null);
  assert.equal(out.view, null);
});

test("from 透传：发送方只用于提示与日志", () => {
  const out = resolveWorkerDeepLink(mk({ view: "dashboard", from: "box" }));
  assert.equal(out.problem, null);
  assert.equal(out.view, "dashboard");
  assert.equal(out.from, "box");
});
