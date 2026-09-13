import { useEffect, useMemo, useState } from "react";
import {
  Layout, Button, Modal, Input, Tag, Empty, Space, Typography, Dropdown,
  message, Avatar, Collapse, Card, Select, Checkbox, Spin, Alert,
} from "antd";
import {
  PlusOutlined, DeleteOutlined, CopyOutlined,
  ProjectOutlined, TeamOutlined, SettingOutlined, ApiOutlined,
  ReloadOutlined, ThunderboltOutlined, MenuFoldOutlined, MenuUnfoldOutlined,
} from "@ant-design/icons";
import { useWorkerStore } from "./stores/workerStore";
import { useViewStore } from "./stores/viewStore";
import type { Task, Agent, LocalAgentInfo, ViewType } from "./types";
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
const { Title, Text, Paragraph } = Typography;
const { TextArea } = Input;

const CLI_LABELS: Record<string, { label: string; color: string }> = {
  "claude-code": { label: "Claude Code", color: "#d97706" },
  hermes: { label: "Hermes", color: "#7c3aed" },
  opencode: { label: "OpenCode", color: "#0ea5e9" },
};

const AGENT_COLORS = ["#1677ff", "#52c41a", "#faad14", "#eb2f96", "#722ed1", "#13c2c2"];

export default function App() {
  const store = useWorkerStore();
  const { currentView, setView, sidebarCollapsed, toggleSidebar, searchQuery } = useViewStore();
  const [newProjectOpen, setNewProjectOpen] = useState(false);
  const [importLocalOpen, setImportLocalOpen] = useState(false);
  const [newTaskOpen, setNewTaskOpen] = useState(false);
  const [projectForm, setProjectForm] = useState({ name: "", desc: "" });
  const [taskForm, setTaskForm] = useState({ title: "", desc: "" });
  const [manualAgentForm, setManualAgentForm] = useState({ name: "", prompt: "", model: "" });
  const [selectedTask, setSelectedTask] = useState<Task | null>(null);

  useEffect(() => { store.loadProjects(); }, []);

  const currentProject = store.projects.find((p) => p.id === store.currentProjectId);
  const agents = store.agents;
  const tasks = store.tasks;

  // 搜索过滤
  const filteredTasks = useMemo(() => {
    if (!searchQuery) return tasks;
    const q = searchQuery.toLowerCase();
    return tasks.filter(
      (t) => t.title.toLowerCase().includes(q) || t.description.toLowerCase().includes(q)
    );
  }, [tasks, searchQuery]);

  // 轮询
  useEffect(() => {
    if (!currentProject) return;
    const hasInFlight = tasks.some((t) => t.status === "doing" || t.status === "waiting");
    if (!hasInFlight) return;
    const timer = setInterval(() => { store.selectProject(currentProject.id); }, 3000);
    return () => clearInterval(timer);
  }, [currentProject, tasks]);

  // 侧栏
  const sider = (
    <Sider
      width={sidebarCollapsed ? 48 : 220}
      collapsed={sidebarCollapsed}
      collapsedWidth={48}
      style={{ background: "#fff", borderRight: "1px solid #f0f0f0", transition: "width 0.2s" }}
    >
      <div style={{ padding: sidebarCollapsed ? "8px 4px" : "12px 12px" }}>
        {!sidebarCollapsed && (
          <>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
              <Text strong style={{ fontSize: 13 }}>项目</Text>
              <Button type="primary" size="small" icon={<PlusOutlined />} onClick={() => setNewProjectOpen(true)} />
            </div>
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
                      items: [{ key: "del", label: "删除", icon: <DeleteOutlined />, danger: true }],
                      onClick: () => {
                        Modal.confirm({
                          title: `删除项目 "${p.name}"?`,
                          onOk: () => store.deleteProject(p.id),
                        });
                      },
                    }}
                    trigger={["contextMenu"]}
                  >
                    <Button type="text" size="small" icon={<SettingOutlined />} />
                  </Dropdown>
                </div>
                <Text type="secondary" ellipsis style={{ fontSize: 11 }}>{p.description}</Text>
              </Card>
            ))}
            {store.projects.length === 0 && <Empty description="暂无项目" image={Empty.PRESENTED_IMAGE_SIMPLE} />}
          </>
        )}
      </div>
    </Sider>
  );

  // 主内容
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

    const handleTaskClick = (task: Task) => setSelectedTask(task);

    switch (currentView) {
      case "dashboard":
        return <Content style={{ padding: 16, overflow: "auto" }}><DashboardView tasks={filteredTasks} agents={agents} stats={store.stats} /></Content>;
      case "kanban":
        return <Content style={{ padding: 16, overflow: "auto" }}><KanbanView tasks={filteredTasks} agents={agents} onTaskClick={handleTaskClick} /></Content>;
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
        return <Content style={{ padding: 16, overflow: "auto" }}><KanbanView tasks={filteredTasks} agents={agents} onTaskClick={handleTaskClick} /></Content>;
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
                      onClick: ({ key }) => {
                        if (key === "del") Modal.confirm({ title: `删除 Agent "${a.name}"?`, onOk: () => store.deleteAgent(a.id) });
                        if (key === "clone") store.cloneAgent(currentProject!.id, a.id, "");
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
                    await store.createAgent(currentProject!.id, manualAgentForm.name, manualAgentForm.prompt, manualAgentForm.model);
                    setManualAgentForm({ name: "", prompt: "", model: "" });
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

  return (
    <Layout style={{ height: "100vh" }}>
      {sider}
      <Layout>
        {currentProject && currentView !== "settings" && (
          <TopBar projectName={currentProject.name} />
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
        onOk={async () => {
          if (!projectForm.name.trim()) return message.warning("请输入项目名称");
          await store.createProject(projectForm.name, projectForm.desc);
          setNewProjectOpen(false);
          setProjectForm({ name: "", desc: "" });
        }}
        onCancel={() => setNewProjectOpen(false)}
      >
        <Input placeholder="项目名称" value={projectForm.name} onChange={(e) => setProjectForm({ ...projectForm, name: e.target.value })} style={{ marginBottom: 8 }} />
        <TextArea placeholder="项目描述" rows={3} value={projectForm.desc} onChange={(e) => setProjectForm({ ...projectForm, desc: e.target.value })} />
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
        onClose={() => setSelectedTask(null)}
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
  const [list, setList] = useState<LocalAgentInfo[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [importing, setImporting] = useState(false);

  const refresh = async () => {
    setLoading(true);
    setSelected(new Set());
    try {
      const data = await useWorkerStore.getState().discoverLocalAgents();
      setList(data);
    } catch {
      setList([]);
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
        <Button size="small" icon={<ReloadOutlined />} onClick={refresh} loading={loading}>重新探测</Button>
      </div>
      {loading ? (
        <div style={{ textAlign: "center", padding: 40 }}><Spin /></div>
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
