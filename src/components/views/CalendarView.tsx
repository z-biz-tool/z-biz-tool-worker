import { useMemo, useState } from "react";
import { Card, Typography, Tag, Space, Button, Modal, Input, message } from "antd";
import { LeftOutlined, RightOutlined, PlusOutlined } from "@ant-design/icons";
import type { Task } from "../../types";
import { useWorkerStore } from "../../stores/workerStore";

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
  const [newTaskForm, setNewTaskForm] = useState({ title: "", desc: "" });

  const year = currentDate.getFullYear();
  const month = currentDate.getMonth();

  const firstDay = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();

  const tasksByDate = useMemo(() => {
    const map = new Map<string, Task[]>();
    for (const t of tasks) {
      if (t.due_date) {
        const d = t.due_date.slice(0, 10);
        if (!map.has(d)) map.set(d, []);
        map.get(d)!.push(t);
      }
    }
    return map;
  }, [tasks]);

  const today = new Date().toISOString().slice(0, 10);

  const days: (number | null)[] = [];
  for (let i = 0; i < firstDay; i++) days.push(null);
  for (let i = 1; i <= daysInMonth; i++) days.push(i);

  const prevMonth = () => setCurrentDate(new Date(year, month - 1, 1));
  const nextMonth = () => setCurrentDate(new Date(year, month + 1, 1));

  const handleCreateTask = async () => {
    if (!newTaskForm.title.trim()) return message.warning("请输入任务标题");
    const currentProject = store.projects.find((p) => p.id === store.currentProjectId);
    if (!currentProject) return;
    await store.createTask(currentProject.id, newTaskForm.title, newTaskForm.desc);
    setNewTaskOpen(false);
    setNewTaskForm({ title: "", desc: "" });
  };

  const openNewTask = (day: number) => {
    const d = `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    setSelectedDate(d);
    setNewTaskOpen(true);
  };

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
        <Space>
          <Button icon={<LeftOutlined />} onClick={prevMonth} />
          <Text strong style={{ fontSize: 16 }}>{year}年 {month + 1}月</Text>
          <Button icon={<RightOutlined />} onClick={nextMonth} />
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
          const dateStr = `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
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
