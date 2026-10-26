import type { Agent, ProjectStats, Task } from "../types";
import { KANBAN_STATUSES, type KanbanStatus } from "./kanbanLayout.ts";

/**
 * 仪表盘的派生统计（W-17）。
 *
 * 关键修复：`stats` 为 null（IPC 失败 / 还没加载）时，原界面用
 * `stats?.tasks.total || 0` 渲染 —— 失败被画成「总任务 0、完成率 0%」，
 * 用户看到的是**假数据**而不是故障。这里用 null 显式表示「未知」。
 */
export function completedRate(stats: ProjectStats | null): number | null {
  if (!stats || stats.tasks.total <= 0) return null;
  return Math.round((stats.tasks.done / stats.tasks.total) * 100);
}

/** 近期活动：按 updated_at 倒序取前 N 条，返回新数组，不改入参顺序。 */
export function recentTasks(tasks: readonly Task[], limit = 8): Task[] {
  if (limit <= 0) return [];
  return [...tasks]
    .sort((a, b) => (b.updated_at ?? "").localeCompare(a.updated_at ?? ""))
    .slice(0, limit);
}

export interface AgentWorkload {
  agent: Agent;
  count: number;
}

/** 工作负载口径：只算「进行中 + 等待中」，已完成的忙不算忙。 */
export function agentWorkload(tasks: readonly Task[], agents: readonly Agent[]): AgentWorkload[] {
  const counts = new Map<string, number>();
  for (const task of tasks) {
    if (task.assigned_agent_id && (task.status === "doing" || task.status === "waiting")) {
      counts.set(task.assigned_agent_id, (counts.get(task.assigned_agent_id) ?? 0) + 1);
    }
  }
  return agents.map((agent) => ({ agent, count: counts.get(agent.id) ?? 0 }));
}

export interface StatusSlice {
  status: KanbanStatus;
  count: number;
  /** 占总数的百分比；总数为 0 时为 0（此时整块统计应当提示「暂无数据」）。 */
  percent: number;
}

export function statusDistribution(stats: ProjectStats | null): StatusSlice[] {
  if (!stats) return [];
  const total = stats.tasks.total || 1;
  return KANBAN_STATUSES.map((status) => {
    const count = stats.tasks[status] ?? 0;
    return { status, count, percent: Math.round((count / total) * 100) };
  });
}
