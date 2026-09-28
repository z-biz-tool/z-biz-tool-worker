import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import type { ViewType } from "../types";

/** ⌘1..9 的切换顺序，与 TopBar 的视图按钮顺序一致（末位是设置）。 */
export const VIEW_ORDER: ViewType[] = [
  "dashboard",
  "kanban",
  "list",
  "calendar",
  "gantt",
  "documents",
  "agents",
  "settings",
];

interface ViewState {
  currentView: ViewType;
  sidebarCollapsed: boolean;
  searchQuery: string;
  filterPriority: number | null;
  filterAgent: string | null;
  filterTags: string[];
  setView: (view: ViewType) => void;
  toggleSidebar: () => void;
  setSearchQuery: (q: string) => void;
  setFilterPriority: (p: number | null) => void;
  setFilterAgent: (a: string | null) => void;
  setFilterTags: (t: string[]) => void;
  clearFilters: () => void;
}

type PersistedView = Pick<
  ViewState,
  "currentView" | "sidebarCollapsed" | "searchQuery" | "filterPriority" | "filterAgent" | "filterTags"
>;

const DEFAULTS: PersistedView = {
  currentView: "kanban",
  sidebarCollapsed: false,
  searchQuery: "",
  filterPriority: null,
  filterAgent: null,
  filterTags: [],
};

// 手改过 / 旧版本的 localStorage 不能让视图直接崩掉：每个字段都单独校验后回落到默认值
function sanitize(raw: unknown): PersistedView {
  const o = (raw ?? {}) as Record<string, unknown>;
  return {
    currentView: VIEW_ORDER.includes(o.currentView as ViewType)
      ? (o.currentView as ViewType)
      : DEFAULTS.currentView,
    sidebarCollapsed: typeof o.sidebarCollapsed === "boolean" ? o.sidebarCollapsed : false,
    searchQuery: typeof o.searchQuery === "string" ? o.searchQuery : "",
    filterPriority:
      typeof o.filterPriority === "number" && Number.isFinite(o.filterPriority)
        ? o.filterPriority
        : null,
    filterAgent: typeof o.filterAgent === "string" ? o.filterAgent : null,
    filterTags: Array.isArray(o.filterTags)
      ? o.filterTags.filter((t): t is string => typeof t === "string")
      : [],
  };
}

export const useViewStore = create<ViewState>()(
  persist<ViewState, [], [], PersistedView>(
    (set) => ({
      ...DEFAULTS,

      setView: (view) => set({ currentView: view }),
      toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
      setSearchQuery: (q) => set({ searchQuery: q }),
      setFilterPriority: (p) => set({ filterPriority: p }),
      setFilterAgent: (a) => set({ filterAgent: a }),
      setFilterTags: (t) => set({ filterTags: t }),
      clearFilters: () =>
        set({ searchQuery: "", filterPriority: null, filterAgent: null, filterTags: [] }),
    }),
    {
      name: "z-biz-tool-worker-view",
      version: 1,
      storage: createJSONStorage(() => localStorage),
      partialize: (s) => ({
        currentView: s.currentView,
        sidebarCollapsed: s.sidebarCollapsed,
        searchQuery: s.searchQuery,
        filterPriority: s.filterPriority,
        filterAgent: s.filterAgent,
        filterTags: s.filterTags,
      }),
      migrate: (persisted) => sanitize(persisted),
    },
  ),
);
