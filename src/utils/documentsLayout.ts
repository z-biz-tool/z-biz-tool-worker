import type { ProjectDocument } from "../types";

/**
 * 文档视图的纯规则（W-17）：脏检查、列表增删改。
 *
 * 原实现把「编辑中是否有未保存内容」完全交给用户记忆：
 * 切文档 / 切项目直接丢弃 `editContent`，没有提示。这里先让规则可测。
 */

export function isDocumentDirty(
  selected: ProjectDocument | null,
  editContent: string,
): boolean {
  if (!selected) return false;
  return (selected.content ?? "") !== editContent;
}

/** 新建后放到列表最前；同 id 已存在时替换而不是插入重复项。 */
export function addDocument(
  docs: readonly ProjectDocument[],
  doc: ProjectDocument,
): ProjectDocument[] {
  const rest = docs.filter((d) => d.id !== doc.id);
  return [doc, ...rest];
}

export function replaceDocument(
  docs: readonly ProjectDocument[],
  updated: ProjectDocument,
): ProjectDocument[] {
  return docs.map((d) => (d.id === updated.id ? updated : d));
}

export function removeDocument(
  docs: readonly ProjectDocument[],
  docId: string,
): ProjectDocument[] {
  return docs.filter((d) => d.id !== docId);
}

/** 当前选中的文档被删后，应自动选中哪一篇：优先原位置的下一条，否则上一条。 */
export function nextSelectionAfterRemove(
  docs: readonly ProjectDocument[],
  removedId: string,
): ProjectDocument | null {
  const index = docs.findIndex((d) => d.id === removedId);
  if (index < 0) return null;
  const remaining = removeDocument(docs, removedId);
  if (remaining.length === 0) return null;
  return remaining[Math.min(index, remaining.length - 1)];
}
