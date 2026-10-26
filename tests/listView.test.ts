/**
 * W-17：列表视图纯规则回归。
 * 重点锁「批量全部失败必须报错」与「行内按钮点击不打开详情」。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { isRowActionTarget, shouldOpenTaskFromRowClick, summarizeBatchUpdate } from "../src/utils/listView.ts";

test("summarizeBatchUpdate：空选择返回 null，不弹无意义提示", () => {
  assert.equal(summarizeBatchUpdate([]), null);
});

test("summarizeBatchUpdate：全部成功 ⇒ success，提示成功数量", () => {
  const s = summarizeBatchUpdate([true, true]);
  assert.equal(s?.tone, "success");
  assert.equal(s?.updated, 2);
  assert.equal(s?.failed, 0);
  assert.match(s?.message ?? "", /2/);
});

test("summarizeBatchUpdate：全部失败 ⇒ error，而不是静默 return", () => {
  const s = summarizeBatchUpdate([false, false, false]);
  assert.equal(s?.tone, "error");
  assert.equal(s?.updated, 0);
  assert.equal(s?.failed, 3);
  assert.match(s?.message ?? "", /失败/);
});

test("summarizeBatchUpdate：部分失败 ⇒ warning，成功与失败数量都出现在消息里", () => {
  const s = summarizeBatchUpdate([true, false, true]);
  assert.equal(s?.tone, "warning");
  assert.equal(s?.updated, 2);
  assert.equal(s?.failed, 1);
  assert.match(s?.message ?? "", /2/);
  assert.match(s?.message ?? "", /1/);
});

function fakeTarget(hit: boolean, onQuery?: (selector: string) => void) {
  return {
    closest(selector: string) {
      onQuery?.(selector);
      return hit ? { tagName: "BUTTON" } : null;
    },
  };
}

test("isRowActionTarget：按钮/链接/输入框等命中 ⇒ true", () => {
  assert.equal(isRowActionTarget(fakeTarget(true)), true);
});

test("isRowActionTarget：普通单元格 ⇒ false", () => {
  assert.equal(isRowActionTarget(fakeTarget(false)), false);
});

test("isRowActionTarget：目标为空或没有 closest ⇒ 按普通行点击处理", () => {
  assert.equal(isRowActionTarget(null), false);
  assert.equal(isRowActionTarget(undefined), false);
  assert.equal(isRowActionTarget({}), false);
  assert.equal(shouldOpenTaskFromRowClick(null), true);
});

test("shouldOpenTaskFromRowClick 与 isRowActionTarget 互补", () => {
  assert.equal(shouldOpenTaskFromRowClick(fakeTarget(true)), false);
  assert.equal(shouldOpenTaskFromRowClick(fakeTarget(false)), true);
});

test("选择器覆盖按钮、链接、输入类与 data-row-action", () => {
  let seen = "";
  isRowActionTarget(fakeTarget(false, (s) => (seen = s)));
  for (const token of ["button", "a[href]", "input", "textarea", "select", "[data-row-action]", "[role='button']"]) {
    assert.ok(seen.includes(token), `选择器应包含 ${token}`);
  }
});
