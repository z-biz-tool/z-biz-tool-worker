import { useMemo } from "react";
import { Card, Row, Col, Typography, Progress, Tag, Timeline, Statistic, Alert, Button } from "antd";
import {
  PlayCircleOutlined, TeamOutlined, ProjectOutlined,
} from "@ant-design/icons";
import type { Task, Agent, ProjectStats } from "../../types";
import { useWorkerStore } from "../../stores/workerStore";
import {
  agentWorkload as buildAgentWorkload,
  completedRate as calcCompletedRate,
  recentTasks as pickRecentTasks,
  statusDistribution,
} from "../../utils/dashboardLayout";

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
  const currentProjectId = useWorkerStore((s) => s.currentProjectId);
  const selectProject = useWorkerStore((s) => s.selectProject);

  const recentTasks = useMemo(() => pickRecentTasks(tasks, 8), [tasks]);

  // stats 为 null 时返回 null，界面显示「—」；不能把加载失败画成 0%/0 个任务
  const completedRate = calcCompletedRate(stats);
  const agentWorkload = useMemo(() => buildAgentWorkload(tasks, agents), [tasks, agents]);
  const distribution = useMemo(() => statusDistribution(stats), [stats]);
  const statusLabels: Record<string, string> = {
    todo: "待处理",
    doing: "进行中",
    waiting: "等待中",
    review: "待验收",
    done: "已完成",
  };

  return (
    <div style={{ padding: "0 4px" }}>
      {!stats && (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 16 }}
          message="统计数据暂不可用"
          description="没有读到项目统计，下方数字以「—」显示。任务列表本身不受影响。"
          action={
            <Button
              size="small"
              onClick={() => currentProjectId && void selectProject(currentProjectId)}
            >
              重试
            </Button>
          }
        />
      )}
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
              value={stats ? stats.tasks.total : "—"}
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
              value={stats ? stats.tasks.doing : "—"}
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
              value={stats ? stats.agents.total : "—"}
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
            {completedRate === null ? (
              <Text type="secondary" style={{ fontSize: 20 }}>—</Text>
            ) : (
              <Progress
                percent={completedRate}
                size="small"
                status={completedRate === 100 ? "success" : "active"}
                strokeColor={{
                  '0%': '#667eea',
                  '100%': '#764ba2',
                }}
              />
            )}
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
            {stats ? (
              <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                {distribution.map(({ status, count, percent }) => (
                  <div key={status} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <Tag color={STATUS_COLORS[status]} style={{ minWidth: 56, textAlign: "center", margin: 0 }}>
                      {statusLabels[status]}
                    </Tag>
                    <Progress
                      percent={percent}
                      size="small"
                      style={{ flex: 1 }}
                      strokeColor={STATUS_COLORS[status]}
                      format={() => `${count}`}
                    />
                  </div>
                ))}
              </div>
            ) : (
              <Text type="secondary">统计暂不可用</Text>
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
