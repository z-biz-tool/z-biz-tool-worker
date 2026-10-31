/**
 * zbiz:// 深链接的 **worker 语义层**。
 *
 * ## 分工
 *
 * | 层 | 在哪 | 管什么 |
 * |----|----|--------|
 * | 协议 | `z-biz-tool-shared/protocol` | 字节级编解码（金标 = Rust `cap-hub`） |
 * | 机制 | `z-biz-tool-shared/protocol` 的 `startDeepLinkReceiver` | 冷启动补取、事件监听、不静默吞掉 |
 * | **语义** | **本文件** | **收到深链后 worker 该做什么** |
 *
 * ## worker 支持的动作
 *
 * | action | 含义 |
 * |--------|------|
 * | `open` | 唤到前台（缺省 action）。无参数时纯唤起，不报错 |
 *
 * `open` 带参数时定位到具体位置。
 *
 * ## 支持的参数
 *
 * | 参数 | 作用 |
 * |------|------|
 * | `view`   | 切到某个视图：`dashboard` \| `kanban` \| `list` \| `calendar` \| `gantt` \| `documents` \| `agents` \| `settings`（白名单外 ⇒ problem「不认识的视图 X」） |
 * | `project`| 选中并加载某个项目（按 id）。id 是否存在由运行时（已加载的项目列表）判定 |
 * | `task`   | 定位某个任务（按 id）。**任务从属于项目**，所以 `task` 必须和 `project` 一起给，否则 problem「定位任务需要同时指定 project」 |
 * | `from`   | 发送方，仅用于日志与回执 |
 *
 * 视图白名单在此本地维护，而不去 import `viewStore` —— `viewStore` 在模块加载时
 * 会碰 localStorage（zustand persist），会让纯函数单测在 node --experimental-strip-types
 * 下因 `localStorage is not defined` 崩掉。语义层只该依赖类型与纯白名单。
 */

import type { Handoff } from "z-biz-tool-shared/protocol";

/** worker 的视图白名单，与 `src/stores/viewStore.ts` 的 `VIEW_ORDER` 保持一致 */
export const WORKER_VIEWS = [
  "dashboard",
  "kanban",
  "list",
  "calendar",
  "gantt",
  "documents",
  "agents",
  "settings",
] as const;

export type WorkerView = (typeof WORKER_VIEWS)[number];

/**
 * worker 的深链结果。
 *
 * `view` / `projectId` / `taskId` 非 null 表示要切视图 / 选中项目 / 定位任务；
 * `problem` 非 null 表示接不住 —— 前端必须给可见提示（不静默吞掉）。
 */
export interface WorkerDeepLinkOutcome {
  /** 要切换到的视图；null 表示不带切视图意图 */
  view: WorkerView | null;
  /** 要选中的项目 id；null 表示不带选项目意图 */
  projectId: string | null;
  /** 要定位的任务 id；null 表示不带定位任务意图 */
  taskId: string | null;
  /** 发送方（from），仅用于提示与日志 */
  from: string | null;
  /** 无法适配时的原因 */
  problem: string | null;
}

/**
 * 把一条深链翻译成 worker 内的动作。
 *
 * 纯函数 —— 不碰 React state、不碰 Tauri、不碰 localStorage，所以可以直接单测。
 *
 * 注意：项目 / 任务 id 是否存在，**纯函数无法判断**（那要查数据库）。
 * 这里只做「参数是否合法、动作是否认识」的校验；id 真正存不存在留给运行时
 * 的 onEffect（已在加载的项目列表里查不到就报可见提示）。
 *
 * @param item 深链
 */
export function resolveWorkerDeepLink(item: Handoff): WorkerDeepLinkOutcome {
  const outcome: WorkerDeepLinkOutcome = {
    view: null,
    projectId: null,
    taskId: null,
    from: item.params.from ?? null,
    problem: null,
  };

  const action = item.action.trim() || "open";
  if (action !== "open") {
    outcome.problem = `不认识的动作 ${action}`;
    return outcome;
  }

  const rawView = item.params.view?.trim() ?? "";
  const rawProject = item.params.project?.trim() ?? "";
  const rawTask = item.params.task?.trim() ?? "";

  // 视图：白名单校验
  if (rawView) {
    if ((WORKER_VIEWS as readonly string[]).includes(rawView)) {
      outcome.view = rawView as WorkerView;
    } else {
      outcome.problem = `不认识的视图 ${rawView}`;
      return outcome;
    }
  }

  // 项目：纯函数阶段只记录 id，存在性交给运行时
  if (rawProject) {
    outcome.projectId = rawProject;
  }

  // 任务：从属于项目，必须同时给 project，否则定位不了
  if (rawTask) {
    if (!rawProject) {
      outcome.problem = "定位任务需要同时指定 project";
      return outcome;
    }
    outcome.taskId = rawTask;
  }

  return outcome;
}
