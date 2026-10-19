/**
 * src/utils/calendarLayout.ts 的纯日期计算回归（无 React、无 DOM、无 store、无 IPC）。
 *
 * 为什么这个文件该有测试（01 的 B4「五个视图零测试」）：
 *   日历最容易写错的是**月边界** —— 这个月有几天、1 号是星期几要垫几格空白、
 *   跨年翻页会不会退错月份。算错了界面上就是"这个月多一行/少一天"，
 *   不抛错、不白屏，截图里看着还挺像那么回事，极难定位。
 *   加上 `.tsx` 无法被 `node --experimental-strip-types` import
 *   ⇒ 搬到这里之前，月边界一次都没被验证过。
 *
 * 本文件所有期望值均由**实际运行探针实测**得到，不是照着实现脑补的。
 *
 * 跑法：node --experimental-strip-types --test tests/*.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  daysInMonthOf,
  firstWeekdayOfMonth,
  formatDateKey,
  groupTasksByDueDate,
  monthGrid,
  shiftMonth,
} from "../src/utils/calendarLayout.ts";

// 日历的"月"是 0 基（0 = 1 月），与 JS 的 Date 一致。
// 表头是「日一二三四五六」⇒ 周日 = 0。

// ── 每月天数 ───────────────────────────────────────────────────────────

test("daysInMonthOf：常规月份与大小月", () => {
  assert.equal(daysInMonthOf(2026, 0), 31, "1 月");
  assert.equal(daysInMonthOf(2026, 3), 30, "4 月");
  assert.equal(daysInMonthOf(2026, 8), 30, "9 月");
  assert.equal(daysInMonthOf(2026, 9), 31, "10 月");
  assert.equal(daysInMonthOf(2026, 11), 31, "12 月");
  assert.equal(daysInMonthOf(2026, 5), 30, "6 月");
  assert.equal(daysInMonthOf(2026, 10), 30, "11 月");
});

test("daysInMonthOf：2 月的闰年判定（含 100 / 400 年规则）", () => {
  assert.equal(daysInMonthOf(2026, 1), 28, "2026 平年");
  assert.equal(daysInMonthOf(2024, 1), 29, "2024 闰年（4 年一闰）");
  assert.equal(daysInMonthOf(2000, 1), 29, "2000 闰年（400 年一闰）");
  assert.equal(daysInMonthOf(1900, 1), 28, "1900 不是闰年（100 年不闰）");
  assert.equal(daysInMonthOf(2100, 1), 28, "2100 不是闰年");
});

test("daysInMonthOf：12 月后不越界（month+1 溢出到次年也算对）", () => {
  // 实现用 `new Date(year, month + 1, 0)` 取"下个月的 0 号"，
  // month=11 时下个月是次年 1 月，0 号即当年 12 月 31 日。
  assert.equal(daysInMonthOf(2026, 11), 31);
  assert.equal(daysInMonthOf(2026, 0), 31);
});

// ── 1 号是周几 ────────────────────────────────────────────────────────

test("firstWeekdayOfMonth：已知日期的星期", () => {
  // 2026-01-01 是周四(4)；2026-10-01 也是周四(4)
  assert.equal(firstWeekdayOfMonth(2026, 0), 4);
  assert.equal(firstWeekdayOfMonth(2026, 9), 4);
  // 2026-02-01 是周日(0)
  assert.equal(firstWeekdayOfMonth(2026, 1), 0);
  // 2026-06-01 是周一(1)
  assert.equal(firstWeekdayOfMonth(2026, 5), 1);
});

test("firstWeekdayOfMonth：2 月闰年与平年的 1 号星期不同", () => {
  // 2024-02-01 是周四(4)；2025-02-01 是周六(6)
  assert.equal(firstWeekdayOfMonth(2024, 1), 4);
  assert.equal(firstWeekdayOfMonth(2025, 1), 6);
});

// ── 整月格子 ──────────────────────────────────────────────────────────

test("monthGrid：前面垫空白格，后面是 1..N", () => {
  const grid = monthGrid(2026, 9); // 2026-10-01 是周四 ⇒ 垫 4 格
  assert.equal(grid.length, 4 + 31);
  assert.deepEqual(grid.slice(0, 6), [null, null, null, null, 1, 2]);
  assert.equal(grid[grid.length - 1], 31);
  assert.equal(grid.filter((c) => c === null).length, 4);
});

test("monthGrid：1 号是周日时不垫任何空格", () => {
  const grid = monthGrid(2026, 1); // 2026-02-01 是周日
  assert.equal(grid[0], 1);
  assert.equal(grid.filter((c) => c === null).length, 0);
  assert.equal(grid.length, 28);
});

test("monthGrid：闰年 2 月是 29 天、平年是 28 天（格子总数还要加上前导空白）", () => {
  const leap = monthGrid(2024, 1);
  const plain = monthGrid(2026, 1);
  const days = (g: (number | null)[]) =>
    g.filter((c): c is number => c !== null).length;
  assert.equal(days(leap), 29, "2024-02 有 29 天");
  assert.equal(days(plain), 28, "2026-02 有 28 天");
  // 总格数 = 前导空白 + 当月天数
  assert.equal(leap.length, firstWeekdayOfMonth(2024, 1) + 29);
  assert.equal(plain.length, firstWeekdayOfMonth(2026, 1) + 28);
});

test("monthGrid：格子里出现的日期恰好是 1..当月天数，不多不少", () => {
  for (const [y, m] of [
    [2026, 0],
    [2026, 1],
    [2024, 1],
    [2026, 9],
    [2026, 11],
  ] as [number, number][]) {
    const grid = monthGrid(y, m);
    const numbers = grid.filter((c): c is number => c !== null);
    assert.deepEqual(
      numbers,
      Array.from({ length: daysInMonthOf(y, m) }, (_, i) => i + 1),
      `${y}-${m + 1} 的日期序列不对`,
    );
  }
});

// ── 日期键 ────────────────────────────────────────────────────────────

test("formatDateKey：月/日都是两位，年不补零", () => {
  assert.equal(formatDateKey(2026, 0, 5), "2026-01-05");
  assert.equal(formatDateKey(2026, 11, 31), "2026-12-31");
  assert.equal(formatDateKey(2026, 8, 9), "2026-09-09");
});

// ── 按截止日期归组 ────────────────────────────────────────────────────

test("groupTasksByDueDate：按 due_date 的前 10 位分桶", () => {
  const map = groupTasksByDueDate([
    { due_date: "2026-03-08" },
    { due_date: "2026-03-08T10:00:00Z" }, // 带时刻也要落到同一天
    { due_date: "2026-03-09" },
    { due_date: null },
  ]);
  assert.equal(map.size, 2, "没有 due_date 的任务不进任何桶");
  assert.equal(map.get("2026-03-08")?.length, 2);
  assert.equal(map.get("2026-03-09")?.length, 1);
  assert.equal(map.has("2026-03-08T10:00:00Z"), false);
});

test("groupTasksByDueDate：空输入返回空 Map", () => {
  assert.equal(groupTasksByDueDate([]).size, 0);
});

test("groupTasksByDueDate：全部无 due_date 时返回空 Map", () => {
  const map = groupTasksByDueDate([{ due_date: null }, { due_date: null }]);
  assert.equal(map.size, 0);
});

test("groupTasksByDueDate：同一桶里的任务保持原顺序", () => {
  const map = groupTasksByDueDate([
    { due_date: "2026-03-08", title: "a" },
    { due_date: "2026-03-08", title: "b" },
    { due_date: "2026-03-08", title: "c" },
  ]);
  assert.deepEqual(
    map.get("2026-03-08")?.map((t) => t.title),
    ["a", "b", "c"],
  );
});

// ── 翻月 ──────────────────────────────────────────────────────────────

test("shiftMonth：12 月往后翻到次年 1 月", () => {
  const d = shiftMonth(2026, 11, 1);
  assert.equal(d.getFullYear(), 2027);
  assert.equal(d.getMonth(), 0);
  assert.equal(d.getDate(), 1);
});

test("shiftMonth：1 月往前翻到上一年 12 月（month 越界自动回退）", () => {
  const d = shiftMonth(2026, 0, -1);
  assert.equal(d.getFullYear(), 2025);
  assert.equal(d.getMonth(), 11);
  assert.equal(d.getDate(), 1);
});

test("shiftMonth：普通月份前后翻页都落在当月 1 号", () => {
  const prev = shiftMonth(2026, 9, -1);
  assert.equal(prev.getFullYear(), 2026);
  assert.equal(prev.getMonth(), 8);
  assert.equal(prev.getDate(), 1);

  const next = shiftMonth(2026, 9, 1);
  assert.equal(next.getFullYear(), 2026);
  assert.equal(next.getMonth(), 10);
  assert.equal(next.getDate(), 1);
});
