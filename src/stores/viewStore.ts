import { create } from "zustand";
import type { ViewType } from "../types";

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

export const useViewStore = create<ViewState>((set) => ({
  currentView: "kanban",
  sidebarCollapsed: false,
  searchQuery: "",
  filterPriority: null,
  filterAgent: null,
  filterTags: [],

  setView: (view) => set({ currentView: view }),
  toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
  setSearchQuery: (q) => set({ searchQuery: q }),
  setFilterPriority: (p) => set({ filterPriority: p }),
  setFilterAgent: (a) => set({ filterAgent: a }),
  setFilterTags: (t) => set({ filterTags: t }),
  clearFilters: () => set({ searchQuery: "", filterPriority: null, filterAgent: null, filterTags: [] }),
}));
