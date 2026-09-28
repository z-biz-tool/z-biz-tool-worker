import { useEffect, useMemo, useRef, useState } from "react";
import {
  Layout, Button, Modal, Input, Tag, Empty, Space, Typography, Dropdown,
  message, Avatar, Collapse, Card, Spin, Alert, Tooltip, Checkbox,
} from "antd";
import type { InputRef } from "antd";
import {
  PlusOutlined, DeleteOutlined, CopyOutlined, EditOutlined,
  SettingOutlined, ApiOutlined, ThunderboltOutlined, MenuFoldOutlined, MenuUnfoldOutlined,
} from "@ant-design/icons";
import { useWorkerStore } from "./stores/workerStore";
import { useViewStore, VIEW_ORDER } from "./stores/viewStore";
import { filterTasks } from "./utils/taskFilters";
import { useDraft } from "./hooks/useDraft";
import type { Task, LocalAgentInfo, Project } from "./types";
import TopBar from "./components/TopBar";
import KanbanView from "./components/views/KanbanView";
import ListView from "./components/views/ListView";
import DashboardView from "./components/views/DashboardView";
import CalendarView from "./components/views/CalendarView";
import GanttView from "./components/views/GanttView";
import DocumentsView from "./components/views/DocumentsView";
import TaskDetailPanel from "./components/TaskDetailPanel";
import Settings from "./components/Settings";

const { Sider, Content } = Layout;
const { Text } = Typography;
const { TextArea } = Input;

const CLI_LABELS: Record<string, { label: string; color: string }> = {
  "claude-code": { label: "Claude Code", color: "#d97706" },
  hermes: { label: "Hermes", color: "#7c3aed" },
  opencode: { label: "OpenCode", color: "#0ea5e9" },
};

const AGENT_COLORS = ["#1677ff", "#52c41a", "#faad14", "#eb2f96", "#722ed1", "#13c2c2"];

const POLL_BASE_MS = 5000;
const POLL_MAX_MS = 30000;
const POLL_HIDDEN_MS = 30000;

export default function App() {
  const store = useWorkerStore();
  const {
    currentView, setView, sidebarCollapsed, toggleSidebar,
    searchQuery, filterPriority, filterAgent, filterTags,
  } = useViewStore();
  const [newProjectOpen, setNewProjectOpen] = useState(false);
  const [importLocalOpen, setImportLocalOpen] = useState(false);
  const [renameTarget, setRenameTarget] = useState<Project | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [projectForm, setProjectForm, resetProjectForm] = useDraft("project-new", { name: "", desc: "" });
  const [manualAgentForm, setManualAgentForm, resetManualAgentForm] = useDraft("agent-manual", {
    name: "", prompt: "", model: "",
  });
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [newTaskSignal, setNewTaskSignal] = useState(0);
  const searchInputRef = useRef<InputRef>(null);

  const currentProject = store.projects.find((p) => p.id === store.currentProjectId);
  const agents = store.agents;
  const tasks = store.tasks;

  // 详情面板跟着 store 走，后台刷新后展示的才是最新内容，而不是点进去那一刻的快照
  const selectedTask = useMemo(
    () => (selectedTaskId ? tasks.find((t) => t.id === selectedTaskId) ?? null : null),
    [selectedTaskId, tasks],
  );

  // 搜索 + 优先级 + Agent + 标签：过滤逻辑集中在 utils/taskFilters
  const activeFilters = { query: searchQuery, priority: filterPriority, agentId: filterAgent, tags: filterTags };
  const filteredTasks = useMemo(
    () => filterTasks(tasks, activeFilters),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tasks, searchQuery, filterPriority, filterAgent, filterTags],
  );

  // 启动：恢复上次打开的项目，失效则回落到第一个
  useEffect(() => {
    let cancelled = false;
    (async () => {
      await store.loadProjects();
      if (cancelled) return;
      const { projects, currentProjectId, selectProject, clearProject } = useWorkerStore.getState();
      const stillValid = currentProjectId && projects.some((p) => p.id === currentProjectId);
      if (stillValid) {
        await selectProject(currentProjectId!);
      } else if (projects.length > 0) {
        await selectProject(projects[0].id);
      } else if (currentProjectId) {
        clearProject();
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const hasInFlight = useMemo(
    () => tasks.some((t) => t.status === "doing" || t.status === "waiting"),
    [tasks],
  );

  // 后台执行中：只轮便宜的 stats，窗口不可见时降频，失败指数退避，卸载即停
  useEffect(() => {
    const projectId = currentProject?.id;
    if (!projectId || !hasInFlight) return;
    let stopped = false;
    let timer: number | undefined;
    let delay = POLL_BASE_MS;

    const schedule = () => {
      timer = window.setTimeout(async () => {
        if (stopped) return;
        if (document.hidden) {
          delay = POLL_HIDDEN_MS;
        } else {
          const ok = await useWorkerStore.getState().refreshQuiet(projectId);
          delay = ok ? POLL_BASE_MS : Math.min(delay * 2, POLL_MAX_MS);
        }
        schedule();
      }, delay);
    };
    schedule();

    return () => {
      stopped = true;
      if (timer) window.clearTimeout(timer);
    };
  }, [currentProject?.id, hasInFlight]);

  // 真正的失效信号：窗口重新获得焦点/回到前台才补一次全量
  useEffect(() => {
    const reactivate = () => {
      if (document.hidden) return;
      const { currentProjectId, selectProject } = useWorkerStore.getState();
      if (currentProjectId) void selectProject(currentProjectId, { silent: true });
    };
    window.addEventListener("focus", reactivate);
    document.addEventListener("visibilitychange", reactivate);
    return () => {
      window.removeEventListener("focus", reactivate);
      document.removeEventListener("visibilitychange", reactivate);
    };
  }, []);

  // ─────────── 快捷键 ───────────
  // 用 ref 持有最新闭包，全局监听只装一次，免得每次渲染摘装 keydown。
  const hotkeyRef = useRef<{
    newItem: () => void;
    focusSearch: () => void;
    switchIndex: (i: number) => void;
    closeTop: () => void;
    modalOpen: () => boolean;
  }>({
    newItem: () => {},
    focusSearch: () => {},
    switchIndex: () => {},
    closeTop: () => {},
    modalOpen: () => false,
  });

  useEffect(() => {
    hotkeyRef.current = {
      newItem: () => {
        if (!currentProject) {
          setNewProjectOpen(true);
          return;
        }
        setView("kanban");
        setNewTaskSignal((n) => n + 1);
      },
      focusSearch: () => searchInputRef.current?.focus(),
      switchIndex: (i) => {
        const view = VIEW_ORDER[i];
        if (view) setView(view);
      },
      closeTop: () => {
        if (selectedTaskId) {
          setSelectedTaskId(null);
          return;
        }
        if (currentView === "settings") setView("kanban");
      },
      modalOpen: () => newProjectOpen || importLocalOpen || !!renameTarget,
    };
  });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      const typing =
        !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable);

      if (e.key === "Escape") {
        if (typing) return; // 输入框里的 Esc 交给组件自己（下拉/Modal）
        // antd Modal 自带 Esc 关闭，这里只处理它管不到的浮层
        if (hotkeyRef.current.modalOpen()) return;
        e.preventDefault();
        hotkeyRef.current.closeTop();
        return;
      }
      if (!(e.metaKey || e.ctrlKey)) return;
      const k = e.key.toLowerCase();
      if (k === "n") {
        e.preventDefault();
        hotkeyRef.current.newItem();
        return;
      }
      if (typing) return;
      if (k === "f") {
        e.preventDefault();
        hotkeyRef.current.focusSearch();
      } else if (/^[1-9]$/.test(k)) {
        e.preventDefault();
        hotkeyRef.current.switchIndex(Number(k) - 1);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const openRename = (p: Project) => {
    setRenameTarget(p);
    setRenameValue(p.name);
  };

  const submitNewProject = async () => {
    if (await store.createProject(projectForm.name, projectForm.desc)) {
      setNewProjectOpen(false);
      resetProjectForm();
    }
  };

  const submitRename = async () => {
    const target = renameTarget;
    if (!target) return;
    const name = renameValue.trim();
    if (!name) return message.warning("项目名称不能为空");
    if (store.projects.some((p) => p.id !== target.id && p.name.trim().toLowerCase() === name.toLowerCase())) {
      return message.warning("已存在同名项目");
    }
    if (name === target.name) {
      setRenameTarget(null);
      return;
    }
    if (await store.renameProject(target.id, name)) setRenameTarget(null);
  };

  const sider = (
    <Sider
      width={sidebarCollapsed ? 48 : 220}
      collapsed={sidebarCollapsed}
      collapsedWidth={48}
      style={{ background: "#fff", borderRight: "1px solid #f0f0f0", transition: "width 0.2s" }}
    >
      <div style={{ padding: sidebarCollapsed ? "8px 4px" : "12px 12px" }}>
        <div style={{ display: "flex", justifyContent: sidebarCollapsed ? "center" : "space-between", alignItems: "center", marginBottom: 8 }}>
          {!sidebarCollapsed && <Text strong style={{ fontSize: 13 }}>项目</Text>}
          <Tooltip title={sidebarCollapsed ? "展开侧栏" : "收起侧栏"}>
            <Button
              type="text"
              size="small"
              icon={sidebarCollapsed ? <MenuUnfoldOutlined /> : <MenuFoldOutlined />}
              onClick={toggleSidebar}
            />
          </Tooltip>
        </div>
        {!sidebarCollapsed && (
          <>
            <Button
              type="primary"
              size="small"
              icon={<PlusOutlined />}
              onClick={() => setNewProjectOpen(true)}
              block
              style={{ marginBottom: 12 }}
            >
              新建项目
            </Button>
            {store.projects.map((p) => (
              <Card
                key={p.id}
                size="small"
                hoverable
                style={{ marginBottom: 6, borderLeft: p.id === store.currentProjectId ? "3px solid #1677ff" : undefined, cursor: "pointer" }}
                onClick={() => store.selectProject(p.id)}
              >
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <Text strong ellipsis style={{ flex: 1, fontSize: 12 }}>{p.name}</Text>
                  <Dropdown
                    menu={{
                      items: [
                        { key: "rename", label: "重命名", icon: <EditOutlined /> },
                        { key: "del", label: "删除", icon: <DeleteOutlined />, danger: true },
                      ],
                      onClick: ({ key }) => {
                        if (key === "rename") openRename(p);
                        if (key === "del") {
                          Modal.confirm({
                            title: `删除项目 "${p.name}"?`,
                            content: "该项目的任务与 Agent 会一并删除。",
                            okButtonProps: { danger: true },
                            onOk: () => store.deleteProject(p.id),
                          });
                        }
                      },
                    }}
                    trigger={["click"]}
                  >
                    <Button
                      type="text"
                      size="small"
                      icon={<SettingOutlined />}
                      onClick={(e) => e.stopPropagation()}
                    />
                  </Dropdown>
                </div>
                <Text type="secondary" ellipsis style={{ fontSize: 11 }}>{p.description}</Text>
              </Card>
            ))}
            {store.projects.length === 0 && (
              <Empty description={store.loading ? "加载中" : "暂无项目"} image={Empty.PRESENTED_IMAGE_SIMPLE} />
            )}
          </>
        )}
      </div>
    </Sider>
  );

  const renderContent = () => {
    if (currentView === "settings") {
      return <Settings onBack={() => setView("kanban")} />;
    }

    if (!currentProject) {
      return (
        <Content style={{ display: "flex", alignItems: "center", justifyContent: "center" }}>
          <Empty description="请选择或创建一个项目" image={Empty.PRESENTED_IMAGE_SIMPLE}>
            <Button type="primary" icon={<PlusOutlined />} onClick={() => setNewProjectOpen(true)}>创建项目</Button>
          </Empty>
        </Content>
      );
    }

    if (store.loading && tasks.length === 0) {
      return (
        <Content style={{ display: "flex", alignItems: "center", justifyContent: "center" }}>
          <Spin tip="加载项目中" />
        </Content>
      );
    }

    const handleTaskClick = (task: Task) => setSelectedTaskId(task.id);

    switch (currentView) {
      case "dashboard":
        return <Content style={{ padding: 16, overflow: "auto" }}><DashboardView tasks={filteredTasks} agents={agents} stats={store.stats} /></Content>;
      case "kanban":
        return <Content style={{ padding: 16, overflow: "auto" }}><KanbanView tasks={filteredTasks} agents={agents} onTaskClick={handleTaskClick} openNewTaskSignal={newTaskSignal} /></Content>;
      case "list":
        return <Content style={{ padding: 16, overflow: "auto" }}><ListView tasks={filteredTasks} agents={agents} onTaskClick={handleTaskClick} /></Content>;
      case "calendar":
        return <Content style={{ padding: 16, overflow: "auto" }}><CalendarView tasks={filteredTasks} /></Content>;
      case "gantt":
        return <Content style={{ padding: 16, overflow: "auto" }}><GanttView tasks={filteredTasks} /></Content>;
      case "documents":
        return <Content style={{ padding: 16, overflow: "auto" }}><DocumentsView projectId={currentProject.id} /></Content>;
      case "agents":
        return <Content style={{ padding: 16, overflow: "auto" }}>{renderAgentTab()}</Content>;
      default:
        return <Content style={{ padding: 16, overflow: "auto" }}><KanbanView tasks={filteredTasks} agents={agents} onTaskClick={handleTaskClick} openNewTaskSignal={newTaskSignal} /></Content>;
    }
  };

  // Agent 管理面板
  const renderAgentTab = () => (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
        <Text type="secondary">
          本项目当前挂载 <Text strong>{agents.length}</Text> 个 Agent。
        </Text>
        <Space>
          <Button icon={<ApiOutlined />} onClick={() => setImportLocalOpen(true)}>引入本地 Agent</Button>
        </Space>
      </div>
      {agents.length === 0 ? (
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description={
            <Space direction="vertical" size={8}>
              <Text type="secondary">本项目还没有 Agent</Text>
              <Button type="primary" icon={<ApiOutlined />} onClick={() => setImportLocalOpen(true)}>引入本地 Agent</Button>
            </Space>
          }
          style={{ padding: "60px 0" }}
        />
      ) : (
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
          {agents.map((a, i) => {
            const cliMeta = a.cli_type ? CLI_LABELS[a.cli_type] : null;
            const isLocal = a.source === "local";
            return (
              <Card key={a.id} size="small" style={{ width: 260, borderTop: cliMeta ? `3px solid ${cliMeta.color}` : undefined }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <Avatar style={{ backgroundColor: AGENT_COLORS[i % AGENT_COLORS.length], flexShrink: 0 }}>{a.name[0]}</Avatar>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <Text strong ellipsis style={{ display: "block", fontSize: 13 }}>{a.name}</Text>
                    <Space size={4}>
                      <Tag color={a.status === "working" ? "processing" : a.status === "idle" ? "default" : "error"} style={{ fontSize: 11, margin: 0 }}>
                        {a.status === "working" ? "工作中" : a.status === "idle" ? "空闲" : "离线"}
                      </Tag>
                      {isLocal && cliMeta && <Tag color={cliMeta.color} style={{ fontSize: 11, margin: 0 }}>{cliMeta.label}</Tag>}
                    </Space>
                  </div>
                  <Dropdown
                    menu={{
                      items: [
                        { key: "clone", label: "克隆", icon: <CopyOutlined /> },
                        { key: "del", label: "删除", icon: <DeleteOutlined />, danger: true },
                      ],
                      onClick: async ({ key }) => {
                        if (key === "del") {
                          Modal.confirm({
                            title: `删除 Agent "${a.name}"?`,
                            okButtonProps: { danger: true },
                            onOk: () => store.deleteAgent(a.id),
                          });
                        }
                        if (key === "clone") {
                          const ok = await store.cloneAgent(currentProject!.id, a.id, "");
                          if (ok) message.success(`已克隆 ${a.name}`);
                        }
                      },
                    }}
                    trigger={["click"]}
                  >
                    <Button type="text" size="small" icon={<SettingOutlined />} />
                  </Dropdown>
                </div>
                <div style={{ marginTop: 8, fontSize: 11, color: "#999" }}>
                  模型: {a.model || "default"}
                </div>
              </Card>
            );
          })}
        </div>
      )}

      <Collapse
        ghost
        style={{ marginTop: 24 }}
        items={[{
          key: "advanced",
          label: <Space><ThunderboltOutlined /><Text type="secondary">高级模式:手填 Agent</Text></Space>,
          children: (
            <div style={{ padding: "0 12px 12px", maxWidth: 600 }}>
              <Space direction="vertical" size={8} style={{ width: "100%" }}>
                <Input placeholder="Agent 名称" value={manualAgentForm.name} onChange={(e) => setManualAgentForm({ ...manualAgentForm, name: e.target.value })} />
                <TextArea placeholder="系统提示词" rows={3} value={manualAgentForm.prompt} onChange={(e) => setManualAgentForm({ ...manualAgentForm, prompt: e.target.value })} />
                <Input placeholder="模型(如 gpt-4, claude-3)" value={manualAgentForm.model} onChange={(e) => setManualAgentForm({ ...manualAgentForm, model: e.target.value })} />
                <Button
                  type="dashed"
                  icon={<PlusOutlined />}
                  onClick={async () => {
                    if (!manualAgentForm.name.trim()) return message.warning("请输入 Agent 名称");
                    const ok = await store.createAgent(
                      currentProject!.id,
                      manualAgentForm.name.trim(),
                      manualAgentForm.prompt,
                      manualAgentForm.model,
                    );
                    if (ok) {
                      resetManualAgentForm();
                      message.success("已创建 Agent");
                    }
                  }}
                >
                  创建手填 Agent
                </Button>
              </Space>
            </div>
          ),
        }]}
      />
    </div>
  );

  const retryLast = async () => {
    const ok = await store.reloadAll();
    if (ok) message.success("已重新加载");
  };

  return (
    <Layout style={{ height: "100vh" }}>
      {sider}
      <Layout>
        {currentProject && currentView !== "settings" && (
          <div style={{ padding: "12px 12px 0" }}>
            <TopBar
              projectName={currentProject.name}
              searchInputRef={searchInputRef}
              filteredCount={filteredTasks.length}
              totalCount={tasks.length}
            />
          </div>
        )}
        {store.error && (
          <div style={{ padding: "0 16px 8px" }}>
            <Alert
              type="error"
              showIcon
              message={store.error}
              closable
              onClose={store.clearError}
              action={
                <Button size="small" onClick={retryLast}>
                  重试
                </Button>
              }
            />
          </div>
        )}
        {currentView === "settings" ? (
          renderContent()
        ) : (
          <Content style={{ overflow: "auto" }}>
            {renderContent()}
          </Content>
        )}
      </Layout>

      {/* 新建项目弹窗 */}
      <Modal
        title="新建项目"
        open={newProjectOpen}
        okText="创建"
        onOk={submitNewProject}
        onCancel={() => setNewProjectOpen(false)}
      >
        <Input
          autoFocus
          placeholder="项目名称"
          value={projectForm.name}
          onChange={(e) => setProjectForm({ ...projectForm, name: e.target.value })}
          onPressEnter={submitNewProject}
          style={{ marginBottom: 8 }}
        />
        <TextArea placeholder="项目描述" rows={3} value={projectForm.desc} onChange={(e) => setProjectForm({ ...projectForm, desc: e.target.value })} />
      </Modal>

      {/* 重命名项目弹窗 */}
      <Modal
        title={renameTarget ? `重命名项目 "${renameTarget.name}"` : "重命名项目"}
        open={!!renameTarget}
        okText="保存"
        onOk={submitRename}
        onCancel={() => setRenameTarget(null)}
      >
        <Input
          autoFocus
          placeholder="项目名称"
          value={renameValue}
          maxLength={60}
          showCount
          status={renameValue.trim() ? "" : "error"}
          onChange={(e) => setRenameValue(e.target.value)}
          onPressEnter={submitRename}
        />
        {!renameValue.trim() && (
          <Text type="danger" style={{ fontSize: 12 }}>
            名称不能为空
          </Text>
        )}
      </Modal>

      {/* 引入本地 Agent 弹窗 */}
      <ImportLocalAgentModal
        open={importLocalOpen}
        onClose={() => setImportLocalOpen(false)}
        onImport={async (cli) => {
          try {
            await store.importLocalAgent(cli);
            message.success(`已引入 ${CLI_LABELS[cli.type]?.label || cli.type}`);
          } catch (e: any) {
            message.error(e?.toString() || "引入失败");
            throw e;
          }
        }}
        alreadyImported={new Set(agents.filter((a) => a.cli_type).map((a) => a.cli_type!))}
      />

      {/* 任务详情面板 */}
      <TaskDetailPanel
        task={selectedTask}
        agents={agents}
        open={!!selectedTask}
        onClose={() => setSelectedTaskId(null)}
      />
    </Layout>
  );
}

// ─────────── 引入本地 Agent 弹窗 ───────────
function ImportLocalAgentModal(props: {
  open: boolean;
  onClose: () => void;
  onImport: (cli: LocalAgentInfo) => Promise<void>;
  alreadyImported: Set<string>;
}) {
  const { open, onClose, onImport, alreadyImported } = props;
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [list, setList] = useState<LocalAgentInfo[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [importing, setImporting] = useState(false);

  const refresh = async () => {
    setLoading(true);
    setError(null);
    setSelected(new Set());
    try {
      const data = await useWorkerStore.getState().discoverLocalAgents();
      setList(data);
    } catch (e: any) {
      setList([]);
      setError(e?.toString?.() || "探测本地 CLI 失败");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { if (open) refresh(); }, [open]);

  const handleOk = async () => {
    if (selected.size === 0) return message.warning("请至少勾选一个");
    setImporting(true);
    try {
      for (const cli of list) {
        if (selected.has(cli.type)) await onImport(cli);
      }
      onClose();
    } catch {} finally {
      setImporting(false);
    }
  };

  return (
    <Modal
      title={<Space><ApiOutlined />引入本地 Agent</Space>}
      open={open}
      onCancel={onClose}
      onOk={handleOk}
      okText={`导入选中 (${selected.size})`}
      confirmLoading={importing}
      width={640}
    >
      <div style={{ marginBottom: 12, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <Text type="secondary">扫描本机已安装的 CLI: claude-code / hermes / opencode</Text>
        <Button size="small" icon={<ApiOutlined />} onClick={refresh} loading={loading}>重新探测</Button>
      </div>
      {loading ? (
        <div style={{ textAlign: "center", padding: 40 }}><Spin /></div>
      ) : error ? (
        <Alert
          type="error"
          showIcon
          message="无法探测本地 CLI"
          description={
            <Space direction="vertical" size={8}>
              <Text style={{ fontSize: 12 }}>{error}</Text>
              <Button size="small" onClick={refresh}>重试</Button>
            </Space>
          }
        />
      ) : list.length === 0 ? (
        <Alert type="warning" showIcon message="未发现本地 CLI" description="确保 agent-proxy 在 127.0.0.1:9099 在线" />
      ) : (
        <Space direction="vertical" size={8} style={{ width: "100%" }}>
          {list.map((cli) => {
            const meta = CLI_LABELS[cli.type] || { label: cli.type, color: "#666" };
            const imported = alreadyImported.has(cli.type);
            const checked = selected.has(cli.type);
            return (
              <Card
                key={cli.type}
                size="small"
                style={{
                  borderColor: checked ? "#1677ff" : undefined,
                  background: imported ? "#fafafa" : checked ? "#e6f4ff" : undefined,
                  opacity: imported ? 0.6 : 1,
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                  <Checkbox disabled={imported || !cli.available} checked={checked || imported}
                    onChange={(e) => { const next = new Set(selected); e.target.checked ? next.add(cli.type) : next.delete(cli.type); setSelected(next); }}
                  />
                  <Tag color={meta.color} style={{ minWidth: 110, textAlign: "center", margin: 0 }}>{meta.label}</Tag>
                  <div style={{ flex: 1 }}>
                    <Text code style={{ fontSize: 12 }}>{cli.command}</Text>
                    {cli.version && <Text type="secondary" style={{ marginLeft: 8, fontSize: 12 }}>v{cli.version}</Text>}
                    {imported && <Tag color="green" style={{ marginLeft: 8, fontSize: 11 }}>已挂载</Tag>}
                  </div>
                </div>
              </Card>
            );
          })}
        </Space>
      )}
    </Modal>
  );
}
