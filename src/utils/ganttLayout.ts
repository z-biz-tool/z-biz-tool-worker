/**
 * 甘特图的**纯几何计算**（无 React、无 DOM、无 store）。
 *
 * 为什么要有这个文件（01 的 B4「五个视图零测试」）：
 *
 * 甘特图的全部"计算"原本埋在 `GanttView.tsx` 的组件体里 ——
 * 时间轴锚点、总天数、每天像素宽、每个表头的标签、每根任务条的 left/width。
 * 这些数字**画错一格不会抛错、不会白屏**，只会表现为"这根条子看着偏了"，
 * 而这类故障在截图里极难定位。
 *
 * 更要紧的是它们**根本没法测**：
 * - `GanttView.tsx` 是 `.tsx`，`node --experimental-strip-types` **不能** import 它
 *   （node 的类型擦除不处理 JSX）；
 * - 于是这些计算一条断言都没有，改坏了没有任何检查会拦。
 *
 * 现在把计算抽到这个 `.ts` 模块，组件只负责渲染。
 * **计算逻辑与原实现逐行等价**（不是重写，是搬家），
 * 等价性由 `tests/ganttLayout.test.ts` 逐条钉住。
 */

/** 甘特图的三档缩放。 */
export type GanttZoom = "day" | "week" | "month";

/** 状态色板（与 KanbanView / CalendarView 同一套）。 */
export const GANTT_STATUS_COLORS: Record<string, string> = {
  todo: "#d9d9d9",
  doing: "#1677ff",
  waiting: "#faad14",
  review: "#ff7a45",
  done: "#52c41a",
};

/** 状态没命中色板时的兜底色。 */
export const GANTT_FALLBACK_COLOR = "#d9d9d9";

/** 一条任务在甘特图里用到的最小字段集。 */
export interface GanttTaskLike {
  status: string;
  start_date: string | null;
  due_date: string | null;
  created_at: string;
}

/** 时间轴的锚点与尺度。 */
export interface GanttTimeline {
  /** 视窗左端（= now 往前 7 天）。 */
  startDate: Date;
  /** 视窗右端。 */
  endDate: Date;
  /** 表头格子数。 */
  totalDays: number;
  /** 每格像素宽。 */
  dayWidth: number;
}

/** 一个表头格子。 */
export interface GanttHeader {
  label: string;
  left: number;
  width: number;
}

/** 一根任务条的定位与配色。 */
export interface GanttBar {
  left: number;
  width: number;
  background: string;
}

const MS_PER_DAY = 1000 * 60 * 60 * 24;

/** 每档缩放覆盖的天数。 */
export function ganttViewDays(zoom: GanttZoom): number {
  return zoom === "day" ? 14 : zoom === "week" ? 56 : 120;
}

/** 每档缩放下"一天"占多少像素。 */
export function ganttDayWidth(zoom: GanttZoom): number {
  return zoom === "day" ? 40 : zoom === "week" ? 14 : 5;
}

/**
 * 由"现在"和缩放档位算出时间轴。
 *
 * 锚点是 **now 往前 7 天**（不是自然月/周起点）——
 * 这一点是原实现的行为，抽出来后原样保留。
 *
 * ⚠️ `totalDays` 用的是**毫秒差 / 一天**再向上取整，
 * 而 `setDate` 是**本地时区**的日期加减 ⇒ 跨夏令时的那一天只有 23 或 25 小时。
 * 实测（见 01 的问题清单 B5）：**冬令时回拨**（11 月）会让跨度多 1 小时，
 * 于是 `totalDays = viewDays + 1`（美欧等有夏令时的时区命中；
 * 无夏令时时区与南半球不落在该窗口的时区恒为 `viewDays`）。
 */
export function ganttTimeline(now: Date, zoom: GanttZoom): GanttTimeline {
  const viewDays = ganttViewDays(zoom);
  const startDate = new Date(now);
  startDate.setDate(startDate.getDate() - 7);
  const endDate = new Date(startDate);
  endDate.setDate(endDate.getDate() + viewDays);
  const totalDays = Math.ceil(
    (endDate.getTime() - startDate.getTime()) / MS_PER_DAY,
  );
  return { startDate, endDate, totalDays, dayWidth: ganttDayWidth(zoom) };
}

/**
 * 表头标签。
 * - day 档：每天都写 `月/日`
 * - week 档：只在**周一**写 `月/日`，其余留空
 * - month 档：只在**每月 1 号**写 `年/月`，其余留空
 */
export function ganttHeaderLabel(date: Date, zoom: GanttZoom): string {
  if (zoom === "day") return `${date.getMonth() + 1}/${date.getDate()}`;
  if (zoom === "week") {
    return date.getDay() === 1
      ? `${date.getMonth() + 1}/${date.getDate()}`
      : "";
  }
  return date.getDate() === 1
    ? `${date.getFullYear()}/${date.getMonth() + 1}`
    : "";
}

/** 生成整条时间轴的表头格子。 */
export function ganttHeaders(
  timeline: GanttTimeline,
  zoom: GanttZoom,
): GanttHeader[] {
  const headers: GanttHeader[] = [];
  for (let i = 0; i < timeline.totalDays; i++) {
    const d = new Date(timeline.startDate);
    d.setDate(d.getDate() + i);
    headers.push({
      label: ganttHeaderLabel(d, zoom),
      left: i * timeline.dayWidth,
      width: timeline.dayWidth,
    });
  }
  return headers;
}

/**
 * 一根任务条的 left / width / 底色。
 *
 * 起止的取法（原实现行为，逐条保留）：
 * - 起点：`start_date`，没有就用 `created_at`；
 * - 终点：`due_date`，**没有就等于起点**，然后**往后推 3 天**（给个默认跨度）；
 * - 宽度按**天数**算，最少 1 天；
 * - 像素宽度最少 20px（太短的条子看不见）。
 *
 * ⚠️ `start_date` / `due_date` 存的是 `YYYY-MM-DD`（无时刻），
 * 而 `new Date("2026-01-01")` 按 ES 规范解析成 **UTC 午夜**。
 *
 * 实测结论（8 个时区 × 6 个日期 × 4 个时刻 = 192 组）：
 * 在 **Asia/Shanghai（UTC+8，无夏令时）下定位完全稳定** ——
 * 任务条恒落在「自己的日期」那一格，与当前时刻无关。
 * 只有在**有夏令时的时区**（美/欧）且恰好跨切换点时，
 * 才有 10/192 组偏了一格（left 差 1 天的像素）。
 * 详见 01 的问题清单 B5；本函数**保持原实现不变**，
 * 这里只把「它到底会不会漂」量清楚。
 */
export function ganttBarStyle(
  task: GanttTaskLike,
  timeline: GanttTimeline,
): GanttBar {
  const start = task.start_date
    ? new Date(task.start_date)
    : new Date(task.created_at);
  const end = task.due_date ? new Date(task.due_date) : new Date(start);
  if (!task.due_date) end.setDate(end.getDate() + 3);

  const leftDays = Math.max(
    0,
    Math.ceil((start.getTime() - timeline.startDate.getTime()) / MS_PER_DAY),
  );
  const widthDays = Math.max(
    1,
    Math.ceil((end.getTime() - start.getTime()) / MS_PER_DAY),
  );

  return {
    left: leftDays * timeline.dayWidth,
    width: Math.max(widthDays * timeline.dayWidth, 20),
    background: GANTT_STATUS_COLORS[task.status] || GANTT_FALLBACK_COLOR,
  };
}
