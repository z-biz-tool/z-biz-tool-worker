import { Select, Input, Space, Button, Tooltip } from "antd";
import type { InputRef } from "antd";
import type { RefObject } from "react";
import {
  SearchOutlined, SettingOutlined, AppstoreOutlined, UnorderedListOutlined,
  CalendarOutlined, BarChartOutlined, FileTextOutlined, TeamOutlined, DashboardOutlined,
  ReloadOutlined, ClearOutlined,
} from "@ant-design/icons";
import { useViewStore } from "../stores/viewStore";
import { useWorkerStore } from "../stores/workerStore";
import { collectTagOptions, hasActiveFilter } from "../utils/taskFilters";
import type { ViewType } from "../types";

// 渐变色主题常量
const brandGradient = "linear-gradient(135deg, #667eea 0%, #764ba2 100%)";
const cardBgGradient = "linear-gradient(135deg, rgba(102,126,234,0.04) 0%, rgba(118,75,162,0.04) 100%)";

const VIEW_OPTIONS: { key: ViewType; label: string; icon: React.ReactNode }[] = [
  { key: "dashboard", label: "概览", icon: <DashboardOutlined /> },
  { key: "kanban", label: "看板", icon: <AppstoreOutlined /> },
  { key: "list", label: "列表", icon: <UnorderedListOutlined /> },
  { key: "calendar", label: "日历", icon: <CalendarOutlined /> },
  { key: "gantt", label: "甘特图", icon: <BarChartOutlined /> },
  { key: "documents", label: "文档", icon: <FileTextOutlined /> },
  { key: "agents", label: "Agent", icon: <TeamOutlined /> },
];

const PRIORITY_OPTIONS = [
  { value: 3, label: "高" },
  { value: 2, label: "中" },
  { value: 1, label: "低" },
  { value: 0, label: "无" },
];

interface TopBarProps {
  projectName: string;
  searchInputRef: RefObject<InputRef | null>;
  filteredCount: number;
  totalCount: number;
}

export default function TopBar({ projectName, searchInputRef, filteredCount, totalCount }: TopBarProps) {
  const {
    currentView, setView, searchQuery, setSearchQuery,
    filterPriority, setFilterPriority, filterAgent, setFilterAgent,
    filterTags, setFilterTags, clearFilters,
  } = useViewStore();
  const agents = useWorkerStore((s) => s.agents);
  const tasks = useWorkerStore((s) => s.tasks);
  const loading = useWorkerStore((s) => s.loading);
  const currentProjectId = useWorkerStore((s) => s.currentProjectId);
  const selectProject = useWorkerStore((s) => s.selectProject);
  const loadProjects = useWorkerStore((s) => s.loadProjects);

  const filtered = hasActiveFilter({
    query: searchQuery,
    priority: filterPriority,
    agentId: filterAgent,
    tags: filterTags,
  });
  const tagOptions = collectTagOptions(tasks);

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 8,
        padding: "8px 16px",
        borderBottom: `1px solid var(--ant-color-border-secondary)`,
        background: cardBgGradient,
        borderRadius: 16,
        marginBottom: 12,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
        <div
          style={{
            fontWeight: 600,
            fontSize: 15,
            whiteSpace: "nowrap",
            background: brandGradient,
            WebkitBackgroundClip: "text",
            WebkitTextFillColor: "transparent",
            backgroundImage: brandGradient,
          }}
        >
          {projectName}
        </div>

        <div style={{ flex: 1, display: "flex", justifyContent: "center" }}>
          <Space size={4}>
            {VIEW_OPTIONS.map((v, i) => (
              <Tooltip key={v.key} title={`${v.label} (⌘${i + 1})`}>
                <Button
                  type={currentView === v.key ? "primary" : "text"}
                  size="small"
                  icon={v.icon}
                  onClick={() => setView(v.key)}
                  style={{
                    borderRadius: 8,
                    background: currentView === v.key ? brandGradient : 'transparent',
                    boxShadow: currentView === v.key ? "0 4px 12px rgba(102,126,234,0.3)" : "none",
                  }}
                >
                  {v.label}
                </Button>
              </Tooltip>
            ))}
          </Space>
        </div>

        <Space size={8}>
          <Input
            ref={searchInputRef}
            prefix={<SearchOutlined style={{ color: "var(--ant-color-text-tertiary)" }} />}
            placeholder="搜索任务... (⌘F)"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            style={{
              width: 180,
              borderRadius: 10,
              transition: "all 0.2s cubic-bezier(0.4, 0, 0.2, 1)",
            }}
            size="small"
            allowClear
          />
          <Tooltip title="刷新 (重新拉取当前项目)">
            <Button
              type="text"
              size="small"
              icon={<ReloadOutlined />}
              loading={loading}
              onClick={() => {
                if (currentProjectId) void selectProject(currentProjectId);
                void loadProjects();
              }}
              style={{ borderRadius: 8 }}
            />
          </Tooltip>
          <Tooltip title="设置 (⌘8)">
            <Button
              type="text"
              size="small"
              icon={<SettingOutlined />}
              onClick={() => setView("settings")}
              style={{ borderRadius: 8 }}
            />
          </Tooltip>
        </Space>
      </div>

      {/* 筛选行：这些条件真的作用在各视图的任务上（见 App 的 filteredTasks） */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <Select
          size="small"
          style={{ width: 108 }}
          placeholder="优先级"
          allowClear
          value={filterPriority ?? undefined}
          onChange={(v) => setFilterPriority(typeof v === "number" ? v : null)}
          options={PRIORITY_OPTIONS}
        />
        <Select
          size="small"
          style={{ width: 140 }}
          placeholder="负责 Agent"
          allowClear
          value={filterAgent ?? undefined}
          onChange={(v) => setFilterAgent(typeof v === "string" ? v : null)}
          options={agents.map((a) => ({ value: a.id, label: a.name }))}
        />
        <Select
          size="small"
          mode="multiple"
          style={{ minWidth: 140, maxWidth: 280 }}
          placeholder="标签"
          allowClear
          maxTagCount="responsive"
          value={filterTags}
          onChange={(v) => setFilterTags(v)}
          options={tagOptions.map((t) => ({ value: t, label: t }))}
        />
        {filtered && (
          <>
            <Button size="small" type="text" icon={<ClearOutlined />} onClick={clearFilters}>
              清除筛选
            </Button>
            <span style={{ fontSize: 12, color: "#999" }}>
              {filteredCount} / {totalCount} 个任务
            </span>
          </>
        )}
      </div>
    </div>
  );
}
