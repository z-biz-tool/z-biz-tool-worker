import { useEffect, useMemo, useState } from "react";
import {
  DndContext, closestCenter, PointerSensor, useSensor, useSensors,
  DragEndEvent, DragOverlay, DragStartEvent, useDroppable,
} from "@dnd-kit/core";
import {
  SortableContext, verticalListSortingStrategy, useSortable,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Card, Button, Tag, Avatar, Badge, Input, Modal, message, Typography, Space, Alert } from "antd";
import {
  PlusOutlined, ClockCircleOutlined, PlayCircleOutlined, PauseCircleOutlined,
  EyeOutlined, CheckCircleOutlined, HolderOutlined,
} from "@ant-design/icons";
import type { Task, Agent } from "../../types";
import { useWorkerStore } from "../../stores/workerStore";
import { useDraft } from "../../hooks/useDraft";
import {
  KANBAN_STATUSES, countUngroupedTasks, groupTasksByStatus, resolveDropStatus,
  type KanbanStatus,
} from "../../utils/kanbanLayout";

const { Text } = Typography;
const { TextArea } = Input;

const STATUS_CONFIG: Record<string, { color: string; label: string; icon: React.ReactNode }> = {
  todo: { color: "default", label: "待处理", icon: <ClockCircleOutlined /> },
  doing: { color: "processing", label: "进行中", icon: <PlayCircleOutlined /> },
  waiting: { color: "warning", label: "等待中", icon: <PauseCircleOutlined /> },
  review: { color: "orange", label: "待验收", icon: <EyeOutlined /> },
  done: { color: "success", label: "已完成", icon: <CheckCircleOutlined /> },
};

const PRIORITY_COLORS: Record<number, string> = { 0: "#d9d9d9", 1: "#faad14", 2: "#ff7a45", 3: "#f5222d" };
const PRIORITY_LABELS: Record<number, string> = { 0: "无", 1: "低", 2: "中", 3: "高" };
const AGENT_COLORS = ["#1677ff", "#52c41a", "#faad14", "#eb2f96", "#722ed1", "#13c2c2"];

interface KanbanViewProps {
  tasks: Task[];
  agents: Agent[];
  onTaskClick: (task: Task) => void;
  /** ⌘N 之类的快捷键在 App 层递增它，这里收到就弹新建任务框 */
  openNewTaskSignal?: number;
}

// 可拖拽的任务卡片
function SortableTaskCard({
  task, agents, onTaskClick,
}: {
  task: Task; agents: Agent[]; onTaskClick: (t: Task) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: task.id,
    data: { type: "task", task },
  });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : 1,
    zIndex: isDragging ? 100 : undefined,
  };

  const agent = task.assigned_agent_id ? agents.find((a) => a.id === task.assigned_agent_id) : null;

  return (
    <div ref={setNodeRef} style={style} {...attributes}>
      <Card
        size="small"
        hoverable
        onClick={() => onTaskClick(task)}
        style={{
          cursor: "grab",
          borderLeft: `3px solid ${PRIORITY_COLORS[task.priority] || "#d9d9d9"}`,
        }}
      >
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 4, flex: 1, minWidth: 0 }}>
              <span {...listeners} style={{ cursor: "grab", color: "#bbb", flexShrink: 0 }}>
                <HolderOutlined />
              </span>
              <Text strong style={{ fontSize: 13, flex: 1 }} ellipsis>{task.title}</Text>
            </div>
            {task.milestone && (
              <Tag color="gold" style={{ fontSize: 10, margin: 0, flexShrink: 0 }}>里程碑</Tag>
            )}
          </div>
          {task.description && (
            <Text type="secondary" style={{
              fontSize: 12,
              display: "-webkit-box",
              WebkitLineClamp: 2,
              WebkitBoxOrient: "vertical",
              overflow: "hidden",
            }}>
              {task.description}
            </Text>
          )}
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <Space size={4}>
              {task.priority > 0 && (
                <Tag
                  style={{
                    fontSize: 10, margin: 0,
                    borderColor: PRIORITY_COLORS[task.priority],
                    color: PRIORITY_COLORS[task.priority],
                  }}
                >
                  {PRIORITY_LABELS[task.priority]}
                </Tag>
              )}
              {task.due_date && (
                <Tag style={{ fontSize: 10, margin: 0 }}>
                  {new Date(task.due_date).toLocaleDateString("zh-CN", { month: "short", day: "numeric" })}
                </Tag>
              )}
              {task.tags?.slice(0, 2).map((tag) => (
                <Tag key={tag} style={{ fontSize: 10, margin: 0 }}>{tag}</Tag>
              ))}
              {(task.tags?.length || 0) > 2 && (
                <Tag style={{ fontSize: 10, margin: 0 }}>+{task.tags.length - 2}</Tag>
              )}
            </Space>
            {agent ? (
              <Avatar
                size={20}
                style={{
                  backgroundColor: AGENT_COLORS[agents.indexOf(agent) % AGENT_COLORS.length],
                  fontSize: 10,
                }}
              >
                {agent.name[0]}
              </Avatar>
            ) : (
              <Text type="secondary" style={{ fontSize: 11 }}>未分配</Text>
            )}
          </div>
        </div>
      </Card>
    </div>
  );
}

// 覆盖层卡片(拖拽时显示)
function DragOverlayCard({ task, agents }: { task: Task; agents: Agent[] }) {
  const agent = task.assigned_agent_id ? agents.find((a) => a.id === task.assigned_agent_id) : null;
  return (
    <Card size="small" style={{ width: 280, boxShadow: "0 8px 24px rgba(0,0,0,0.15)", borderLeft: `3px solid ${PRIORITY_COLORS[task.priority] || "#d9d9d9"}` }}>
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        <Text strong style={{ fontSize: 13 }}>{task.title}</Text>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <Space size={4}>
            {task.priority > 0 && <Tag style={{ fontSize: 10, margin: 0 }}>{PRIORITY_LABELS[task.priority]}</Tag>}
          </Space>
          {agent && <Avatar size={20} style={{ backgroundColor: "#1677ff", fontSize: 10 }}>{agent.name[0]}</Avatar>}
        </div>
      </div>
    </Card>
  );
}

// 一列 = 一个 drop 目标。原先只有卡片是 sortable、列容器没有 useDroppable，
// 于是「把任务拖到空列」根本没有可落点，用户看到的是拖过去没反应。
function KanbanColumn({
  status, list, agents, onTaskClick, onCreate,
}: {
  status: KanbanStatus;
  list: Task[];
  agents: Agent[];
  onTaskClick: (t: Task) => void;
  onCreate: (status: string) => void;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: status, data: { type: "column", status } });
  const cfg = STATUS_CONFIG[status];
  return (
    <div
      ref={setNodeRef}
      style={{
        minWidth: 280,
        maxWidth: 320,
        flex: "1 0 280px",
        background: isOver ? "#e6f4ff" : "#fafafa",
        outline: isOver ? "1px dashed #1677ff" : undefined,
        borderRadius: 8,
        display: "flex",
        flexDirection: "column",
        maxHeight: "calc(100vh - 180px)",
        transition: "background 0.15s ease",
      }}
    >
      {/* 列头 */}
      <div style={{
        padding: "12px 12px 8px",
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        borderBottom: "1px solid #f0f0f0",
      }}>
        <Space size={8}>
          <Tag color={cfg.color} icon={cfg.icon} style={{ margin: 0 }}>{cfg.label}</Tag>
          <Badge count={list.length} showZero color="#d9d9d9" />
        </Space>
        <Button
          type="text"
          size="small"
          icon={<PlusOutlined />}
          aria-label={`在「${cfg.label}」列新建任务`}
          onClick={() => onCreate(status)}
        />
      </div>

      {/* 卡片列表 */}
      <div style={{ flex: 1, overflow: "auto", padding: 8, display: "flex", flexDirection: "column", gap: 8 }}>
        <SortableContext items={list.map((t) => t.id)} strategy={verticalListSortingStrategy}>
          {list.map((task) => (
            <SortableTaskCard
              key={task.id}
              task={task}
              agents={agents}
              onTaskClick={onTaskClick}
            />
          ))}
        </SortableContext>
        {list.length === 0 && (
          <div style={{ textAlign: "center", padding: "24px 0", color: "#bbb", fontSize: 12 }}>
            暂无任务
          </div>
        )}
      </div>
    </div>
  );
}

export default function KanbanView({ tasks, agents, onTaskClick, openNewTaskSignal }: KanbanViewProps) {
  const store = useWorkerStore();
  const [newTaskOpen, setNewTaskOpen] = useState(false);
  const [newTaskStatus, setNewTaskStatus] = useState<string>("todo");
  const [newTaskForm, setNewTaskForm, resetNewTaskForm] = useDraft("task-new", { title: "", desc: "" });
  const [activeTask, setActiveTask] = useState<Task | null>(null);

  useEffect(() => {
    if (!openNewTaskSignal) return;
    setNewTaskStatus("todo");
    setNewTaskOpen(true);
  }, [openNewTaskSignal]);

  const tasksByStatus = useMemo(() => groupTasksByStatus(tasks), [tasks]);
  const ungrouped = useMemo(() => countUngroupedTasks(tasks), [tasks]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } })
  );

  const handleDragStart = (event: DragStartEvent) => {
    const { active } = event;
    const task = tasks.find((t) => t.id === active.id);
    if (task) setActiveTask(task);
  };

  const handleDragEnd = async (event: DragEndEvent) => {
    const { active, over } = event;
    setActiveTask(null);

    const resolution = resolveDropStatus(
      String(active.id),
      over ? String(over.id) : null,
      tasks,
    );
    if (!resolution) return;

    const ok = await store.updateTaskStatus(resolution.taskId, resolution.toStatus);
    if (ok) {
      message.success(`任务已移动到「${STATUS_CONFIG[resolution.toStatus]?.label}」`);
    }
  };

  const handleCreateTask = async () => {
    if (!newTaskForm.title.trim()) return message.warning("请输入任务标题");
    const currentProject = store.projects.find((p) => p.id === store.currentProjectId);
    if (!currentProject) return message.warning("请先选择项目");
    // 把用户点 + 时所在列一起传下去：旧实现只把状态存进 state，创建时又丢掉，
    // 于是在「进行中」列新建的任务会跑到「待处理」。
    const ok = await store.createTask(
      currentProject.id,
      newTaskForm.title.trim(),
      newTaskForm.desc,
      undefined,
      newTaskStatus,
    );
    if (!ok) return;
    message.success("任务已创建");
    setNewTaskOpen(false);
    resetNewTaskForm();
  };

  const openNewTask = (status: string) => {
    setNewTaskStatus(status);
    setNewTaskOpen(true);
  };

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
    >
      {ungrouped > 0 && (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 12 }}
          message={`有 ${ungrouped} 个任务的状态不在看板五列内，未显示`}
          description="请在列表视图把状态改为待处理/进行中/等待中/待验收/已完成之一。"
        />
      )}
      <div style={{ display: "flex", gap: 16, height: "100%", overflowX: "auto", padding: "0 4px" }}>
        {KANBAN_STATUSES.map((status) => (
          <KanbanColumn
            key={status}
            status={status}
            list={tasksByStatus[status]}
            agents={agents}
            onTaskClick={onTaskClick}
            onCreate={openNewTask}
          />
        ))}
      </div>

      <DragOverlay>
        {activeTask && <DragOverlayCard task={activeTask} agents={agents} />}
      </DragOverlay>

      {/* 新建任务弹窗 */}
      <Modal
        title={`新建任务（${STATUS_CONFIG[newTaskStatus]?.label || "待处理"}）`}
        open={newTaskOpen}
        onOk={handleCreateTask}
        onCancel={() => setNewTaskOpen(false)}
      >
        <Input
          placeholder="任务标题"
          value={newTaskForm.title}
          onChange={(e) => setNewTaskForm({ ...newTaskForm, title: e.target.value })}
          onPressEnter={handleCreateTask}
          style={{ marginBottom: 8 }}
        />
        <TextArea
          placeholder="任务描述"
          rows={4}
          value={newTaskForm.desc}
          onChange={(e) => setNewTaskForm({ ...newTaskForm, desc: e.target.value })}
        />
      </Modal>
    </DndContext>
  );
}
