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

// task 在 null/非 null 间切换会让同一组件的 hooks 数量变化（React 直接抛错），
// 所以提前 return 放在包装层，让整棵子树装卸。
export default function TaskDetailPanel(props: TaskDetailPanelProps) {
  if (!props.task) return null;
  return <TaskDetailPanelBody {...props} task={props.task} />;
}

function TaskDetailPanelBody({ task, agents, open, onClose }: TaskDetailPanelProps & { task: Task }) {
  const store = useWorkerStore();
  const [messages, setMessages] = useState<TaskMessage[]>([]);
  const [newMsg, setNewMsg] = useState("");
  const [sending, setSending] = useState(false);
  const [dependencies, setDependencies] = useState<string[]>([]);
  const [allTasks, setAllTasks] = useState<Task[]>([]);
  const [newTag, setNewTag] = useState("");
  const [editingDesc, setEditingDesc] = useState(false);
  const [descValue, setDescValue] = useState("");

  const loadMessages = async () => {
    try {
      const msgs = await invoke<TaskMessage[]>("get_task_messages", { taskId: task.id });
      setMessages(msgs);
    } catch (e: any) {
      setMessages([]);
      message.error(`加载任务消息失败：${e?.toString?.() || e}`);
    }
  };

  const loadDependencies = async () => {
    try {
      const deps = await invoke<string[]>("get_task_dependencies", { taskId: task.id });
      setDependencies(deps);
    } catch (e: any) {
      setDependencies([]);
      message.error(`加载依赖关系失败：${e?.toString?.() || e}`);
    }
  };

  const loadAllTasks = async () => {
    try {
      const tasks = await invoke<Task[]>("list_tasks", { projectId: task.project_id });
      setAllTasks(tasks.filter((t) => t.id !== task.id));
    } catch (e: any) {
      setAllTasks([]);
      message.error(`加载可选依赖任务失败：${e?.toString?.() || e}`);
    }
  };

  useEffect(() => {
    if (open && task) {
      loadMessages();
      loadDependencies();
      loadAllTasks();
    }
  }, [open, task?.id]);

  // 任务被更新（后台自动执行跑完了 ⇒ task.updated_at 变了）⇒ 把对话也刷新一次。
  // ⚠ 不刷的话，自动执行的结果要等用户**关掉再打开**面板才看得见
  //   （5 秒轮询只更新 task，不更新本面板的 messages 状态）。
  useEffect(() => {
    if (open && task) loadMessages();
  }, [open, task?.updated_at]);

  const handleStatusChange = async (status: string) => {
    if (await store.updateTaskStatus(task.id, status)) message.success("状态已更新");
  };

  const handlePriorityChange = async (priority: number) => {
    await store.updateTask(task.id, { priority });
  };

  const handleDateChange = async (field: "start_date" | "due_date", date: dayjs.Dayjs | null) => {
    await store.updateTask(task.id, { [field]: date ? date.format("YYYY-MM-DD") : null });
  };

  const handleMilestoneToggle = async () => {
    const wasMilestone = task.milestone;
    if (await store.updateTask(task.id, { milestone: !wasMilestone })) {
      message.success(wasMilestone ? "已取消里程碑" : "已设为里程碑");
    }
  };

  const handleAddTag = async () => {
    if (!newTag.trim()) return;
    const tags = [...(task.tags || []), newTag.trim()];
    if (await store.updateTask(task.id, { tags })) setNewTag("");
  };

  const handleRemoveTag = async (tag: string) => {
    const tags = (task.tags || []).filter((t) => t !== tag);
    await store.updateTask(task.id, { tags });
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
    if (await store.updateTask(task.id, { description: descValue })) {
      setEditingDesc(false);
      message.success("描述已保存");
    }
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
      // ⚠ 后端在「没有分配 Agent」时会**只存用户消息、agent 返回 null**
      //   （消息落库了，但没人回）⇒ 这里必须说清楚，
      //   否则用户以为消息发出去了石沉大海。
      if (!result.agent) {
        message.warning("消息已记录，但这个任务还没有分配 Agent，暂时没人回复");
      }
    } catch (e) {
      message.error(`发送失败：${e?.toString?.() || e}`);
    } finally {
      setSending(false);
    }
  };

  // 「Agent 输出」的内容**已经在对话里出现过**时就不重复显示同一份内容
  // （自动执行的结果现在既写进 task.output、也写进对话历史 ⇒ 两处一模一样）。
  const outputText = (task.output || task.agent_output || "").trim();
  const outputAlreadyInChat = outputText
    ? messages.some((m) => m.role === "agent" && m.content.trim() === outputText)
    : false;

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
      {(outputText && !outputAlreadyInChat) && (
        <div style={{ marginBottom: 16 }}>
          <Text type="secondary" style={{ fontSize: 12, marginBottom: 4, display: "block" }}>Agent 输出</Text>
          <div style={{
            background: "#fafafa", padding: 12, borderRadius: 6,
            whiteSpace: "pre-wrap", fontSize: 12, fontFamily: "monospace",
            maxHeight: 200, overflow: "auto",
          }}>
            {outputText}
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
        <Text type="secondary" style={{ fontSize: 12, marginBottom: 8, display: "block" }}>
          对话{messages.length > 0 ? `（${messages.length} 条）` : ""}
        </Text>
        {/* ⚠ 这一段以前**根本没有渲染**：`messages` 被加载、被追加，却从不上屏
            ⇒ 用户发的消息和 Agent 的回答在界面上一个字都看不到。 */}
        <div style={{
          maxHeight: 260, overflow: "auto", marginBottom: 8,
          border: "1px solid #f0f0f0", borderRadius: 6, padding: 8,
          background: "#fcfcfc",
        }}>
          {messages.length === 0 ? (
            <Text type="secondary" style={{ fontSize: 12 }}>
              {task.assigned_agent_id
                ? "还没有对话记录。可以直接给 Agent 发消息。"
                : "还没有对话记录。这个任务还没分配 Agent —— 消息会被记下来，但没人回复。"}
            </Text>
          ) : (
            messages.map((m) => (
              <div
                key={m.id}
                style={{
                  marginBottom: 8,
                  display: "flex",
                  justifyContent: m.role === "user" ? "flex-end" : "flex-start",
                }}
              >
                <div style={{
                  maxWidth: "86%",
                  background: m.role === "user" ? "#e6f4ff" : "#fff",
                  border: "1px solid #f0f0f0",
                  borderRadius: 8,
                  padding: "6px 10px",
                }}>
                  <Text type="secondary" style={{ fontSize: 11, display: "block", marginBottom: 2 }}>
                    {m.role === "user" ? "我" : "Agent"}
                    {" · "}
                    {new Date(m.created_at).toLocaleString("zh-CN")}
                  </Text>
                  <Text style={{ fontSize: 13, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
                    {m.content}
                  </Text>
                </div>
              </div>
            ))
          )}
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <Input
            value={newMsg}
            onChange={(e) => setNewMsg(e.target.value)}
            onPressEnter={handleSendMessage}
            placeholder={task.assigned_agent_id ? "发送消息给 Agent..." : "发送消息（该任务未分配 Agent，消息只记录不回）"}
            disabled={sending}
          />
          <Button type="primary" onClick={handleSendMessage} loading={sending}>发送</Button>
        </div>
      </div>
    </Drawer>
  );
}
