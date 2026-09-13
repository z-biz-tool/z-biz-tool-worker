use serde::{Deserialize, Serialize};

// ===== 项目 =====
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Project {
    pub id: String,
    pub name: String,
    pub description: String,
    #[serde(default)]
    pub icon: String,
    #[serde(default = "default_project_color")]
    pub color: String,
    pub created_at: String,
    pub updated_at: String,
}

fn default_project_color() -> String {
    "#1677ff".to_string()
}

// ===== Agent =====
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Agent {
    pub id: String,
    pub project_id: String,
    pub name: String,
    pub system_prompt: String,
    pub model: String,
    pub status: String, // idle | working | offline
    pub current_task_id: Option<String>,
    /// 来源: "local" = 本地 CLI(claude-code / hermes / opencode), "manual" = 手填
    pub source: String,
    /// 本地 CLI 类型, source=local 时必填
    pub cli_type: Option<String>,
    /// agent-proxy 注册的 id, source=local 时必填
    pub local_agent_id: Option<String>,
    /// 本地 CLI 版本(展示用)
    pub cli_version: Option<String>,
    /// 本地 CLI 可执行文件绝对路径(展示用)
    pub cli_path: Option<String>,
    pub created_at: String,
    pub last_used_at: String,
}

// ===== 任务 =====
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Task {
    pub id: String,
    pub project_id: String,
    pub parent_id: Option<String>,
    pub title: String,
    pub description: String,
    pub status: String, // todo | doing | waiting | review | done
    pub priority: i32,
    #[serde(default)]
    pub start_date: Option<String>,
    #[serde(default)]
    pub due_date: Option<String>,
    #[serde(default)]
    pub milestone: bool,
    pub assigned_agent_id: Option<String>,
    pub assigned_agent_name: Option<String>,
    pub children: Vec<String>,
    pub output: Option<String>,
    pub agent_output: Option<String>,
    pub waiting_for_input: Option<bool>,
    pub receipts: Option<serde_json::Value>,
    #[serde(default)]
    pub custom_fields: serde_json::Value,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub sort_order: i32,
    pub created_at: String,
    pub updated_at: String,
    pub completed_at: Option<String>,
}

// ===== 项目统计 =====
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TaskStats {
    pub total: i32,
    pub todo: i32,
    pub doing: i32,
    pub waiting: i32,
    pub review: i32,
    pub done: i32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentStats {
    pub total: i32,
    pub working: i32,
    pub idle: i32,
    pub offline: i32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProjectStats {
    pub tasks: TaskStats,
    pub agents: AgentStats,
}

// ===== Agent状态 =====
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentStatus {
    pub agent_id: String,
    pub status: String,
    pub running: bool,
    pub current_task_id: Option<String>,
    pub output: Option<String>,
}

// ===== 配置 =====
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppConfig {
    pub theme: String,
    pub api_endpoint: String,
    pub default_model: String,
    #[serde(default = "default_proxy_url")]
    pub agent_proxy_url: String,
    #[serde(default)]
    pub api_key: String,
    #[serde(default = "default_temperature")]
    pub temperature: f64,
    #[serde(default = "default_max_tokens")]
    pub max_tokens: i32,
    #[serde(default = "default_top_p")]
    pub top_p: f64,
    #[serde(default)]
    pub always_on_top: bool,
    #[serde(default = "default_true")]
    pub auto_launch: bool,
    #[serde(default = "default_true")]
    pub close_to_tray: bool,
    #[serde(default)]
    pub font_size: i32,
    #[serde(default)]
    pub sidebar_width: i32,
    #[serde(default)]
    pub compact_mode: bool,
}

fn default_proxy_url() -> String {
    "http://127.0.0.1:9099".to_string()
}
fn default_temperature() -> f64 { 0.7 }
fn default_max_tokens() -> i32 { 4096 }
fn default_top_p() -> f64 { 1.0 }
fn default_true() -> bool { true }

// ===== 本地 CLI 探测结果(来自 agent-proxy /v1/cli-agents) =====
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LocalAgentInfo {
    /// claude-code / hermes / opencode
    #[serde(rename = "type")]
    pub cli_type: String,
    pub command: String,
    pub path: Option<String>,
    pub available: bool,
    pub version: Option<String>,
    pub registered: bool,
    pub agent_id: Option<String>,
}

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            theme: "light".to_string(),
            api_endpoint: "http://localhost:11434".to_string(),
            default_model: "default".to_string(),
            agent_proxy_url: "http://127.0.0.1:9099".to_string(),
            api_key: String::new(),
            temperature: 0.7,
            max_tokens: 4096,
            top_p: 1.0,
            always_on_top: false,
            auto_launch: true,
            close_to_tray: true,
            font_size: 0,
            sidebar_width: 0,
            compact_mode: false,
        }
    }
}

// ===== 消息 =====
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TaskMessage {
    pub id: String,
    pub task_id: String,
    pub role: String, // user | agent
    pub content: String,
    pub created_at: String,
}

// ===== 标签 =====
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Tag {
    pub id: String,
    pub project_id: String,
    pub name: String,
    #[serde(default = "default_tag_color")]
    pub color: String,
}

fn default_tag_color() -> String {
    "#1677ff".to_string()
}

// ===== 任务依赖 =====
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TaskDependency {
    pub task_id: String,
    pub depends_on_id: String,
}

// ===== 任务附件 =====
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TaskAttachment {
    pub id: String,
    pub task_id: String,
    pub filename: String,
    pub filepath: String,
    #[serde(default)]
    pub filesize: i64,
    #[serde(default)]
    pub mime_type: String,
    pub created_at: String,
}

// ===== 工作流模板 =====
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkflowTemplate {
    pub id: String,
    pub project_id: String,
    pub name: String,
    #[serde(default)]
    pub description: String,
    pub statuses: Vec<String>,
    pub created_at: String,
}

// ===== 项目文档 =====
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProjectDocument {
    pub id: String,
    pub project_id: String,
    pub title: String,
    pub content: String,
    #[serde(default)]
    pub parent_id: Option<String>,
    #[serde(default)]
    pub sort_order: i32,
    pub created_at: String,
    pub updated_at: String,
}

// ===== 任务更新参数 =====
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UpdateTaskParams {
    pub title: Option<String>,
    pub description: Option<String>,
    pub status: Option<String>,
    pub priority: Option<i32>,
    pub start_date: Option<String>,
    pub due_date: Option<String>,
    pub milestone: Option<bool>,
    pub assigned_agent_id: Option<String>,
    pub tags: Option<Vec<String>>,
    pub sort_order: Option<i32>,
    pub custom_fields: Option<serde_json::Value>,
}
