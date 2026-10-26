/**
 * W-17：看板视图的纯规则回归。
 *
 * 这些规则原先只存在于 KanbanView.tsx 的事件回调里，node 测试跑不了 .tsx，
 * 导致「拖回原列也弹成功」「拖到空列没反应」这类问题没有任何自动化保护。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  KANBAN_STATUSES,
  countUngroupedTasks,
  groupTasksByStatus,
  isKanbanStatus,
  resolveDropStatus,
  statusAfterCreate,
} from "../src/utils/kanbanLayout.ts";
import type { Task } from "../src/types/index.ts";

function task(over: Partial<Task> = {}): Task {
  return {
    id: "t1",
    project_id: "p1",
    parent_id: null,
    title: "任务",
    description: "",
    status: "todo",
    priority: 0,
    start_date: null,
    due_date: null,
    milestone: false,
    assigned_agent_id: null,
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

test("看板列顺序固定为 todo/doing/waiting/review/done", () => {
  assert.deepEqual([...KANBAN_STATUSES], ["todo", "doing", "waiting", "review", "done"]);
});

test("isKanbanStatus 只认五列；大小写、空串、非字符串一律否", () => {
  for (const s of KANBAN_STATUSES) assert.equal(isKanbanStatus(s), true);
  assert.equal(isKanbanStatus("Doing"), false);
  assert.equal(isKanbanStatus(""), false);
  assert.equal(isKanbanStatus(null), false);
  assert.equal(isKanbanStatus(1), false);
});

test("groupTasksByStatus 保持列内原有顺序，且每列都是新数组", () => {
  const tasks = [
    task({ id: "a", status: "doing" }),
    task({ id: "b", status: "todo" }),
    task({ id: "c", status: "doing" }),
  ];
  const groups = groupTasksByStatus(tasks);
  assert.deepEqual(groups.doing.map((t) => t.id), ["a", "c"]);
  assert.deepEqual(groups.todo.map((t) => t.id), ["b"]);
  assert.deepEqual(groups.done, []);
  groups.doing.push(task({ id: "injected" }));
  assert.equal(tasks.length, 3, "分组不能把新元素写回入参");
});

test("groupTasksByStatus 不把未知状态塞进任何一列，但 countUngroupedTasks 能数出来", () => {
  const tasks = [task({ id: "x", status: "blocked" as Task["status"] }), task({ id: "y" })];
  const groups = groupTasksByStatus(tasks);
  assert.deepEqual(groups.todo.map((t) => t.id), ["y"]);
  assert.equal(countUngroupedTasks(tasks), 1, "未知状态必须可被提示，不能静默消失");
  assert.equal(countUngroupedTasks([task()]), 0);
});

test("拖到列容器（空列）⇒ 解析出目标列", () => {
  const tasks = [task({ id: "a", status: "todo" })];
  assert.deepEqual(resolveDropStatus("a", "doing", tasks), {
    taskId: "a",
    fromStatus: "todo",
    toStatus: "doing",
  });
});

test("拖到别的任务上 ⇒ 用那个任务的状态", () => {
  const tasks = [task({ id: "a", status: "todo" }), task({ id: "b", status: "review" })];
  assert.equal(resolveDropStatus("a", "b", tasks)?.toStatus, "review");
});

test("拖回原列 / 拖到自己身上 ⇒ null（不写库、不弹成功）", () => {
  const tasks = [task({ id: "a", status: "doing" }), task({ id: "b", status: "doing" })];
  assert.equal(resolveDropStatus("a", "doing", tasks), null);
  assert.equal(resolveDropStatus("a", "b", tasks), null, "同列任务间排序不应触发状态写库");
  assert.equal(resolveDropStatus("a", "a", tasks), null);
});

test("over 为空、目标不存在、活动任务不存在 ⇒ null", () => {
  const tasks = [task({ id: "a", status: "todo" })];
  assert.equal(resolveDropStatus("a", null, tasks), null);
  assert.equal(resolveDropStatus("a", undefined, tasks), null);
  assert.equal(resolveDropStatus("a", "missing-task", tasks), null);
  assert.equal(resolveDropStatus("missing", "doing", tasks), null);
});

test("活动任务状态未知 ⇒ 不猜目标，返回 null", () => {
  const tasks = [task({ id: "a", status: "blocked" as Task["status"] })];
  assert.equal(resolveDropStatus("a", "doing", tasks), null);
});

test("列 id 与任务 id 不可能同时成立，但列目标优先", () => {
  // 若某任务 id 恰好叫 "done"，拖到它上面也应按「done 列」处理
  const tasks = [task({ id: "a", status: "todo" }), task({ id: "done", status: "review" })];
  assert.equal(resolveDropStatus("a", "done", tasks)?.toStatus, "done");
});

test("statusAfterCreate：在非 todo 列新建时补一次流转，todo 列不补", () => {
  assert.equal(statusAfterCreate("doing", "todo"), "doing");
  assert.equal(statusAfterCreate("todo", "todo"), null);
  assert.equal(statusAfterCreate("bogus", "todo"), null);
});
