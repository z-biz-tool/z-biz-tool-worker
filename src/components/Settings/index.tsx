import { useState, useEffect } from "react";
import { Typography, Switch, Select, InputNumber, Input, Divider, Button, Space, message, Tabs } from "antd";
import { ArrowLeftOutlined, TagsOutlined, SettingOutlined } from "@ant-design/icons";
import { invoke } from "@tauri-apps/api/core";
import type { AppConfig } from "../../types";
import WorkflowEditor from "../WorkflowEditor";
import TagManager from "../TagManager";

const { Text } = Typography;

const DEFAULT_CONFIG: AppConfig = {
  theme: "light",
  default_model: "default",
  api_url: "http://localhost:11434",
  agent_proxy_url: "http://127.0.0.1:9099",
  api_key: "",
  temperature: 0.7,
  max_tokens: 4096,
  top_p: 1.0,
  always_on_top: false,
  auto_launch: true,
  close_to_tray: true,
  font_size: 0,
  sidebar_width: 0,
  compact_mode: false,
};

interface SettingsProps {
  onBack: () => void;
}

export default function Settings({ onBack }: SettingsProps) {
  const [config, setConfig] = useState<AppConfig>(DEFAULT_CONFIG);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    invoke<AppConfig>("get_config")
      .then((c) => {
        setConfig({ ...DEFAULT_CONFIG, ...c });
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  const save = async (newConfig: AppConfig) => {
    setConfig(newConfig);
    try {
      await invoke("save_config", { config: newConfig });
      message.success("已保存");
    } catch {
      message.error("保存失败");
    }
  };

  const update = <K extends keyof AppConfig>(key: K, value: AppConfig[K]) => {
    save({ ...config, [key]: value });
  };

  return (
    <div style={{ height: "100vh", display: "flex", flexDirection: "column", background: "#fff" }}>
      {/* 顶栏 */}
      <div style={{ display: "flex", alignItems: "center", padding: "10px 14px", borderBottom: "1px solid #f0f0f0" }}>
        <Button size="small" type="text" icon={<ArrowLeftOutlined />} onClick={onBack} style={{ width: 28, height: 28, borderRadius: 8 }} />
        <Text strong style={{ fontSize: 14, fontWeight: 600, marginLeft: 8 }}>设置</Text>
      </div>

      <div style={{ flex: 1, overflow: "auto", padding: "20px 32px" }}>
        <Tabs
          defaultActiveKey="ai"
          items={[
            {
              key: "ai",
              label: "AI 模型",
              children: (
                <div style={{ maxWidth: 600 }}>
                  <Section title="AI 配置">
                    <Row label="Agent Proxy URL">
                      <Input
                        value={config.agent_proxy_url}
                        onChange={(e) => update("agent_proxy_url", e.target.value)}
                        style={{ width: 300 }}
                        placeholder="http://127.0.0.1:9099"
                      />
                    </Row>
                    <Row label="默认模型">
                      <Select
                        value={config.default_model}
                        onChange={(v) => update("default_model", v)}
                        style={{ width: 200 }}
                        options={[
                          { value: "default", label: "默认" },
                          { value: "claude-code", label: "Claude Code" },
                          { value: "hermes", label: "Hermes" },
                          { value: "opencode", label: "OpenCode" },
                        ]}
                      />
                    </Row>
                    <Row label="API Key">
                      <Input.Password
                        value={config.api_key}
                        onChange={(e) => update("api_key", e.target.value)}
                        style={{ width: 300 }}
                        placeholder="可选，部分模型需要"
                      />
                    </Row>
                    <Row label="Temperature">
                      <InputNumber
                        value={config.temperature}
                        onChange={(v) => update("temperature", v || 0.7)}
                        min={0}
                        max={2}
                        step={0.1}
                        style={{ width: 120 }}
                      />
                    </Row>
                    <Row label="Max Tokens">
                      <InputNumber
                        value={config.max_tokens}
                        onChange={(v) => update("max_tokens", v || 4096)}
                        min={256}
                        max={128000}
                        step={256}
                        style={{ width: 120 }}
                      />
                    </Row>
                    <Row label="Top P">
                      <InputNumber
                        value={config.top_p}
                        onChange={(v) => update("top_p", v || 1.0)}
                        min={0}
                        max={1}
                        step={0.1}
                        style={{ width: 120 }}
                      />
                    </Row>
                  </Section>
                </div>
              ),
            },
            {
              key: "appearance",
              label: "外观",
              children: (
                <div style={{ maxWidth: 600 }}>
                  <Section title="外观设置">
                    <Row label="主题">
                      <Select
                        value={config.theme}
                        onChange={(v) => update("theme", v)}
                        style={{ width: 160 }}
                        options={[
                          { value: "light", label: "浅色" },
                          { value: "dark", label: "深色" },
                        ]}
                      />
                    </Row>
                    <Row label="紧凑模式">
                      <Switch checked={config.compact_mode} onChange={(v) => update("compact_mode", v)} />
                    </Row>
                  </Section>
                </div>
              ),
            },
            {
              key: "behavior",
              label: "行为",
              children: (
                <div style={{ maxWidth: 600 }}>
                  <Section title="窗口行为">
                    <Row label="窗口置顶">
                      <Switch checked={config.always_on_top} onChange={(v) => update("always_on_top", v)} />
                    </Row>
                    <Row label="开机自启">
                      <Switch checked={config.auto_launch} onChange={(v) => update("auto_launch", v)} />
                    </Row>
                    <Row label="关闭到托盘">
                      <Switch checked={config.close_to_tray} onChange={(v) => update("close_to_tray", v)} />
                    </Row>
                  </Section>
                </div>
              ),
            },
            {
              key: "data",
              label: "数据",
              children: (
                <div style={{ maxWidth: 600 }}>
                  <Section title="数据管理">
                    <Row label="数据目录">
                      <Text code style={{ fontSize: 12 }}>~/.z-biz-tool-worker/</Text>
                    </Row>
                    <Row label="数据格式">
                      <Text type="secondary">SQLite (data.db)</Text>
                    </Row>
                  </Section>
                </div>
              ),
            },
            {
              key: "workflow",
              label: <Space><SettingOutlined />工作流</Space>,
              children: (
                <div style={{ maxWidth: 800 }}>
                  <WorkflowEditor />
                </div>
              ),
            },
            {
              key: "tags",
              label: <Space><TagsOutlined />标签</Space>,
              children: (
                <div style={{ maxWidth: 600 }}>
                  {config && <TagManager projectId="" />}
                </div>
              ),
            },
          ]}
        />
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 8 }}>
      <Text strong style={{ fontSize: 14, color: "#666", marginBottom: 12, display: "block" }}>{title}</Text>
      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>{children}</div>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 16, minHeight: 32 }}>
      <div style={{ width: 140, flexShrink: 0, color: "#333" }}>{label}</div>
      <div style={{ display: "flex", alignItems: "center", gap: 12, flex: 1, flexWrap: "wrap" }}>{children}</div>
    </div>
  );
}
