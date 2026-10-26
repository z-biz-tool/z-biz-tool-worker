import type { Task } from "../types";

/**
 * 看板列状态 —— 列的**唯一真源**。
 *
 * 抽出来的原因（W-17）：原来这些规则（分组、拖到哪一列算数、同列不写库）
 * 全写在 `KanbanView.tsx` 的 JSX 与事件回调里，而 `tests/*.test.ts` 用
 * `node --experimental-strip-types` 只能跑 `.ts`，`.tsx` 里的规则一行都测不到。
 * 于是「拖到空列没反应」这种缺陷只能靠人眼发现。
 */
export const KANBAN_STATUSES = ["todo", "doing", "waiting", "review", "done"] as const;
export type KanbanStatus = (typeof KANBAN_STATUSES)[number];

export function isKanbanStatus(value: unknown): value is KanbanStatus {
  return typeof value === "string" && (KANBAN_STATUSES as readonly string[]).includes(value);
}

/** 按状态分组。列的先后顺序固定，未知状态的任务不塞进任何一列。 */
export function groupTasksByStatus(tasks: readonly Task[]): Record<KanbanStatus, Task[]> {
  const groups = {
    todo: [],
    doing: [],
    waiting: [],
    review: [],
    done: [],
  } as Record<KanbanStatus, Task[]>;
  for (const task of tasks) {
    if (isKanbanStatus(task.status)) groups[task.status].push(task);
  }
  return groups;
}

/** 状态不在五列里的任务数量：界面要提示「有任务没显示」，而不是静默吞掉。 */
export function countUngroupedTasks(tasks: readonly Task[]): number {
  return tasks.filter((t) => !isKanbanStatus(t.status)).length;
}

export interface DropResolution {
  taskId: string;
  fromStatus: KanbanStatus;
  toStatus: KanbanStatus;
}

/**
 * 把 dnd-kit 的 over 目标翻译成「任务要落到哪一列」。
 *
 * - over 是列 id（拖到空列 / 列头）⇒ 用该列；
 * - over 是任务 id ⇒ 用那个任务的状态；
 * - 拖回自己所在列、over 为空、状态未知 ⇒ null（**不写库、不弹成功**）。
 *
 * 列 id 优先于任务 id：两者理论上不会撞，但真撞了应当以明确的列目标为准。
 */
export function resolveDropStatus(
  activeId: string,
  overId: string | null | undefined,
  tasks: readonly Task[],
): DropResolution | null {
  if (!overId) return null;
  const task = tasks.find((t) => t.id === activeId);
  if (!task || !isKanbanStatus(task.status)) return null;

  let toStatus: KanbanStatus | null = null;
  if (isKanbanStatus(overId)) {
    toStatus = overId;
  } else {
    const overTask = tasks.find((t) => t.id === overId);
    if (overTask && isKanbanStatus(overTask.status)) toStatus = overTask.status;
  }
  if (!toStatus || toStatus === task.status) return null;
  return { taskId: activeId, fromStatus: task.status, toStatus };
}

/**
 * 新建任务时要补的一次状态流转。
 *
 * 后端 `create_task` 只建 todo；看板上「在 doing 列点 +」原本记了
 * `newTaskStatus` 却没人用 ⇒ 用户以为建在做中，任务却出现在待处理。
 * 返回 null 表示无需补。
 */
export function statusAfterCreate(requested: string, created: string): KanbanStatus | null {
  if (!isKanbanStatus(requested) || requested === created) return null;
  return requested;
}
