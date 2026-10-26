/**
 * W-17：文档视图纯规则回归。
 * 重点锁「未保存内容可被识别」与「删除后的选中项不越界」。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  addDocument,
  isDocumentDirty,
  nextSelectionAfterRemove,
  removeDocument,
  replaceDocument,
} from "../src/utils/documentsLayout.ts";
import type { ProjectDocument } from "../src/types/index.ts";

function doc(over: Partial<ProjectDocument> = {}): ProjectDocument {
  return {
    id: "d1",
    project_id: "p1",
    title: "文档",
    content: "原文",
    parent_id: null,
    sort_order: 0,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    ...over,
  };
}

test("isDocumentDirty：未选中文档 ⇒ false", () => {
  assert.equal(isDocumentDirty(null, "任何内容"), false);
});

test("isDocumentDirty：内容一致 ⇒ false；改一个字 ⇒ true", () => {
  assert.equal(isDocumentDirty(doc(), "原文"), false);
  assert.equal(isDocumentDirty(doc(), "原文!"), true);
  assert.equal(isDocumentDirty(doc(), ""), true);
});

test("isDocumentDirty：content 为 null 时按空串比较，不抛错", () => {
  assert.equal(isDocumentDirty(doc({ content: null as unknown as string }), ""), false);
  assert.equal(isDocumentDirty(doc({ content: null as unknown as string }), "x"), true);
});

test("addDocument：新文档置顶，且不修改入参数组", () => {
  const docs = [doc({ id: "a" }), doc({ id: "b" })];
  const next = addDocument(docs, doc({ id: "new" }));
  assert.deepEqual(next.map((d) => d.id), ["new", "a", "b"]);
  assert.deepEqual(docs.map((d) => d.id), ["a", "b"]);
});

test("addDocument：同 id 只替换，不产生重复项", () => {
  const docs = [doc({ id: "a", title: "旧" }), doc({ id: "b" })];
  const next = addDocument(docs, doc({ id: "a", title: "新" }));
  assert.deepEqual(next.map((d) => d.id), ["a", "b"]);
  assert.equal(next[0].title, "新");
});

test("replaceDocument：按 id 替换并保持原位置；找不到时原样返回内容", () => {
  const docs = [doc({ id: "a" }), doc({ id: "b" })];
  const next = replaceDocument(docs, doc({ id: "b", title: "改" }));
  assert.deepEqual(next.map((d) => d.id), ["a", "b"]);
  assert.equal(next[1].title, "改");
  assert.equal(docs[1].title, "文档", "入参不能被就地改");
  assert.deepEqual(replaceDocument(docs, doc({ id: "missing" })).map((d) => d.id), ["a", "b"]);
});

test("removeDocument：只删指定 id，返回新数组", () => {
  const docs = [doc({ id: "a" }), doc({ id: "b" })];
  assert.deepEqual(removeDocument(docs, "a").map((d) => d.id), ["b"]);
  assert.deepEqual(removeDocument(docs, "nope").map((d) => d.id), ["a", "b"]);
  assert.equal(docs.length, 2);
});

test("nextSelectionAfterRemove：删中间项选原位置的下一条", () => {
  const docs = [doc({ id: "a" }), doc({ id: "b" }), doc({ id: "c" })];
  assert.equal(nextSelectionAfterRemove(docs, "b")?.id, "c");
});

test("nextSelectionAfterRemove：删末项回退到上一条；删光返回 null", () => {
  const docs = [doc({ id: "a" }), doc({ id: "b" })];
  assert.equal(nextSelectionAfterRemove(docs, "b")?.id, "a");
  assert.equal(nextSelectionAfterRemove([doc({ id: "a" })], "a"), null);
  assert.equal(nextSelectionAfterRemove(docs, "missing"), null);
});
