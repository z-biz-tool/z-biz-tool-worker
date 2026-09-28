import type { Agent, Project, ProjectStats, Task } from "../types";

export interface TaskFilterState {
  query: string;
  priority: number | null;
  agentId: string | null;
  tags: string[];
}

export const EMPTY_FILTERS: TaskFilterState = {
  query: "",
  priority: null,
  agentId: null,
  tags: [],
};

export function hasActiveFilter(f: TaskFilterState): boolean {
  return f.query.trim() !== "" || f.priority !== null || f.agentId !== null || f.tags.length > 0;
}

export function filterTasks(tasks: Task[], f: TaskFilterState): Task[] {
  const q = f.query.trim().toLowerCase();
  return tasks.filter((t) => {
    if (q) {
      const hay = `${t.title ?? ""}\n${t.description ?? ""}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    if (f.priority !== null && (t.priority ?? 0) !== f.priority) return false;
    if (f.agentId !== null && t.assigned_agent_id !== f.agentId) return false;
    // 标签多选按"命中任一"：AND 语义在标签稀少时几乎必然空集，看着像筛选坏了
    if (f.tags.length > 0 && !f.tags.some((tag) => (t.tags ?? []).includes(tag))) return false;
    return true;
  });
}

/** 标签选项直接从当前任务集派生，省掉一次 list_tags 的 IPC。 */
export function collectTagOptions(tasks: Task[]): string[] {
  const set = new Set<string>();
  for (const t of tasks) for (const tag of t.tags ?? []) if (tag) set.add(tag);
  return Array.from(set).sort((a, b) => a.localeCompare(b, "zh-CN"));
}

// ── 指纹比对：轮询回来的整包先算签名，没变就不换引用，避免空转重渲染 ──

export function tasksSignature(tasks: Task[]): string {
  return tasks
    .map(
      (t) =>
        `${t.id}:${t.status}:${t.priority ?? 0}:${t.title ?? ""}:${t.assigned_agent_id ?? ""}:${
          (t.due_date ?? "") + "|" + (t.tags ?? []).join(",")
        }:${t.updated_at ?? ""}`,
    )
    .join("\n");
}

export function agentsSignature(agents: Agent[]): string {
  return agents
    .map((a) => `${a.id}:${a.name}:${a.status}:${a.model ?? ""}:${a.current_task_id ?? ""}`)
    .join("\n");
}

export function projectsSignature(projects: Project[]): string {
  return projects.map((p) => `${p.id}:${p.name}:${p.description ?? ""}:${p.updated_at ?? ""}`).join("\n");
}

export function statsSignature(stats: ProjectStats | null): string {
  if (!stats) return "null";
  const t = stats.tasks;
  const a = stats.agents;
  return `${t.total}/${t.todo}/${t.doing}/${t.waiting}/${t.review}/${t.done}|${a.total}/${a.working}/${a.idle}/${a.offline}`;
}
