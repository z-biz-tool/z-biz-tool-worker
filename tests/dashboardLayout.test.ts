/**
 * W-17：仪表盘派生统计的纯规则回归。
 * 重点锁「stats 为 null 时不能伪造 0」与工作负载口径。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  agentWorkload,
  completedRate,
  recentTasks,
  statusDistribution,
} from "../src/utils/dashboardLayout.ts";
import type { Agent, ProjectStats, Task } from "../src/types/index.ts";

function task(over: Partial<Task> = {}): Task {
  return {
    id: "t1",
    project_id: "p1",
    parent_id: null,
    title: "任务",
    description: "",
    status: "doing",
    priority: 0,
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
    updated_at: "2026-01-01T00:00:00Z",
    ...over,
  };
}

function agent(id: string, over: Partial<Agent> = {}): Agent {
  return {
    id,
    project_id: "p1",
    name: id,
    system_prompt: "",
    model: "default",
    status: "idle",
    current_task_id: null,
    source: "manual",
    cli_type: null,
    local_agent_id: null,
    cli_version: null,
    cli_path: null,
    created_at: "2026-01-01T00:00:00Z",
    last_used_at: "2026-01-01T00:00:00Z",
    ...over,
  };
}

function stats(total: number, done: number): ProjectStats {
  return {
    tasks: { total, todo: 0, doing: 0, waiting: 0, review: 0, done },
    agents: { total: 0, working: 0, idle: 0, offline: 0 },
  };
}

test("completedRate：stats 为 null 返回 null（界面显示「—」，不能画成 0%）", () => {
  assert.equal(completedRate(null), null);
});

test("completedRate：总数为 0 也返回 null，避免 0/0 被说成 0%", () => {
  assert.equal(completedRate(stats(0, 0)), null);
});

test("completedRate：四舍五入到整数，100% 与部分完成都正确", () => {
  assert.equal(completedRate(stats(3, 1)), 33);
  assert.equal(completedRate(stats(3, 2)), 67);
  assert.equal(completedRate(stats(4, 4)), 100);
  assert.equal(completedRate(stats(5, 0)), 0);
});

test("recentTasks：按 updated_at 倒序取前 N，返回新数组不改入参", () => {
  const tasks = [
    task({ id: "old", updated_at: "2026-01-01T00:00:00Z" }),
    task({ id: "new", updated_at: "2026-03-01T00:00:00Z" }),
    task({ id: "mid", updated_at: "2026-02-01T00:00:00Z" }),
  ];
  assert.deepEqual(recentTasks(tasks, 2).map((t) => t.id), ["new", "mid"]);
  assert.deepEqual(tasks.map((t) => t.id), ["old", "new", "mid"], "不能就地排序轮询缓存");
  assert.equal(recentTasks(tasks, 0).length, 0);
  assert.equal(recentTasks(tasks, 8).length, 3);
});

test("recentTasks：updated_at 缺失按空串处理，不抛错", () => {
  const tasks = [task({ id: "ok" }), task({ id: "missing", updated_at: undefined as unknown as string })];
  assert.equal(recentTasks(tasks).length, 2);
});

test("agentWorkload：只统计 doing/waiting，todo/done/未分配不计", () => {
  const agents = [agent("a1"), agent("a2")];
  const tasks = [
    task({ id: "1", status: "doing", assigned_agent_id: "a1" }),
    task({ id: "2", status: "waiting", assigned_agent_id: "a1" }),
    task({ id: "3", status: "todo", assigned_agent_id: "a1" }),
    task({ id: "4", status: "done", assigned_agent_id: "a1" }),
    task({ id: "5", status: "doing", assigned_agent_id: null }),
  ];
  assert.deepEqual(
    agentWorkload(tasks, agents).map(({ agent, count }) => [agent.id, count]),
    [
      ["a1", 2],
      ["a2", 0],
    ],
  );
});

test("agentWorkload：输出顺序跟随 agents，不因任务多少重排", () => {
  const agents = [agent("z"), agent("a")];
  const tasks = [task({ assigned_agent_id: "a" }), task({ assigned_agent_id: "a" })];
  assert.deepEqual(agentWorkload(tasks, agents).map((w) => w.agent.id), ["z", "a"]);
});

test("statusDistribution：stats 为 null 返回空数组，界面据此显示错误而不是 0%", () => {
  assert.deepEqual(statusDistribution(null), []);
});

test("statusDistribution：五列固定顺序，百分比按 total 取整", () => {
  const slices = statusDistribution({
    tasks: { total: 3, todo: 1, doing: 1, waiting: 0, review: 0, done: 1 },
    agents: { total: 0, working: 0, idle: 0, offline: 0 },
  });
  assert.deepEqual(slices.map((s) => s.status), ["todo", "doing", "waiting", "review", "done"]);
  assert.deepEqual(slices.map((s) => s.count), [1, 1, 0, 0, 1]);
  assert.deepEqual(slices.map((s) => s.percent), [33, 33, 0, 0, 33]);
});
