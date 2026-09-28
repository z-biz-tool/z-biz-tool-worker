import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import { invoke } from "@tauri-apps/api/core";
import { message } from "antd";
import type { Project, Agent, Task, ProjectStats, AppConfig, LocalAgentInfo } from "../types";
import {
  agentsSignature,
  projectsSignature,
  statsSignature,
  tasksSignature,
} from "../utils/taskFilters";

interface WorkerState {
  projects: Project[];
  currentProjectId: string | null;
  agents: Agent[];
  tasks: Task[];
  stats: ProjectStats | null;
  config: AppConfig | null;
  /** 项目详情加载中（后台静默刷新不置位，避免 spinner 闪） */
  loading: boolean;
  /** 最近一次失败的用户可读原因，null 表示一切正常 */
  error: string | null;

  loadProjects: (opts?: { silent?: boolean }) => Promise<boolean>;
  selectProject: (id: string, opts?: { silent?: boolean }) => Promise<boolean>;
  /** 轮询专用：只打便宜的 stats，计数真变了才拉全量 */
  refreshQuiet: (id?: string) => Promise<boolean>;
  reloadAll: () => Promise<boolean>;
  clearProject: () => void;
  clearError: () => void;

  createProject: (name: string, desc: string) => Promise<boolean>;
  renameProject: (id: string, name: string) => Promise<boolean>;
  deleteProject: (id: string) => Promise<boolean>;

  createAgent: (projectId: string, name: string, prompt: string, model: string) => Promise<boolean>;
  deleteAgent: (id: string) => Promise<boolean>;
  cloneAgent: (projectId: string, sourceId: string, name: string) => Promise<boolean>;
  discoverLocalAgents: () => Promise<LocalAgentInfo[]>;
  importLocalAgent: (cli: LocalAgentInfo) => Promise<boolean>;

  createTask: (projectId: string, title: string, desc: string, parentId?: string) => Promise<boolean>;
  deleteTask: (id: string) => Promise<boolean>;
  assignTask: (taskId: string, agentId: string) => Promise<boolean>;
  retryTask: (taskId: string) => Promise<boolean>;
  reviewTask: (taskId: string, approved: boolean) => Promise<boolean>;
  updateTaskStatus: (taskId: string, status: string) => Promise<boolean>;
  updateTask: (taskId: string, params: Record<string, unknown>) => Promise<boolean>;

  loadConfig: () => Promise<boolean>;
  saveConfig: (config: AppConfig) => Promise<boolean>;
}

type PersistedWorker = Pick<WorkerState, "currentProjectId">;

function toText(e: unknown): string {
  if (typeof e === "string") return e;
  if (e instanceof Error) return e.message;
  if (e && typeof e === "object") {
    const obj = e as Record<string, unknown>;
    if (typeof obj.message === "string") return obj.message;
    try {
      return JSON.stringify(e);
    } catch {
      /* fallthrough */
    }
  }
  return String(e);
}

/** 批量操作会在几十毫秒内抛出同一句失败，刷屏比不说更糟 */
let lastToastAt = 0;
function toastOnce(text: string) {
  const now = Date.now();
  if (now - lastToastAt < 1500) return;
  lastToastAt = now;
  message.error(text);
}

async function withRetry<T>(fn: () => Promise<T>, attempts = 2, delayMs = 400): Promise<T> {
  let last: unknown;
  for (let i = 0; i < attempts; i += 1) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      if (i < attempts - 1) await new Promise((r) => setTimeout(r, delayMs * (i + 1)));
    }
  }
  throw last;
}

export const useWorkerStore = create<WorkerState>()(
  persist<WorkerState, [], [], PersistedWorker>(
    (set, get) => {
      const fail = (action: string, e: unknown, silent: boolean): false => {
        const text = `${action}失败：${toText(e)}`;
        set({ error: text });
        if (!silent) toastOnce(text);
        return false;
      };

      const succeed = () => {
        if (get().error) set({ error: null });
      };

      /** 拉全量后按指纹逐块写回：数据没变的切片保持原引用，轮询就不会引起重渲染 */
      const applyProjectData = (
        id: string,
        agents: Agent[],
        tasks: Task[],
        stats: ProjectStats | null,
      ) => {
        const prev = get();
        const patch: Partial<WorkerState> = {};
        if (prev.currentProjectId !== id) patch.currentProjectId = id;
        if (agentsSignature(agents) !== agentsSignature(prev.agents)) patch.agents = agents;
        if (tasksSignature(tasks) !== tasksSignature(prev.tasks)) patch.tasks = tasks;
        if (statsSignature(stats) !== statsSignature(prev.stats)) patch.stats = stats;
        if (Object.keys(patch).length > 0) set(patch);
      };

      return {
        projects: [],
        currentProjectId: null,
        agents: [],
        tasks: [],
        stats: null,
        config: null,
        loading: false,
        error: null,

        loadProjects: async (opts) => {
          const silent = opts?.silent ?? false;
          try {
            const projects = await withRetry(() => invoke<Project[]>("list_projects"));
            if (projectsSignature(projects) !== projectsSignature(get().projects)) {
              set({ projects });
            }
            succeed();
            return true;
          } catch (e) {
            return fail("加载项目列表", e, silent);
          }
        },

        selectProject: async (id, opts) => {
          const silent = opts?.silent ?? false;
          if (!silent) set({ loading: true });
          try {
            const [agents, tasks, stats] = await Promise.all([
              withRetry(() => invoke<Agent[]>("list_agents", { projectId: id })),
              withRetry(() => invoke<Task[]>("list_tasks", { projectId: id })),
              invoke<ProjectStats>("get_project_stats", { id }).catch(() => null),
            ]);
            applyProjectData(id, agents, tasks, stats);
            succeed();
            return true;
          } catch (e) {
            return fail("加载项目数据", e, silent);
          } finally {
            if (!silent) set({ loading: false });
          }
        },

        refreshQuiet: async (id) => {
          const pid = id ?? get().currentProjectId;
          if (!pid) return false;
          try {
            const stats = await invoke<ProjectStats>("get_project_stats", { id: pid });
            if (statsSignature(stats) === statsSignature(get().stats)) return true;
            // 计数变了才说明后台 Agent 真的动了任务，这时候才付一次全量 IPC
            return await get().selectProject(pid, { silent: true });
          } catch (e) {
            return fail("后台刷新", e, true);
          }
        },

        reloadAll: async () => {
          const okProjects = await get().loadProjects({ silent: true });
          const pid = get().currentProjectId;
          if (!pid) return okProjects;
          const okData = await get().selectProject(pid, { silent: true });
          return okProjects && okData;
        },

        clearProject: () => set({ currentProjectId: null, agents: [], tasks: [], stats: null }),
        clearError: () => set({ error: null }),

        createProject: async (name, desc) => {
          const trimmed = name.trim();
          if (!trimmed) {
            message.warning("请输入项目名称");
            return false;
          }
          if (get().projects.some((p) => p.name.trim().toLowerCase() === trimmed.toLowerCase())) {
            message.warning("已存在同名项目");
            return false;
          }
          try {
            await invoke("create_project", { name: trimmed, desc });
            await get().loadProjects();
            succeed();
            return true;
          } catch (e) {
            return fail("创建项目", e, false);
          }
        },

        renameProject: async (id, name) => {
          const trimmed = name.trim();
          if (!trimmed) {
            message.warning("项目名称不能为空");
            return false;
          }
          const prev = get().projects;
          if (prev.some((p) => p.id !== id && p.name.trim().toLowerCase() === trimmed.toLowerCase())) {
            message.warning("已存在同名项目");
            return false;
          }
          set({ projects: prev.map((p) => (p.id === id ? { ...p, name: trimmed } : p)) });
          try {
            const updated = await invoke<Project>("rename_project", { id, name: trimmed });
            set({ projects: get().projects.map((p) => (p.id === updated.id ? updated : p)) });
            succeed();
            return true;
          } catch (e) {
            set({ projects: prev });
            return fail("重命名项目", e, false);
          }
        },

        deleteProject: async (id) => {
          try {
            await invoke("delete_project", { id });
            if (get().currentProjectId === id) get().clearProject();
            await get().loadProjects();
            succeed();
            return true;
          } catch (e) {
            return fail("删除项目", e, false);
          }
        },

        createAgent: async (projectId, name, prompt, model) => {
          try {
            await invoke("create_agent", { projectId, name, prompt, model });
            await get().selectProject(projectId, { silent: true });
            succeed();
            return true;
          } catch (e) {
            return fail("创建 Agent", e, false);
          }
        },

        deleteAgent: async (id) => {
          try {
            await invoke("delete_agent", { id });
            const pid = get().currentProjectId;
            if (pid) await get().selectProject(pid, { silent: true });
            succeed();
            return true;
          } catch (e) {
            return fail("删除 Agent", e, false);
          }
        },

        cloneAgent: async (projectId, sourceId, name) => {
          try {
            await invoke("clone_agent", { projectId, sourceId, name });
            await get().selectProject(projectId, { silent: true });
            succeed();
            return true;
          } catch (e) {
            return fail("克隆 Agent", e, false);
          }
        },

        discoverLocalAgents: async () => {
          try {
            return await invoke<LocalAgentInfo[]>("discover_local_agents");
          } catch (e) {
            throw new Error(`探测本地 CLI 失败：${toText(e)}`);
          }
        },

        importLocalAgent: async (cli) => {
          const pid = get().currentProjectId;
          if (!pid) {
            message.warning("未选中项目");
            return false;
          }
          await invoke("import_local_agent", {
            projectId: pid,
            cliType: cli.type,
            command: cli.command,
            cliPath: cli.path,
            cliVersion: cli.version,
            localAgentId: cli.agent_id,
          });
          await get().selectProject(pid, { silent: true });
          succeed();
          return true;
        },

        createTask: async (projectId, title, desc, parentId) => {
          try {
            await invoke("create_task", {
              projectId,
              title,
              desc,
              parentId: parentId || null,
            });
            await get().selectProject(projectId, { silent: true });
            succeed();
            return true;
          } catch (e) {
            return fail("创建任务", e, false);
          }
        },

        deleteTask: async (id) => {
          try {
            await invoke("delete_task", { id });
            const pid = get().currentProjectId;
            if (pid) await get().selectProject(pid, { silent: true });
            succeed();
            return true;
          } catch (e) {
            return fail("删除任务", e, false);
          }
        },

        assignTask: async (taskId, agentId) => {
          try {
            await invoke("assign_task", { taskId, agentId });
            const pid = get().currentProjectId;
            if (pid) await get().selectProject(pid, { silent: true });
            succeed();
            return true;
          } catch (e) {
            return fail("指派任务", e, false);
          }
        },

        retryTask: async (taskId) => {
          try {
            await invoke("retry_task", { taskId });
            const pid = get().currentProjectId;
            if (pid) await get().selectProject(pid, { silent: true });
            succeed();
            return true;
          } catch (e) {
            return fail("重试任务", e, false);
          }
        },

        reviewTask: async (taskId, approved) => {
          try {
            await invoke("review_task", { taskId, approved });
            const pid = get().currentProjectId;
            if (pid) await get().selectProject(pid, { silent: true });
            succeed();
            return true;
          } catch (e) {
            return fail("验收任务", e, false);
          }
        },

        updateTaskStatus: async (taskId, status) => {
          try {
            await invoke("update_task_status", { taskId, status });
            const pid = get().currentProjectId;
            if (pid) await get().selectProject(pid, { silent: true });
            succeed();
            return true;
          } catch (e) {
            return fail("更新任务状态", e, false);
          }
        },

        updateTask: async (taskId, params) => {
          try {
            await invoke("update_task", { taskId, params });
            const pid = get().currentProjectId;
            if (pid) await get().selectProject(pid, { silent: true });
            succeed();
            return true;
          } catch (e) {
            return fail("更新任务", e, false);
          }
        },

        loadConfig: async () => {
          try {
            const config = await withRetry(() => invoke<AppConfig>("get_config"));
            set({ config });
            succeed();
            return true;
          } catch (e) {
            return fail("读取设置", e, false);
          }
        },

        saveConfig: async (config) => {
          try {
            await invoke("save_config", { config });
            set({ config });
            succeed();
            return true;
          } catch (e) {
            return fail("保存设置", e, false);
          }
        },
      };
    },
    {
      name: "z-biz-tool-worker-worker",
      version: 1,
      storage: createJSONStorage(() => localStorage),
      // 只落盘"上次开着哪个项目"：config.api_key 是密钥不能进 localStorage，
      // projects/agents/tasks 的真身在 SQLite，落一份缓存反而会把旧数据当新数据渲染。
      partialize: (s) => ({ currentProjectId: s.currentProjectId }),
      migrate: (persisted) => {
        const id = (persisted as Partial<PersistedWorker> | null)?.currentProjectId;
        return { currentProjectId: typeof id === "string" ? id : null };
      },
    },
  ),
);
