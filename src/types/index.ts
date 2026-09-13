export interface Project {
  id: string;
  name: string;
  description: string;
  icon: string;
  color: string;
  created_at: string;
  updated_at: string;
}

export interface Agent {
  id: string;
  project_id: string;
  name: string;
  system_prompt: string;
  model: string;
  status: "idle" | "working" | "offline";
  current_task_id: string | null;
  /** "local" = 来自本地 CLI(claude-code / hermes / opencode), "manual" = 手填 */
  source: "local" | "manual";
  cli_type: string | null;
  local_agent_id: string | null;
  cli_version: string | null;
  cli_path: string | null;
  created_at: string;
  last_used_at: string;
}

export interface LocalAgentInfo {
  type: "claude-code" | "hermes" | "opencode" | string;
  command: string;
  path: string | null;
  available: boolean;
  version: string | null;
  registered: boolean;
  agent_id: string | null;
}

export interface Task {
  id: string;
  project_id: string;
  parent_id: string | null;
  title: string;
  description: string;
  status: "todo" | "doing" | "waiting" | "review" | "done";
  priority: number;
  start_date: string | null;
  due_date: string | null;
  milestone: boolean;
  assigned_agent_id: string | null;
  assigned_agent_name?: string | null;
  children: string[];
  /** agent 执行后的最终输出 */
  output: string | null;
  /** 同 output */
  agent_output?: string | null;
  /** 等待用户输入标记 */
  waiting_for_input?: boolean | null;
  /** Agent 附件 receipts */
  receipts?: unknown;
  custom_fields: Record<string, unknown>;
  tags: string[];
  sort_order: number;
  created_at: string;
  updated_at: string;
  completed_at?: string | null;
}

export interface TaskMessage {
  id: string;
  task_id: string;
  role: "user" | "agent";
  content: string;
  created_at: string;
}

export interface ProjectStats {
  tasks: { total: number; todo: number; doing: number; waiting: number; review: number; done: number };
  agents: { total: number; working: number; idle: number; offline: number };
}

export interface AppConfig {
  theme: string;
  default_model: string;
  api_url: string;
  agent_proxy_url: string;
  api_key: string;
  temperature: number;
  max_tokens: number;
  top_p: number;
  always_on_top: boolean;
  auto_launch: boolean;
  close_to_tray: boolean;
  font_size: number;
  sidebar_width: number;
  compact_mode: boolean;
}

export interface Tag {
  id: string;
  project_id: string;
  name: string;
  color: string;
}

export interface TaskDependency {
  task_id: string;
  depends_on_id: string;
}

export interface TaskAttachment {
  id: string;
  task_id: string;
  filename: string;
  filepath: string;
  filesize: number;
  mime_type: string;
  created_at: string;
}

export interface WorkflowTemplate {
  id: string;
  project_id: string;
  name: string;
  description: string;
  statuses: string[];
  created_at: string;
}

export interface ProjectDocument {
  id: string;
  project_id: string;
  title: string;
  content: string;
  parent_id: string | null;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

export interface UpdateTaskParams {
  title?: string;
  description?: string;
  status?: string;
  priority?: number;
  start_date?: string;
  due_date?: string;
  milestone?: boolean;
  assigned_agent_id?: string;
  tags?: string[];
  sort_order?: number;
  custom_fields?: Record<string, unknown>;
}

export type ViewType = "dashboard" | "kanban" | "list" | "calendar" | "gantt" | "documents" | "agents" | "settings";
