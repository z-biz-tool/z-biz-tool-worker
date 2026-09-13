import { Select, Input, Space, Button, Tooltip } from "antd";
import {
  SearchOutlined, SettingOutlined, AppstoreOutlined, UnorderedListOutlined,
  CalendarOutlined, BarChartOutlined, FileTextOutlined, TeamOutlined, DashboardOutlined,
} from "@ant-design/icons";
import { useViewStore } from "../stores/viewStore";
import type { ViewType } from "../types";

const VIEW_OPTIONS: { key: ViewType; label: string; icon: React.ReactNode }[] = [
  { key: "dashboard", label: "概览", icon: <DashboardOutlined /> },
  { key: "kanban", label: "看板", icon: <AppstoreOutlined /> },
  { key: "list", label: "列表", icon: <UnorderedListOutlined /> },
  { key: "calendar", label: "日历", icon: <CalendarOutlined /> },
  { key: "gantt", label: "甘特图", icon: <BarChartOutlined /> },
  { key: "documents", label: "文档", icon: <FileTextOutlined /> },
  { key: "agents", label: "Agent", icon: <TeamOutlined /> },
];

interface TopBarProps {
  projectName: string;
}

export default function TopBar({ projectName }: TopBarProps) {
  const { currentView, setView, searchQuery, setSearchQuery } = useViewStore();

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        padding: "8px 16px",
        borderBottom: "1px solid #f0f0f0",
        background: "#fff",
        gap: 16,
      }}
    >
      <div style={{ fontWeight: 600, fontSize: 15, whiteSpace: "nowrap" }}>
        {projectName}
      </div>

      <div style={{ flex: 1, display: "flex", justifyContent: "center" }}>
        <Space size={4}>
          {VIEW_OPTIONS.map((v) => (
            <Tooltip key={v.key} title={v.label}>
              <Button
                type={currentView === v.key ? "primary" : "text"}
                size="small"
                icon={v.icon}
                onClick={() => setView(v.key)}
                style={{ borderRadius: 6 }}
              >
                {v.label}
              </Button>
            </Tooltip>
          ))}
        </Space>
      </div>

      <Space size={8}>
        <Input
          prefix={<SearchOutlined />}
          placeholder="搜索任务..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          style={{ width: 180 }}
          size="small"
          allowClear
        />
        <Tooltip title="设置">
          <Button
            type="text"
            size="small"
            icon={<SettingOutlined />}
            onClick={() => setView("settings")}
          />
        </Tooltip>
      </Space>
    </div>
  );
}
