import { useState, useEffect, useRef } from "react";
import { Typography, Switch, Select, InputNumber, Input, Divider, Button, Space, message, Tabs, Alert, Spin } from "antd";
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
  projectId?: string | null;
}

type SaveState = "idle" | "saving" | "saved" | "error";

export default function Settings({ onBack, projectId }: SettingsProps) {
  const [config, setConfig] = useState<AppConfig>(DEFAULT_CONFIG);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [saveError, setSaveError] = useState<string | null>(null);
  const saveChain = useRef<Promise<void>>(Promise.resolve());

  const load = () => {
    setLoading(true);
    setLoadError(null);
    invoke<AppConfig>("get_config")
      .then((c) => setConfig({ ...DEFAULT_CONFIG, ...c }))
      .catch((e: any) => setLoadError(`读取设置失败：${e?.toString?.() || e}`))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    load();
  }, []);

  const save = (newConfig: AppConfig) => {
    setConfig(newConfig);
    setSaveState("saving");
    setSaveError(null);
    // 串行化：旧实现每次按键都并发 invoke，响应乱序时后到的旧配置会覆盖新配置。
    saveChain.current = saveChain.current.then(async () => {
      try {
        await invoke("save_config", { config: newConfig });
        setSaveState("saved");
      } catch (e: any) {
        setSaveState("error");
        setSaveError(e?.toString?.() || String(e));
        message.error(`保存失败：${e?.toString?.() || e}`);
      }
    });
  };

  const update = <K extends keyof AppConfig>(key: K, value: AppConfig[K]) => {
    save({ ...config, [key]: value });
  };

  return (
    <div style={{ height: "100vh", display: "flex", flexDirection: "column", background: "#fff" }}>
      {/* 顶栏 */}
      <div style={{ display: "flex", alignItems: "center", padding: "10px 14px", borderBottom: "1px solid #f0f0f0" }}>
        <Button
          size="small"
          type="text"
          icon={<ArrowLeftOutlined />}
          aria-label="返回任务看板"
          onClick={onBack}
          style={{ width: 28, height: 28, borderRadius: 8 }}
        />
        <Text strong style={{ fontSize: 14, fontWeight: 600, marginLeft: 8 }}>设置</Text>
        <div style={{ marginLeft: 12 }}>
          {saveState === "saving" && <Text type="secondary" style={{ fontSize: 12 }}>保存中…</Text>}
          {saveState === "saved" && <Text type="success" style={{ fontSize: 12 }}>已保存</Text>}
          {saveState === "error" && (
            <Text type="danger" style={{ fontSize: 12 }} title={saveError ?? undefined}>
              保存失败：{saveError}
            </Text>
          )}
        </div>
      </div>

      <div style={{ flex: 1, overflow: "auto", padding: "20px 32px" }}>
        {loading && (
          <div style={{ textAlign: "center", padding: 40 }}>
            <Spin tip="读取设置中" />
          </div>
        )}
        {loadError && (
          <Alert
            type="error"
            showIcon
            style={{ marginBottom: 16 }}
            message="设置读取失败，下方为默认值"
            description={loadError}
            action={
              <Button size="small" onClick={load}>
                重试
              </Button>
            }
          />
        )}
        <Tabs
          defaultActiveKey="ai"
          items={[
            {
              key: "ai",
              label: "AI 模型",
              children: (
                <div style={{ maxWidth: 600 }}>
                  <Alert
                    type="info"
                    showIcon
                    style={{ marginBottom: 16 }}
                    message="只有 Agent Proxy URL 会影响运行"
                    description="默认模型、API Key 与采样参数当前只写入配置文件，尚未接入对话请求，因此已禁用，避免造成「改了会生效」的错觉。"
                  />
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
                        disabled
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
                        disabled
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
                        disabled
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
                        disabled
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
                        disabled
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
                  <Alert
                    type="info"
                    showIcon
                    style={{ marginBottom: 16 }}
                    message="外观项尚未接入"
                    description="主题与紧凑模式当前只保存配置，不会改变界面，因此已禁用。"
                  />
                  <Section title="外观设置">
                    <Row label="主题">
                      <Select
                        value={config.theme}
                        onChange={(v) => update("theme", v)}
                        style={{ width: 160 }}
                        disabled
                        options={[
                          { value: "light", label: "浅色" },
                          { value: "dark", label: "深色" },
                        ]}
                      />
                    </Row>
                    <Row label="紧凑模式">
                      <Switch checked={config.compact_mode} onChange={(v) => update("compact_mode", v)} disabled />
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
                  <Alert
                    type="info"
                    showIcon
                    style={{ marginBottom: 16 }}
                    message="窗口行为尚未接入"
                    description="置顶、开机自启、关闭到托盘当前不会生效，因此已禁用。"
                  />
                  <Section title="窗口行为">
                    <Row label="窗口置顶">
                      <Switch checked={config.always_on_top} onChange={(v) => update("always_on_top", v)} disabled />
                    </Row>
                    <Row label="开机自启">
                      <Switch checked={config.auto_launch} onChange={(v) => update("auto_launch", v)} disabled />
                    </Row>
                    <Row label="关闭到托盘">
                      <Switch checked={config.close_to_tray} onChange={(v) => update("close_to_tray", v)} disabled />
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
                    <Row label="提示词存储">
                      <Text type="warning">明文（未加密）</Text>
                      <Text type="secondary" style={{ fontSize: 12 }}>
                        Agent 的系统提示词直接存在 SQLite 中；防护依赖本机文件权限（目录 0700 / 文件 0600）。
                      </Text>
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
                  {config && <TagManager projectId={projectId || ""} />}
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
