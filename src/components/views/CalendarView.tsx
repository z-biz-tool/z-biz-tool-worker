import { useMemo, useState } from "react";
import { Card, Typography, Tag, Space, Button, Modal, Input, message } from "antd";
import { LeftOutlined, RightOutlined, PlusOutlined } from "@ant-design/icons";
import type { Task } from "../../types";
import { useWorkerStore } from "../../stores/workerStore";
import { useDraft } from "../../hooks/useDraft";
import {
  formatDateKey,
  groupTasksByDueDate,
  monthGrid,
  shiftMonth,
} from "../../utils/calendarLayout";

const { Text } = Typography;
const { TextArea } = Input;

const STATUS_COLORS: Record<string, string> = {
  todo: "#d9d9d9",
  doing: "#1677ff",
  waiting: "#faad14",
  review: "#ff7a45",
  done: "#52c41a",
};

interface CalendarViewProps {
  tasks: Task[];
}

export default function CalendarView({ tasks }: CalendarViewProps) {
  const store = useWorkerStore();
  const [currentDate, setCurrentDate] = useState(new Date());
  const [newTaskOpen, setNewTaskOpen] = useState(false);
  const [selectedDate, setSelectedDate] = useState("");
  const [newTaskForm, setNewTaskForm, resetNewTaskForm] = useDraft("task-new", { title: "", desc: "" });

  const year = currentDate.getFullYear();
  const month = currentDate.getMonth();

  // 月边界（这个月几天、1 号是周几）都在纯逻辑模块里（见 ../../utils/calendarLayout.ts），
  // 那里有逐条断言钉住；这里只负责渲染。
  const days = useMemo(() => monthGrid(year, month), [year, month]);

  const tasksByDate = useMemo(() => groupTasksByDueDate(tasks), [tasks]);

  const today = new Date().toISOString().slice(0, 10);

  const prevMonth = () => setCurrentDate(shiftMonth(year, month, -1));
  const nextMonth = () => setCurrentDate(shiftMonth(year, month, 1));

  const handleCreateTask = async () => {
    if (!newTaskForm.title.trim()) return message.warning("请输入任务标题");
    const currentProject = store.projects.find((p) => p.id === store.currentProjectId);
    if (!currentProject) return;
    const ok = await store.createTask(currentProject.id, newTaskForm.title.trim(), newTaskForm.desc);
    if (!ok) return;
    message.success("任务已创建");
    setNewTaskOpen(false);
    resetNewTaskForm();
  };

  const openNewTask = (day: number) => {
    const d = formatDateKey(year, month, day);
    setSelectedDate(d);
    setNewTaskOpen(true);
  };

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
        <Space>
          <Button icon={<LeftOutlined />} aria-label="上个月" onClick={prevMonth} />
          <Text strong style={{ fontSize: 16 }}>{year}年 {month + 1}月</Text>
          <Button icon={<RightOutlined />} aria-label="下个月" onClick={nextMonth} />
        </Space>
        <Button icon={<TodayOutlined />} onClick={() => setCurrentDate(new Date())}>
          今天
        </Button>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 1 }}>
        {["日", "一", "二", "三", "四", "五", "六"].map((d) => (
          <div key={d} style={{ textAlign: "center", padding: 8, background: "#fafafa", fontWeight: 600, fontSize: 12 }}>
            {d}
          </div>
        ))}
        {days.map((day, i) => {
          if (day === null) return <div key={`empty-${i}`} style={{ minHeight: 100, background: "#fafafa" }} />;
          const dateStr = formatDateKey(year, month, day);
          const dayTasks = tasksByDate.get(dateStr) || [];
          const isToday = dateStr === today;
          return (
            <div
              key={day}
              style={{
                minHeight: 100,
                border: isToday ? "2px solid #1677ff" : "1px solid #f0f0f0",
                padding: 4,
                cursor: "pointer",
                background: isToday ? "#e6f4ff" : "#fff",
              }}
              onClick={() => openNewTask(day)}
            >
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
                <Text
                  style={{
                    fontSize: 12,
                    fontWeight: isToday ? 700 : 400,
                    color: isToday ? "#1677ff" : undefined,
                  }}
                >
                  {day}
                </Text>
                {dayTasks.length > 0 && (
                  <Text type="secondary" style={{ fontSize: 10 }}>{dayTasks.length}</Text>
                )}
              </div>
              {dayTasks.slice(0, 3).map((t) => (
                <Tag
                  key={t.id}
                  color={STATUS_COLORS[t.status]}
                  style={{
                    fontSize: 10,
                    margin: "0 0 2px",
                    display: "block",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                    maxWidth: "100%",
                  }}
                >
                  {t.title}
                </Tag>
              ))}
              {dayTasks.length > 3 && (
                <Text type="secondary" style={{ fontSize: 10 }}>+{dayTasks.length - 3} 更多</Text>
              )}
            </div>
          );
        })}
      </div>

      <Modal title="新建任务" open={newTaskOpen} onOk={handleCreateTask} onCancel={() => setNewTaskOpen(false)}>
        <Text type="secondary" style={{ marginBottom: 8, display: "block" }}>
          截止日期: {selectedDate}
        </Text>
        <Input
          placeholder="任务标题"
          value={newTaskForm.title}
          onChange={(e) => setNewTaskForm({ ...newTaskForm, title: e.target.value })}
          style={{ marginBottom: 8 }}
        />
        <TextArea
          placeholder="任务描述"
          rows={3}
          value={newTaskForm.desc}
          onChange={(e) => setNewTaskForm({ ...newTaskForm, desc: e.target.value })}
        />
      </Modal>
    </div>
  );
}

function TodayOutlined() {
  return <span style={{ fontSize: 14 }}>今</span>;
}
