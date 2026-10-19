/**
 * 日历视图的**纯日期计算**（无 React、无 DOM、无 store）。
 *
 * 为什么要有这个文件（01 的 B4「五个视图零测试」）：
 *
 * 日历最容易被写错的地方是**月边界**：
 * - 这个月有几天（2 月闰年 29 / 平年 28，4/6/9/11 月 30 天）；
 * - 1 号是星期几 ⇒ 前面要垫几格空白（日历是周日开头）；
 * - 月份翻页时 `new Date(year, month - 1, 1)` 在 month=0 时要退到**上一年 12 月**。
 *
 * 这些一旦算错，界面上就是"这个月多出一行/少一天"，
 * 不抛错、不白屏，截图里看着还挺像那么回事 —— 极难定位。
 *
 * 而且原实现埋在 `CalendarView.tsx`（`.tsx`）里，
 * `node --experimental-strip-types` **不能** import `.tsx`
 * ⇒ 一个月边界 bug 可以从上线活到被人手动发现。
 *
 * 现在把计算抽到这个 `.ts` 模块，组件只负责渲染。
 * **计算逻辑与原实现逐行等价**（不是重写，是搬家），
 * 等价性由 `tests/calendarLayout.test.ts` 逐条钉住。
 */

/** 日历里用来归组任务的最小字段集。 */
export interface CalendarTaskLike {
  due_date: string | null;
}

/**
 * 某年某月的天数。`month` 是 **0 基**（0 = 1 月），与 `Date` 一致。
 *
 * 用 `new Date(year, month + 1, 0)` 取"下个月的 0 号"= 本月最后一天。
 * `month + 1` 到 12 时 `new Date(year, 12, 0)` = 当年 12 月 31 日，自动收口。
 */
export function daysInMonthOf(year: number, month: number): number {
  return new Date(year, month + 1, 0).getDate();
}

/**
 * 某年某月 1 号是星期几（0 = 周日）。日历表头是「日一二三四五六」，
 * 所以这个值就是**前面要垫几格空白**。
 */
export function firstWeekdayOfMonth(year: number, month: number): number {
  return new Date(year, month, 1).getDay();
}

/**
 * 铺满整月的格子数组：前面是 `null` 占位，后面是 1..daysInMonth。
 *
 * 例：2026 年 10 月 1 号是周四 ⇒ `[null, null, null, 1, 2, ... , 31]`
 *（`null` 的个数 = firstWeekdayOfMonth）。
 */
export function monthGrid(year: number, month: number): (number | null)[] {
  const firstDay = firstWeekdayOfMonth(year, month);
  const daysInMonth = daysInMonthOf(year, month);
  const cells: (number | null)[] = [];
  for (let i = 0; i < firstDay; i++) cells.push(null);
  for (let i = 1; i <= daysInMonth; i++) cells.push(i);
  return cells;
}

/** 拼成 `YYYY-MM-DD`。月/日都是两位。 */
export function formatDateKey(
  year: number,
  month: number,
  day: number,
): string {
  return `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/**
 * 按**截止日期**把任务归到 `YYYY-MM-DD` 桶里。
 *
 * 只看日期字符串的前 10 位（`YYYY-MM-DD`），**不做时区换算** ——
 * 所以跨时区不会把任务挪到别的一天，这是刻意的（见 01 的问题清单）。
 */
export function groupTasksByDueDate<T extends CalendarTaskLike>(
  tasks: readonly T[],
): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const t of tasks) {
    if (!t.due_date) continue;
    const key = t.due_date.slice(0, 10);
    const bucket = map.get(key);
    if (bucket) bucket.push(t);
    else map.set(key, [t]);
  }
  return map;
}

/**
 * 翻到上/下个月的第一天。
 * `new Date(year, -1, 1)` 会自动退到**上一年 12 月 1 日**，
 * `new Date(year, 12, 1)` 会自动进到**下一年 1 月 1 日**。
 */
export function shiftMonth(year: number, month: number, delta: number): Date {
  return new Date(year, month + delta, 1);
}
