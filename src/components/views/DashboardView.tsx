import { useMemo } from "react";
import { Card, Row, Col, Typography, Progress, Tag, Timeline, Space, Statistic } from "antd";
import {
  ClockCircleOutlined, PlayCircleOutlined, PauseCircleOutlined,
  EyeOutlined, CheckCircleOutlined, TeamOutlined, ProjectOutlined,
} from "@ant-design/icons";
import type { Task, Agent, ProjectStats } from "../../types";

// 渐变色主题常量
const brandGradient = "linear-gradient(135deg, #667eea 0%, #764ba2 100%)";
const cardBgGradient = "linear-gradient(135deg, rgba(102,126,234,0.04) 0%, rgba(118,75,162,0.04) 100%)";

const { Title, Text } = Typography;

const STATUS_COLORS: Record<string, string> = {
  todo: "#d9d9d9",
  doing: "#1677ff",
  waiting: "#faad14",
  review: "#ff7a45",
  done: "#52c41a",
};

interface DashboardViewProps {
  tasks: Task[];
  agents: Agent[];
  stats: ProjectStats | null;
}

export default function DashboardView({ tasks, agents, stats }: DashboardViewProps) {
  const recentTasks = useMemo(
    () => [...tasks].sort((a, b) => b.updated_at.localeCompare(a.updated_at)).slice(0, 8),
    [tasks]
  );

  const completedRate = stats && stats.tasks.total > 0
    ? Math.round((stats.tasks.done / stats.tasks.total) * 100)
    : 0;

  const agentWorkload = useMemo(() => {
    const map = new Map<string, number>();
    for (const t of tasks) {
      if (t.assigned_agent_id && (t.status === "doing" || t.status === "waiting")) {
        map.set(t.assigned_agent_id, (map.get(t.assigned_agent_id) || 0) + 1);
      }
    }
    return agents.map((a) => ({
      agent: a,
      count: map.get(a.id) || 0,
    }));
  }, [tasks, agents]);

  return (
    <div style={{ padding: "0 4px" }}>
      {/* 统计卡片 */}
      <Row gutter={[16, 16]} style={{ marginBottom: 16 }}>
        <Col span={6}>
          <Card 
            size="small"
            style={{ 
              borderRadius: 12,
              background: cardBgGradient,
              transition: "all 0.3s cubic-bezier(0.4, 0, 0.2, 1)",
            }}
            bodyStyle={{ padding: "12px" }}
          >
            <Statistic
              title={
                <span style={{ fontSize: 12, color: "var(--ant-color-text-secondary)" }}>总任务</span>
              }
              value={stats?.tasks.total || 0}
              prefix={<ProjectOutlined style={{ color: brandGradient }} />}
              valueStyle={{ fontSize: 20, fontWeight: 600 }}
            />
          </Card>
        </Col>
        <Col span={6}>
          <Card 
            size="small"
            style={{ 
              borderRadius: 12,
              background: cardBgGradient,
              transition: "all 0.3s cubic-bezier(0.4, 0, 0.2, 1)",
            }}
            bodyStyle={{ padding: "12px" }}
          >
            <Statistic
              title={
                <span style={{ fontSize: 12, color: "var(--ant-color-text-secondary)" }}>进行中</span>
              }
              value={stats?.tasks.doing || 0}
              valueStyle={{ color: "#1677ff", fontSize: 20, fontWeight: 600 }}
              prefix={<PlayCircleOutlined style={{ color: "#1677ff" }} />}
            />
          </Card>
        </Col>
        <Col span={6}>
          <Card 
            size="small"
            style={{ 
              borderRadius: 12,
              background: cardBgGradient,
              transition: "all 0.3s cubic-bezier(0.4, 0, 0.2, 1)",
            }}
            bodyStyle={{ padding: "12px" }}
          >
            <Statistic
              title={
                <span style={{ fontSize: 12, color: "var(--ant-color-text-secondary)" }}>Agent 数</span>
              }
              value={stats?.agents.total || 0}
              prefix={<TeamOutlined style={{ color: brandGradient }} />}
              valueStyle={{ fontSize: 20, fontWeight: 600 }}
            />
          </Card>
        </Col>
        <Col span={6}>
          <Card 
            size="small"
            style={{ 
              borderRadius: 12,
              background: cardBgGradient,
              transition: "all 0.3s cubic-bezier(0.4, 0, 0.2, 1)",
            }}
            bodyStyle={{ padding: "12px" }}
          >
            <Text style={{ fontSize: 12, color: "var(--ant-color-text-secondary)", display: "block", marginBottom: 8 }}>完成率</Text>
            <Progress
              percent={completedRate}
              size="small"
              status={completedRate === 100 ? "success" : "active"}
              strokeColor={{
                '0%': '#667eea',
                '100%': '#764ba2',
              }}
            />
          </Card>
        </Col>
      </Row>

      <Row gutter={[16, 16]}>
        {/* 任务状态分布 */}
        <Col span={12}>
          <Card 
            title={
              <span style={{ 
                fontWeight: 600,
                background: brandGradient,
                WebkitBackgroundClip: "text",
                WebkitTextFillColor: "transparent",
                backgroundImage: brandGradient,
              }}>任务状态分布</span>
            }
            size="small"
            style={{ 
              borderRadius: 12,
              background: cardBgGradient,
            }}
          >
            {stats && (
              <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                {(["todo", "doing", "waiting", "review", "done"] as const).map((s) => {
                  const count = stats.tasks[s];
                  const total = stats.tasks.total || 1;
                  const labels: Record<string, string> = {
                    todo: "待处理",
                    doing: "进行中",
                    waiting: "等待中",
                    review: "待验收",
                    done: "已完成",
                  };
                  return (
                    <div key={s} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <Tag color={STATUS_COLORS[s]} style={{ minWidth: 56, textAlign: "center", margin: 0 }}>
                        {labels[s]}
                      </Tag>
                      <Progress
                        percent={Math.round((count / total) * 100)}
                        size="small"
                        style={{ flex: 1 }}
                        strokeColor={STATUS_COLORS[s]}
                        format={() => `${count}`}
                      />
                    </div>
                  );
                })}
              </div>
            )}
          </Card>
        </Col>

        {/* Agent 工作负载 */}
        <Col span={12}>
          <Card 
            title={
              <span style={{ 
                fontWeight: 600,
                background: brandGradient,
                WebkitBackgroundClip: "text",
                WebkitTextFillColor: "transparent",
                backgroundImage: brandGradient,
              }}>Agent 工作负载</span>
            }
            size="small"
            style={{ 
              borderRadius: 12,
              background: cardBgGradient,
            }}
          >
            {agentWorkload.length === 0 ? (
              <Text type="secondary">暂无 Agent 工作数据</Text>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {agentWorkload.map(({ agent, count }) => (
                  <div key={agent.id} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <Tag
                      color={agent.status === "working" ? "processing" : "default"}
                      style={{ minWidth: 80, textAlign: "center", margin: 0 }}
                    >
                      {agent.name}
                    </Tag>
                    <Progress
                      percent={Math.min(count * 25, 100)}
                      size="small"
                      style={{ flex: 1 }}
                      format={() => `${count} 任务`}
                    />
                  </div>
                ))}
              </div>
            )}
          </Card>
        </Col>
      </Row>

      {/* 近期活动 */}
      <Card 
        title={
          <span style={{ 
            fontWeight: 600,
            background: brandGradient,
            WebkitBackgroundClip: "text",
            WebkitTextFillColor: "transparent",
            backgroundImage: brandGradient,
          }}>近期活动</span>
        }
        size="small" 
        style={{ 
          marginTop: 16,
          borderRadius: 12,
          background: cardBgGradient,
        }}
      >
        <Timeline
          items={recentTasks.map((t) => ({
            color: STATUS_COLORS[t.status],
            children: (
              <div>
                <Text strong style={{ fontSize: 13 }}>{t.title}</Text>
                <div>
                  <Tag
                    color={STATUS_COLORS[t.status]}
                    style={{ fontSize: 10, margin: 0, marginRight: 8 }}
                  >
                    {t.status}
                  </Tag>
                  <Text type="secondary" style={{ fontSize: 11 }}>
                    {new Date(t.updated_at).toLocaleString("zh-CN")}
                  </Text>
                </div>
              </div>
            ),
          }))}
        />
        {recentTasks.length === 0 && <Text type="secondary">暂无活动记录</Text>}
      </Card>
    </div>
  );
}
