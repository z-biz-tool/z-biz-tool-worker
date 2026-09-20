import { Select, Input, Space, Button, Tooltip } from "antd";
import {
  SearchOutlined, SettingOutlined, AppstoreOutlined, UnorderedListOutlined,
  CalendarOutlined, BarChartOutlined, FileTextOutlined, TeamOutlined, DashboardOutlined,
} from "@ant-design/icons";
import { useViewStore } from "../stores/viewStore";
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
        borderBottom: `1px solid var(--ant-color-border-secondary)`,
        background: cardBgGradient,
        borderRadius: 16,
        marginBottom: 12,
        gap: 16,
      }}
    >
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
          {VIEW_OPTIONS.map((v) => (
            <Tooltip key={v.key} title={v.label}>
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
          prefix={<SearchOutlined style={{ color: "var(--ant-color-text-tertiary)" }} />}
          placeholder="搜索任务..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          style={{ 
            width: 180,
            borderRadius: 10,
            transition: "all 0.2s cubic-bezier(0.4, 0, 0.2, 1)",
          }}
          size="small"
          allowClear
          onFocus={(e) => {
            e.currentTarget.style.boxShadow = '0 2px 8px rgba(102,126,234,0.15)';
            e.currentTarget.style.border = '1px solid rgba(102,126,234,0.3)';
          }}
          onBlur={(e) => {
            e.currentTarget.style.boxShadow = 'none';
            e.currentTarget.style.border = '';
          }}
        />
        <Tooltip title="设置">
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
  );
}
