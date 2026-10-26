/**
 * 列表视图的纯规则（W-17）：批量改状态的结果汇总、行内点击与操作按钮的区分。
 *
 * 抽出来的原因：原实现遇到「全部失败」时 `if (done === 0) return;` ——
 * 选择被清空、一条成功提示都没有，用户完全不知道刚才的操作失败了。
 */

export type BatchTone = "success" | "warning" | "error";

export interface BatchUpdateSummary {
  total: number;
  updated: number;
  failed: number;
  tone: BatchTone;
  message: string;
}

/** 空选择返回 null（不发提示）；全部失败必须给出 error，而不是静默。 */
export function summarizeBatchUpdate(results: readonly boolean[]): BatchUpdateSummary | null {
  const total = results.length;
  if (total === 0) return null;
  const updated = results.filter(Boolean).length;
  const failed = total - updated;
  if (failed === 0) {
    return { total, updated, failed, tone: "success", message: `已批量更新 ${updated} 个任务` };
  }
  if (updated === 0) {
    return { total, updated, failed, tone: "error", message: `批量更新失败：${failed} 个任务均未更新` };
  }
  return {
    total,
    updated,
    failed,
    tone: "warning",
    message: `已更新 ${updated} 个任务，${failed} 个失败`,
  };
}

type ClosestCapable = { closest?: (selector: string) => unknown } | null | undefined;

const INTERACTIVE_SELECTOR =
  "button,a[href],input,textarea,select,label,[role='button'],[role='link'],[data-row-action]";

/**
 * 点击是否落在行内可交互元素上。
 *
 * `Table.onRow.onClick` 会冒泡收到按钮点击：原实现无差别打开详情，
 * 于是「点删除 → 详情面板也弹出来」；这里先问目标元素是不是操作控件。
 * 目标对象没有 closest（非 DOM 环境）时按普通行点击处理。
 */
export function isRowActionTarget(target: ClosestCapable): boolean {
  if (!target || typeof target.closest !== "function") return false;
  return Boolean(target.closest(INTERACTIVE_SELECTOR));
}

export function shouldOpenTaskFromRowClick(target: ClosestCapable): boolean {
  return !isRowActionTarget(target);
}
