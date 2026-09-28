import { useCallback, useEffect, useRef, useState } from "react";

const PREFIX = "z-biz-tool-worker-draft:";

/**
 * 草稿落盘：表单在切视图/重启后不该清空，但也不该把半成品写进后端。
 * 只走 localStorage，任何解析/写入异常都退化成无草稿，绝不因为脏数据白屏。
 */
export function useDraft<T extends object>(
  key: string,
  initial: T,
): [T, (next: T) => void, () => void] {
  const storageKey = PREFIX + key;
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(storageKey);
      if (!raw) return initial;
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return initial;
      return { ...initial, ...(parsed as Partial<T>) };
    } catch {
      return initial;
    }
  });

  const first = useRef(true);
  useEffect(() => {
    try {
      const empty = Object.values(value).every((v) => v === "" || v == null);
      if (empty) localStorage.removeItem(storageKey);
      else localStorage.setItem(storageKey, JSON.stringify(value));
    } catch {
      /* 存储满 / 隐私模式：草稿丢了也不能影响功能 */
    }
    first.current = false;
  }, [storageKey, value]);

  const reset = useCallback(() => {
    try {
      localStorage.removeItem(storageKey);
    } catch {
      /* ignore */
    }
    setValue(initial);
  }, [storageKey, initial]);

  return [value, setValue, reset];
}
