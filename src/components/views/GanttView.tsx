import { useMemo, useState } from "react";
import { Typography, Tag, Space, Button, Select } from "antd";
import { LeftOutlined, RightOutlined } from "@ant-design/icons";
import type { Task } from "../../types";
import {
  GANTT_STATUS_COLORS,
  ganttBarStyle,
  ganttHeaders,
  ganttTimeline,
  type GanttZoom,
} from "../../utils/ganttLayout";

const { Text } = Typography;

interface GanttViewProps {
  tasks: Task[];
}

export default function GanttView({ tasks: allTasks }: GanttViewProps) {
  const [zoom, setZoom] = useState<GanttZoom>("week");

  const tasks = useMemo(
    () => allTasks.filter((t) => t.due_date || t.start_date).sort((a, b) => (a.start_date || a.created_at).localeCompare(b.start_date || b.created_at)),
    [allTasks]
  );

  // 时间轴的锚点与尺度、每根条子的定位都在纯逻辑模块里（见 ../../utils/ganttLayout.ts），
  // 那里有逐条断言钉住；这里只负责渲染。
  //
  // 刻意**不**做 useMemo：原实现每次渲染都重算锚点（`new Date()`），
  // 缓存住反而会让视窗在应用长时间不切档位时"停住"。
  const timeline = ganttTimeline(new Date(), zoom);
  const headers = ganttHeaders(timeline, zoom);

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
              <Tag color={GANTT_STATUS_COLORS[t.status]} style={{ fontSize: 10, margin: 0 }}>
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
            const bar = ganttBarStyle(t, timeline);
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
