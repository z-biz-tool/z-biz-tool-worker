import { useState, useEffect } from "react";
import {
  Drawer, Input, Select, DatePicker, Tag, Space, Button, Typography, Divider,
  Avatar, List, message, Checkbox, Collapse, Empty,
} from "antd";
import {
  UserOutlined, DeleteOutlined, ClockCircleOutlined,
  CheckCircleOutlined, PlayCircleOutlined, EyeOutlined, PauseCircleOutlined,
  LinkOutlined, FlagOutlined, PlusOutlined,
} from "@ant-design/icons";
import type { Task, Agent, TaskMessage } from "../types";
import { useWorkerStore } from "../stores/workerStore";
import { invoke } from "@tauri-apps/api/core";
import dayjs from "dayjs";

const { Text, Paragraph } = Typography;
const { TextArea } = Input;

const STATUS_OPTIONS = [
  { value: "todo", label: "待处理", icon: <ClockCircleOutlined /> },
  { value: "doing", label: "进行中", icon: <PlayCircleOutlined /> },
  { value: "waiting", label: "等待中", icon: <PauseCircleOutlined /> },
  { value: "review", label: "待验收", icon: <EyeOutlined /> },
  { value: "done", label: "已完成", icon: <CheckCircleOutlined /> },
];

const PRIORITY_OPTIONS = [
  { value: 0, label: "无优先级" },
  { value: 1, label: "低" },
  { value: 2, label: "中" },
  { value: 3, label: "高" },
];

const PRIORITY_COLORS: Record<number, string> = { 0: "#d9d9d9", 1: "#faad14", 2: "#ff7a45", 3: "#f5222d" };

interface TaskDetailPanelProps {
  task: Task | null;
  agents: Agent[];
  open: boolean;
  onClose: () => void;
}

export default function TaskDetailPanel({ task, agents, open, onClose }: TaskDetailPanelProps) {
  const store = useWorkerStore();
  const [messages, setMessages] = useState<TaskMessage[]>([]);
  const [newMsg, setNewMsg] = useState("");
  const [sending, setSending] = useState(false);
  const [dependencies, setDependencies] = useState<string[]>([]);
  const [allTasks, setAllTasks] = useState<Task[]>([]);
  const [newTag, setNewTag] = useState("");
  const [editingDesc, setEditingDesc] = useState(false);
  const [descValue, setDescValue] = useState("");

  if (!task) return null;

  const loadMessages = async () => {
    try {
      const msgs = await invoke<TaskMessage[]>("get_task_messages", { taskId: task.id });
      setMessages(msgs);
    } catch {}
  };

  const loadDependencies = async () => {
    try {
      const deps = await invoke<string[]>("get_task_dependencies", { taskId: task.id });
      setDependencies(deps);
    } catch {}
  };

  const loadAllTasks = async () => {
    try {
      const tasks = await invoke<Task[]>("list_tasks", { projectId: task.project_id });
      setAllTasks(tasks.filter((t) => t.id !== task.id));
    } catch {}
  };

  useEffect(() => {
    if (open && task) {
      loadMessages();
      loadDependencies();
      loadAllTasks();
    }
  }, [open, task?.id]);

  const handleStatusChange = async (status: string) => {
    await store.updateTaskStatus(task.id, status);
    message.success("状态已更新");
  };

  const handlePriorityChange = async (priority: number) => {
    await invoke("update_task", { taskId: task.id, params: { priority } });
    store.selectProject(task.project_id);
  };

  const handleDateChange = async (field: "start_date" | "due_date", date: dayjs.Dayjs | null) => {
    await invoke("update_task", { taskId: task.id, params: { [field]: date ? date.format("YYYY-MM-DD") : null } });
    store.selectProject(task.project_id);
  };

  const handleMilestoneToggle = async () => {
    await invoke("update_task", { taskId: task.id, params: { milestone: !task.milestone } });
    store.selectProject(task.project_id);
    message.success(task.milestone ? "已取消里程碑" : "已设为里程碑");
  };

  const handleAddTag = async () => {
    if (!newTag.trim()) return;
    const tags = [...(task.tags || []), newTag.trim()];
    await invoke("update_task", { taskId: task.id, params: { tags } });
    store.selectProject(task.project_id);
    setNewTag("");
  };

  const handleRemoveTag = async (tag: string) => {
    const tags = (task.tags || []).filter((t) => t !== tag);
    await invoke("update_task", { taskId: task.id, params: { tags } });
    store.selectProject(task.project_id);
  };

  const handleDependencyToggle = async (depId: string) => {
    const newDeps = dependencies.includes(depId)
      ? dependencies.filter((d) => d !== depId)
      : [...dependencies, depId];
    try {
      await invoke("set_task_dependencies", { taskId: task.id, dependsOn: newDeps });
      setDependencies(newDeps);
      message.success("依赖已更新");
    } catch (e: any) {
      message.error(e?.toString() || "设置依赖失败");
    }
  };

  const handleSaveDesc = async () => {
    await invoke("update_task", { taskId: task.id, params: { description: descValue } });
    store.selectProject(task.project_id);
    setEditingDesc(false);
    message.success("描述已保存");
  };

  const handleSendMessage = async () => {
    if (!newMsg.trim()) return;
    setSending(true);
    try {
      const result = await invoke<{ user: TaskMessage; agent: TaskMessage | null }>("send_task_message", {
        taskId: task.id,
        message: newMsg,
      });
      setMessages([...messages, result.user, ...(result.agent ? [result.agent] : [])]);
      setNewMsg("");
    } catch (e) {
      message.error("发送失败");
    } finally {
      setSending(false);
    }
  };

  return (
    <Drawer
      title={
        <Space>
          {task.milestone && <FlagOutlined style={{ color: "#faad14" }} />}
          {task.title}
        </Space>
      }
      open={open}
      onClose={onClose}
      width={520}
      extra={
        <Space>
          <Button
            icon={<FlagOutlined />}
            type={task.milestone ? "primary" : "default"}
            onClick={handleMilestoneToggle}
          >
            {task.milestone ? "已里程碑" : "设为里程碑"}
          </Button>
          <Button danger icon={<DeleteOutlined />} onClick={() => { store.deleteTask(task.id); onClose(); }}>
            删除
          </Button>
        </Space>
      }
    >
      {/* 状态 */}
      <div style={{ marginBottom: 16 }}>
        <Text type="secondary" style={{ fontSize: 12, marginBottom: 4, display: "block" }}>状态</Text>
        <Select value={task.status} onChange={handleStatusChange} style={{ width: "100%" }} options={STATUS_OPTIONS} />
      </div>

      {/* 优先级 */}
      <div style={{ marginBottom: 16 }}>
        <Text type="secondary" style={{ fontSize: 12, marginBottom: 4, display: "block" }}>优先级</Text>
        <Select value={task.priority} onChange={handlePriorityChange} style={{ width: "100%" }} options={PRIORITY_OPTIONS} />
      </div>

      {/* Agent 分配 */}
      <div style={{ marginBottom: 16 }}>
        <Text type="secondary" style={{ fontSize: 12, marginBottom: 4, display: "block" }}>分配给</Text>
        <Select
          value={task.assigned_agent_id || undefined}
          onChange={async (agentId: string) => { if (agentId) await store.assignTask(task.id, agentId); }}
          style={{ width: "100%" }}
          placeholder="选择 Agent"
          allowClear
          options={agents.map((a) => ({
            value: a.id,
            label: <Space><Avatar size={16} style={{ backgroundColor: "#1677ff" }}>{a.name[0]}</Avatar>{a.name}</Space>,
          }))}
        />
      </div>

      {/* 日期 */}
      <Space style={{ width: "100%", marginBottom: 16 }} size={12}>
        <div style={{ flex: 1 }}>
          <Text type="secondary" style={{ fontSize: 12, marginBottom: 4, display: "block" }}>开始日期</Text>
          <DatePicker value={task.start_date ? dayjs(task.start_date) : null} onChange={(d) => handleDateChange("start_date", d)} style={{ width: "100%" }} />
        </div>
        <div style={{ flex: 1 }}>
          <Text type="secondary" style={{ fontSize: 12, marginBottom: 4, display: "block" }}>截止日期</Text>
          <DatePicker value={task.due_date ? dayjs(task.due_date) : null} onChange={(d) => handleDateChange("due_date", d)} style={{ width: "100%" }} />
        </div>
      </Space>

      <Divider style={{ margin: "12px 0" }} />

      {/* 标签管理 */}
      <div style={{ marginBottom: 16 }}>
        <Text type="secondary" style={{ fontSize: 12, marginBottom: 4, display: "block" }}>标签</Text>
        <Space wrap style={{ marginBottom: 8 }}>
          {task.tags?.map((tag) => (
            <Tag key={tag} closable onClose={() => handleRemoveTag(tag)}>{tag}</Tag>
          ))}
        </Space>
        <Space>
          <Input
            size="small"
            placeholder="添加标签"
            value={newTag}
            onChange={(e) => setNewTag(e.target.value)}
            onPressEnter={handleAddTag}
            style={{ width: 120 }}
          />
          <Button size="small" icon={<PlusOutlined />} onClick={handleAddTag}>添加</Button>
        </Space>
      </div>

      <Divider style={{ margin: "12px 0" }} />

      {/* 描述 */}
      <div style={{ marginBottom: 16 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
          <Text type="secondary" style={{ fontSize: 12 }}>描述</Text>
          {!editingDesc && (
            <Button size="small" type="link" onClick={() => { setEditingDesc(true); setDescValue(task.description || ""); }}>
              编辑
            </Button>
          )}
        </div>
        {editingDesc ? (
          <div>
            <TextArea
              value={descValue}
              onChange={(e) => setDescValue(e.target.value)}
              rows={4}
              style={{ marginBottom: 8 }}
            />
            <Space>
              <Button size="small" onClick={() => setEditingDesc(false)}>取消</Button>
              <Button size="small" type="primary" onClick={handleSaveDesc}>保存</Button>
            </Space>
          </div>
        ) : (
          <Paragraph style={{ whiteSpace: "pre-wrap", fontSize: 13, margin: 0 }}>
            {task.description || "暂无描述，点击编辑添加"}
          </Paragraph>
        )}
      </div>

      {/* 输出 */}
      {(task.output || task.agent_output) && (
        <div style={{ marginBottom: 16 }}>
          <Text type="secondary" style={{ fontSize: 12, marginBottom: 4, display: "block" }}>Agent 输出</Text>
          <div style={{
            background: "#fafafa", padding: 12, borderRadius: 6,
            whiteSpace: "pre-wrap", fontSize: 12, fontFamily: "monospace",
            maxHeight: 200, overflow: "auto",
          }}>
            {task.output || task.agent_output}
          </div>
        </div>
      )}

      <Divider style={{ margin: "12px 0" }} />

      {/* 任务依赖 */}
      <div style={{ marginBottom: 16 }}>
        <Text type="secondary" style={{ fontSize: 12, marginBottom: 8, display: "block" }}>
          <LinkOutlined /> 任务依赖 ({dependencies.length})
        </Text>
        {allTasks.length > 0 ? (
          <div style={{ maxHeight: 150, overflow: "auto", border: "1px solid #f0f0f0", borderRadius: 6, padding: 8 }}>
            {allTasks.map((t) => (
              <div key={t.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "4px 0" }}>
                <Checkbox
                  checked={dependencies.includes(t.id)}
                  onChange={() => handleDependencyToggle(t.id)}
                />
                <Tag
                  color={t.status === "done" ? "success" : t.status === "doing" ? "processing" : "default"}
                  style={{ fontSize: 10, margin: 0, minWidth: 40, textAlign: "center" }}
                >
                  {t.status}
                </Tag>
                <Text style={{ fontSize: 12, flex: 1 }} ellipsis>{t.title}</Text>
              </div>
            ))}
          </div>
        ) : (
          <Text type="secondary" style={{ fontSize: 12 }}>暂无其他任务</Text>
        )}
      </div>

      <Divider style={{ margin: "12px 0" }} />

      {/* 消息/对话 */}
      <div>
        <Text type="secondary" style={{ fontSize: 12, marginBottom: 8, display: "block" }}>对话</Text>
        <div style={{ display: "flex", gap: 8 }}>
          <Input
            value={newMsg}
            onChange={(e) => setNewMsg(e.target.value)}
            onPressEnter={handleSendMessage}
            placeholder="发送消息给 Agent..."
            disabled={sending}
          />
          <Button type="primary" onClick={handleSendMessage} loading={sending}>发送</Button>
        </div>
      </div>
    </Drawer>
  );
}
