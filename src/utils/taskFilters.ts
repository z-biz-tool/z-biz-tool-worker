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

/**
 * 字段值转义 —— 签名能不能用，全看这条。
 *
 * 原来直接插值拼接，于是换行成了数据的一部分：`:` / `\n` / `|` / `,`
 * 出现在字段值里时与"记录边界"无法区分。实测可构造出真碰撞：一条
 * `updated_at = "U\nb:todo:1:x:a1:|:V"` 的任务，与两条 `updated_at="U"` /
 * `"V"` 的任务算出**完全相同**的签名 ⇒ 轮询比对误判为"数据没变"，
 * 跳过 patch，界面停在旧数据。
 *
 * **只转义换行与反斜杠，不动 `:` / `|` / `,`。** 记录用 `\n` 连接，
 * 只要字段值里不再出现裸换行，记录边界就唯一可解，固定字段数下
 * `:` 的歧义自然消失。反过来说，多转义 `:` 会把签名里每一个分隔符
 * 都变成 `\:`，签名变得又长又丑，还平白改掉了普通数据的既有格式。
 *
 * 签名只用于内存里前后比对（workerStore 里 signature(new) !==
 * signature(prev)），从不落盘也不上行，所以这个改法无迁移成本。
 */
const esc = (v: unknown): string => String(v ?? "").replace(/[\\\n\r]/g, (c) => `\\${c}`);

export function tasksSignature(tasks: Task[]): string {
  return tasks
    .map(
      (t) =>
        `${esc(t.id)}:${esc(t.status)}:${t.priority ?? 0}:${esc(t.title)}:${esc(t.assigned_agent_id)}:${
          esc(t.due_date) + "|" + (t.tags ?? []).map(esc).join(",")
        }:${esc(t.updated_at)}`,
    )
    .join("\n");
}

export function agentsSignature(agents: Agent[]): string {
  return agents
    .map((a) => `${esc(a.id)}:${esc(a.name)}:${esc(a.status)}:${esc(a.model)}:${esc(a.current_task_id)}`)
    .join("\n");
}

export function projectsSignature(projects: Project[]): string {
  return projects
    .map((p) => `${esc(p.id)}:${esc(p.name)}:${esc(p.description)}:${esc(p.updated_at)}`)
    .join("\n");
}

export function statsSignature(stats: ProjectStats | null): string {
  if (!stats) return "null";
  const t = stats.tasks;
  const a = stats.agents;
  return `${t.total}/${t.todo}/${t.doing}/${t.waiting}/${t.review}/${t.done}|${a.total}/${a.working}/${a.idle}/${a.offline}`;
}
