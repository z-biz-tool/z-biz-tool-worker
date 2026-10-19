/**
 * src/utils/ganttLayout.ts 的纯几何计算回归（无 React、无 DOM、无 store、无 IPC）。
 *
 * 为什么这个文件该有测试（01 的 B4「五个视图零测试」）：
 *   甘特图的全部计算原本埋在 `GanttView.tsx` 里 —— 时间轴锚点、总天数、
 *   每天像素宽、每个表头的标签、每根任务条的 left/width。
 *   这些数字**画错不会抛错、不会白屏**，只会表现为"这根条子看着偏了"，
 *   而这类故障截图里极难定位。
 *   加上 `.tsx` 无法被 `node --experimental-strip-types` import
 *   ⇒ 搬到这里之前，它们一条断言都没有。
 *
 * 本文件所有期望值均由**实际运行探针实测**得到，不是照着实现脑补的。
 *
 * 跑法：node --experimental-strip-types --test tests/*.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  GANTT_FALLBACK_COLOR,
  GANTT_STATUS_COLORS,
  ganttBarStyle,
  ganttDayWidth,
  ganttHeaderLabel,
  ganttHeaders,
  ganttTimeline,
  ganttViewDays,
  type GanttZoom,
} from "../src/utils/ganttLayout.ts";

// ── 时区固定 ─────────────────────────────────────────────────────────────
//
// 甘特图的时间轴用**本地时区**的日期加减（`setDate`），
// 所以同一个 `now` 在不同时区下算出的表头标签可能不同
// （例：UTC+14 时 2026-03-10T12:00Z 已是本地 3 月 11 日凌晨，锚点就成了 3/4）。
// 这里把 TZ 钉成 UTC，让下面所有精确值断言都可复现。
//
// 运行时改 `process.env.TZ` 需要 Node ≥ 13（否则下面的"能否改 TZ"探测会给出 false），
// 探测不出来时**不静默按本机时区跑**——那种情况下精确值断言会集体变红，
// 变成一条没人看得懂的 CI 红灯。宁可明确报错。
const ORIGINAL_TZ = process.env.TZ;

function setTz(tz: string): void {
  process.env.TZ = tz;
}

function restoreTz(): void {
  if (ORIGINAL_TZ === undefined) {
    delete process.env.TZ;
  } else {
    process.env.TZ = ORIGINAL_TZ;
  }
}

/** 运行时改 TZ 是否真的生效（Node 13+ 支持）。 */
const TZ_RUNTIME_CHANGE_WORKS = (() => {
  setTz("UTC");
  const ok = Intl.DateTimeFormat().resolvedOptions().timeZone === "UTC";
  restoreTz();
  return ok;
})();

if (!TZ_RUNTIME_CHANGE_WORKS) {
  throw new Error(
    "本 Node 运行时不支持修改 process.env.TZ（需要 Node >= 13）。" +
      "甘特图测试的精确值依赖固定的时区，否则断言无法复现。",
  );
}

setTz("UTC");

/** 固定基准时刻：2026-03-10 12:00Z（UTC 周二）。 */
const NOW = new Date("2026-03-10T12:00:00Z");

function task(
  over: Partial<{
    status: string;
    start_date: string | null;
    due_date: string | null;
    created_at: string;
  }> = {},
) {
  return {
    status: over.status ?? "todo",
    start_date: over.start_date ?? null,
    due_date: over.due_date ?? null,
    created_at: over.created_at ?? "2026-03-10T12:00:00Z",
  };
}

// ── 尺度常量 ───────────────────────────────────────────────────────────

test("ganttViewDays：三档缩放各自覆盖的天数", () => {
  assert.equal(ganttViewDays("day"), 14);
  assert.equal(ganttViewDays("week"), 56);
  assert.equal(ganttViewDays("month"), 120);
});

test("ganttDayWidth：三档缩放的每格像素宽", () => {
  assert.equal(ganttDayWidth("day"), 40);
  assert.equal(ganttDayWidth("week"), 14);
  assert.equal(ganttDayWidth("month"), 5);
});

test("未知档位落到 month 之外的分支？—— 断言三档之外的行为已被钉死", () => {
  // 实现里三档都是三元表达式，非法档位会落到"否则"分支（week/month 的中间值）。
  // 这条**锁定当前行为**，提醒下一个人：真要加第四档时，这里会红。
  const bogus = "hour" as GanttZoom;
  assert.equal(ganttViewDays(bogus), 120);
  assert.equal(ganttDayWidth(bogus), 5);
});

// ── 时间轴锚点 ─────────────────────────────────────────────────────────

test("ganttTimeline：锚点是 now 往前 7 天", () => {
  const tl = ganttTimeline(NOW, "week");
  assert.equal(tl.startDate.toISOString(), "2026-03-03T12:00:00.000Z");
  assert.equal(tl.endDate.toISOString(), "2026-04-28T12:00:00.000Z");
  assert.equal(tl.totalDays, 56);
  assert.equal(tl.dayWidth, 14);
});

test("ganttTimeline：三档的起止与格数", () => {
  const day = ganttTimeline(NOW, "day");
  assert.equal(day.startDate.toISOString(), "2026-03-03T12:00:00.000Z");
  assert.equal(day.endDate.toISOString(), "2026-03-17T12:00:00.000Z");
  assert.equal(day.totalDays, 14);
  assert.equal(day.dayWidth, 40);

  const month = ganttTimeline(NOW, "month");
  assert.equal(month.startDate.toISOString(), "2026-03-03T12:00:00.000Z");
  assert.equal(month.endDate.toISOString(), "2026-07-01T12:00:00.000Z");
  assert.equal(month.totalDays, 120);
  assert.equal(month.dayWidth, 5);
});

test("ganttTimeline：totalDays 恒等于 viewDays 或 viewDays+1（夏令时多一天）", () => {
  // `totalDays` = 毫秒差/一天 向上取整，而 `setDate` 走本地日历 ——
  // 冬令时回拨（11 月）会让跨度多 1 小时，于是多出一格。
  // 这条锁住"至多多一格"这个上界，具体是否多一格由下面的夏令时用例决定。
  for (const zoom of ["day", "week", "month"] as GanttZoom[]) {
    for (const iso of [
      "2026-01-15T12:00:00Z",
      "2026-06-15T12:00:00Z",
      "2026-10-20T12:00:00Z",
    ]) {
      const tl = ganttTimeline(new Date(iso), zoom);
      const base = ganttViewDays(zoom);
      assert.ok(
        tl.totalDays === base || tl.totalDays === base + 1,
        `${zoom} @ ${iso}: totalDays=${tl.totalDays}，应在 ${base} 或 ${base + 1}`,
      );
    }
  }
});

test("ganttTimeline【夏令时】：冬令时回拨当月，有夏令时的时区多出一格", () => {
  try {
    setTz("UTC");
    assert.equal(
      ganttTimeline(new Date("2026-10-20T12:00:00Z"), "month").totalDays,
      120,
    );

    setTz("America/New_York");
    assert.equal(
      ganttTimeline(new Date("2026-10-20T12:00:00Z"), "month").totalDays,
      121,
      "美东有夏令时，回拨当月时间轴应多一天",
    );

    setTz("Europe/Berlin");
    assert.equal(
      ganttTimeline(new Date("2026-10-20T12:00:00Z"), "month").totalDays,
      121,
    );

    setTz("Asia/Shanghai");
    assert.equal(
      ganttTimeline(new Date("2026-10-20T12:00:00Z"), "month").totalDays,
      120,
      "中国大陆无夏令时，恒为 120",
    );
  } finally {
    setTz("UTC");
  }
});

// ── 表头标签 ───────────────────────────────────────────────────────────

test("ganttHeaderLabel：day 档每天都写「月/日」", () => {
  assert.equal(
    ganttHeaderLabel(new Date("2026-03-01T00:00:00Z"), "day"),
    "3/1",
  );
  assert.equal(
    ganttHeaderLabel(new Date("2026-03-09T00:00:00Z"), "day"),
    "3/9",
  );
  assert.equal(
    ganttHeaderLabel(new Date("2026-12-31T00:00:00Z"), "day"),
    "12/31",
  );
});

test("ganttHeaderLabel：week 档只在周一写标签，其余留空", () => {
  // 2026-03-09 是周一（getDay() === 1）
  assert.equal(
    ganttHeaderLabel(new Date("2026-03-09T00:00:00Z"), "week"),
    "3/9",
  );
  assert.equal(ganttHeaderLabel(new Date("2026-03-10T00:00:00Z"), "week"), "");
  assert.equal(
    ganttHeaderLabel(new Date("2026-03-08T00:00:00Z"), "week"),
    "",
    "周日不是周一",
  );
});

test("ganttHeaderLabel：month 档只在 1 号写「年/月」", () => {
  assert.equal(
    ganttHeaderLabel(new Date("2026-03-01T00:00:00Z"), "month"),
    "2026/3",
  );
  assert.equal(
    ganttHeaderLabel(new Date("2027-01-01T00:00:00Z"), "month"),
    "2027/1",
  );
  assert.equal(ganttHeaderLabel(new Date("2026-03-02T00:00:00Z"), "month"), "");
});

// ── 表头格子 ───────────────────────────────────────────────────────────

test("ganttHeaders：格子数等于 totalDays，left 逐格递增 dayWidth", () => {
  const tl = ganttTimeline(NOW, "week");
  const hs = ganttHeaders(tl, "week");
  assert.equal(hs.length, tl.totalDays);
  assert.equal(hs.length, 56);
  assert.deepEqual(hs[0], { label: "", left: 0, width: 14 });
  assert.deepEqual(hs[1], { label: "", left: 14, width: 14 });
  assert.deepEqual(hs[2], { label: "", left: 28, width: 14 });
  assert.deepEqual(hs[hs.length - 1], { label: "4/27", left: 770, width: 14 });
});

test("ganttHeaders：day 档首尾标签与递增位置", () => {
  const tl = ganttTimeline(NOW, "day");
  const hs = ganttHeaders(tl, "day");
  assert.equal(hs.length, 14);
  assert.equal(hs[0].label, "3/3");
  assert.equal(hs[1].label, "3/4");
  assert.equal(hs[2].label, "3/5");
  assert.equal(hs[hs.length - 1].label, "3/16");
  assert.equal(hs[hs.length - 1].left, 13 * 40);
});

test("ganttHeaders：每个格子的日期是锚点往后数 i 天（逐格独立复核）", () => {
  const tl = ganttTimeline(NOW, "day");
  const hs = ganttHeaders(tl, "day");
  for (let i = 0; i < hs.length; i++) {
    const d = new Date(tl.startDate);
    d.setDate(d.getDate() + i);
    const expected = `${d.getMonth() + 1}/${d.getDate()}`;
    assert.equal(hs[i].label, expected, `第 ${i} 格标签应为 ${expected}`);
    assert.equal(hs[i].left, i * tl.dayWidth);
    assert.equal(hs[i].width, tl.dayWidth);
  }
});

// ── 任务条 ─────────────────────────────────────────────────────────────

test("ganttBarStyle：有起止日期时按天数算位置与宽度", () => {
  const tl = ganttTimeline(NOW, "week");
  const bar = ganttBarStyle(
    task({ status: "doing", start_date: "2026-03-08", due_date: "2026-03-12" }),
    tl,
  );
  assert.equal(bar.left, 70); // 5 格 × 14px
  assert.equal(bar.width, 56); // 4 天 × 14px
  assert.equal(bar.background, "#1677ff");
});

test("ganttBarStyle：没有 due_date 时默认给 3 天跨度", () => {
  const tl = ganttTimeline(NOW, "week");
  const bar = ganttBarStyle(task({ start_date: "2026-03-08" }), tl);
  assert.equal(bar.left, 70);
  assert.equal(bar.width, 42); // 3 天 × 14px
});

test("ganttBarStyle：既无 start_date 也无 due_date 时用 created_at 起点", () => {
  const tl = ganttTimeline(NOW, "week");
  const bar = ganttBarStyle(task({ created_at: "2026-03-09T00:00:00Z" }), tl);
  assert.equal(bar.left, 84); // 6 格 × 14px
  assert.equal(bar.width, 42);
});

test("ganttBarStyle：起点早于视窗左端时 left 被夹到 0（不画到负坐标）", () => {
  const tl = ganttTimeline(NOW, "week");
  const bar = ganttBarStyle(
    task({ start_date: "2026-01-01", due_date: "2026-01-05" }),
    tl,
  );
  assert.equal(bar.left, 0);
  assert.equal(bar.width, 56);
});

test("ganttBarStyle：同一天起止时宽度至少 1 天", () => {
  const tl = ganttTimeline(NOW, "day");
  const bar = ganttBarStyle(
    task({ start_date: "2026-03-10", due_date: "2026-03-10" }),
    tl,
  );
  assert.equal(bar.width, 40); // 1 天 × 40px
});

test("ganttBarStyle：像素宽度有 20px 下限（month 档 1 天只有 5px）", () => {
  const tl = ganttTimeline(NOW, "month");
  const bar = ganttBarStyle(
    task({ start_date: "2026-03-10", due_date: "2026-03-10" }),
    tl,
  );
  assert.equal(bar.width, 20, "1 天 = 5px，应被抬到 20px 下限");
});

test("ganttBarStyle：底色按状态取，未知状态落兜底色", () => {
  const tl = ganttTimeline(NOW, "week");
  const cases: [string, string][] = [
    ["todo", "#d9d9d9"],
    ["doing", "#1677ff"],
    ["waiting", "#faad14"],
    ["review", "#ff7a45"],
    ["done", "#52c41a"],
    ["archived", "#d9d9d9"],
  ];
  for (const [status, color] of cases) {
    const bar = ganttBarStyle(
      task({ status, start_date: "2026-03-08", due_date: "2026-03-12" }),
      tl,
    );
    assert.equal(bar.background, color, `状态 ${status} 的底色应为 ${color}`);
  }
  assert.equal(GANTT_FALLBACK_COLOR, "#d9d9d9");
  assert.equal(GANTT_STATUS_COLORS.doing, "#1677ff");
});

test("ganttBarStyle【时区稳定性】：Asia/Shanghai 下定位不随当前时刻漂移", () => {
  // 8 个时区 × 6 个日期 × 4 个时刻的实测结论：只有**有夏令时**的时区
  // 且恰好跨切换点时才会偏一格；UTC+8 恒定。
  // 这条把"UTC+8 不漂"钉住。
  try {
    setTz("Asia/Shanghai");
    const results = new Set<string>();
    for (const tm of ["00:00", "02:00", "12:00", "20:00"]) {
      const now = new Date(`2026-03-10T${tm}:00Z`);
      const tl = ganttTimeline(now, "day");
      const bar = ganttBarStyle(
        task({ start_date: "2026-03-08", due_date: "2026-03-12" }),
        tl,
      );
      results.add(`${bar.left}/${bar.width}`);
    }
    assert.equal(
      results.size,
      1,
      `UTC+8 下定位应恒定，实测得到 ${[...results].join(", ")}`,
    );
  } finally {
    setTz("UTC");
  }
});
