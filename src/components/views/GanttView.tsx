import { useMemo, useState } from "react";
import { Typography, Tag, Space, Button, Select } from "antd";
import { LeftOutlined, RightOutlined } from "@ant-design/icons";
import type { Task } from "../../types";

const { Text } = Typography;

const STATUS_COLORS: Record<string, string> = {
  todo: "#d9d9d9",
  doing: "#1677ff",
  waiting: "#faad14",
  review: "#ff7a45",
  done: "#52c41a",
};

interface GanttViewProps {
  tasks: Task[];
}

export default function GanttView({ tasks: allTasks }: GanttViewProps) {
  const [zoom, setZoom] = useState<"day" | "week" | "month">("week");

  const tasks = useMemo(
    () => allTasks.filter((t) => t.due_date || t.start_date).sort((a, b) => (a.start_date || a.created_at).localeCompare(b.start_date || b.created_at)),
    [allTasks]
  );

  const now = new Date();
  const viewDays = zoom === "day" ? 14 : zoom === "week" ? 56 : 120;
  const startDate = new Date(now);
  startDate.setDate(startDate.getDate() - 7);
  const endDate = new Date(startDate);
  endDate.setDate(endDate.getDate() + viewDays);

  const totalDays = Math.ceil((endDate.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24));
  const dayWidth = zoom === "day" ? 40 : zoom === "week" ? 14 : 5;

  const headers: { label: string; left: number; width: number }[] = [];
  for (let i = 0; i < totalDays; i++) {
    const d = new Date(startDate);
    d.setDate(d.getDate() + i);
    const label = zoom === "day"
      ? `${d.getMonth() + 1}/${d.getDate()}`
      : zoom === "week"
        ? (d.getDay() === 1 ? `${d.getMonth() + 1}/${d.getDate()}` : "")
        : (d.getDate() === 1 ? `${d.getFullYear()}/${d.getMonth() + 1}` : "");
    headers.push({
      label,
      left: i * dayWidth,
      width: dayWidth,
    });
  }

  const getBarStyle = (task: Task) => {
    const start = task.start_date ? new Date(task.start_date) : new Date(task.created_at);
    const end = task.due_date ? new Date(task.due_date) : new Date(start);
    if (!task.due_date) end.setDate(end.getDate() + 3);

    const leftDays = Math.max(0, Math.ceil((start.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24)));
    const widthDays = Math.max(1, Math.ceil((end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24)));

    return {
      left: leftDays * dayWidth,
      width: Math.max(widthDays * dayWidth, 20),
      background: STATUS_COLORS[task.status] || "#d9d9d9",
    };
  };

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
        <Space>
          <Text strong>甘特图</Text>
          <Text type="secondary">({tasks.length} 个有日期的任务)</Text>
        </Space>
        <Select
          value={zoom}
          onChange={setZoom}
          style={{ width: 100 }}
          options={[
            { value: "day", label: "按天" },
            { value: "week", label: "按周" },
            { value: "month", label: "按月" },
          ]}
        />
      </div>

      <div style={{ display: "flex", border: "1px solid #f0f0f0", borderRadius: 8, overflow: "hidden" }}>
        {/* 左侧任务列表 */}
        <div style={{ width: 200, flexShrink: 0, borderRight: "1px solid #f0f0f0" }}>
          <div style={{ padding: "8px 12px", background: "#fafafa", fontWeight: 600, fontSize: 12, borderBottom: "1px solid #f0f0f0" }}>
            任务名称
          </div>
          {tasks.map((t) => (
            <div
              key={t.id}
              style={{
                padding: "6px 12px",
                borderBottom: "1px solid #f0f0f0",
                fontSize: 12,
                display: "flex",
                alignItems: "center",
                gap: 6,
              }}
            >
              <Tag color={STATUS_COLORS[t.status]} style={{ fontSize: 10, margin: 0 }}>
                {t.status}
              </Tag>
              <Text ellipsis style={{ fontSize: 12 }}>{t.title}</Text>
            </div>
          ))}
          {tasks.length === 0 && (
            <div style={{ padding: 24, textAlign: "center", color: "#bbb", fontSize: 12 }}>
              暂无带日期的任务
            </div>
          )}
        </div>

        {/* 右侧时间轴 */}
        <div style={{ flex: 1, overflow: "auto" }}>
          {/* 日期头部 */}
          <div style={{ position: "relative", height: 28, background: "#fafafa", borderBottom: "1px solid #f0f0f0" }}>
            {headers.map((h, i) => (
              <div
                key={i}
                style={{
                  position: "absolute",
                  left: h.left,
                  width: h.width,
                  height: "100%",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontSize: 10,
                  color: "#999",
                  borderRight: "1px solid #f0f0f0",
                }}
              >
                {h.label}
              </div>
            ))}
          </div>

          {/* 任务条 */}
          {tasks.map((t) => {
            const bar = getBarStyle(t);
            return (
              <div
                key={t.id}
                style={{
                  position: "relative",
                  height: 28,
                  borderBottom: "1px solid #f0f0f0",
                }}
              >
                <div
                  style={{
                    position: "absolute",
                    left: bar.left,
                    top: 4,
                    height: 20,
                    width: bar.width,
                    background: bar.background,
                    borderRadius: 4,
                    opacity: 0.85,
                  }}
                  title={`${t.title} (${t.start_date || "无"} → ${t.due_date || "无"})`}
                />
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
