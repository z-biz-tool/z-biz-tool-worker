use crate::agent_runner;
use crate::models::*;
use crate::storage;
use chrono::Utc;

const DEFAULT_AGENT_PROXY_URL: &str = "http://127.0.0.1:9099";

fn get_proxy_url() -> String {
    let config = storage::read_config();
    if config.agent_proxy_url.is_empty() {
        DEFAULT_AGENT_PROXY_URL.to_string()
    } else {
        config.agent_proxy_url
    }
}

// ===== 项目命令 =====

#[tauri::command]
pub fn list_projects() -> Vec<Project> {
    storage::read_projects()
}

#[tauri::command]
pub fn create_project(name: String, desc: String) -> Project {
    let now = Utc::now().to_rfc3339();
    let project = Project {
        id: uuid::Uuid::new_v4().to_string(),
        name,
        description: desc,
        icon: String::new(),
        color: "#1677ff".to_string(),
        created_at: now.clone(),
        updated_at: now,
    };
    storage::save_project(&project);
    project
}

#[tauri::command]
pub fn delete_project(id: String) -> Result<(), String> {
    storage::remove_project(&id);
    Ok(())
}

#[tauri::command]
pub fn get_project_stats(id: String) -> Result<ProjectStats, String> {
    let tasks = storage::read_tasks_by_project(&id);
    let agents = storage::read_agents_by_project(&id);

    let task_stats = TaskStats {
        total: tasks.len() as i32,
        todo: tasks.iter().filter(|t| t.status == "todo").count() as i32,
        doing: tasks.iter().filter(|t| t.status == "doing").count() as i32,
        waiting: tasks.iter().filter(|t| t.status == "waiting").count() as i32,
        review: tasks.iter().filter(|t| t.status == "review").count() as i32,
        done: tasks.iter().filter(|t| t.status == "done").count() as i32,
    };

    let agent_stats = AgentStats {
        total: agents.len() as i32,
        working: agents.iter().filter(|a| a.status == "working").count() as i32,
        idle: agents.iter().filter(|a| a.status == "idle").count() as i32,
        offline: agents.iter().filter(|a| a.status == "offline").count() as i32,
    };

    Ok(ProjectStats {
        tasks: task_stats,
        agents: agent_stats,
    })
}

// ===== Agent命令 =====

#[tauri::command]
pub fn list_agents(project_id: String) -> Vec<Agent> {
    storage::read_agents_by_project(&project_id)
}

/// 探测本机可用的 CLI agent(claude-code / hermes / opencode)。
/// 转发到本地 agent-proxy 的 GET /v1/cli-agents,带 1.5s 超时。
/// agent-proxy 没起时不报错,返回空列表。
#[tauri::command]
pub fn discover_local_agents() -> Vec<LocalAgentInfo> {
    let url = format!("{}/v1/cli-agents", get_proxy_url());
    let agent = ureq::AgentBuilder::new()
        .timeout_read(std::time::Duration::from_millis(1500))
        .timeout_connect(std::time::Duration::from_millis(500))
        .build();
    match agent.get(&url).call() {
        Ok(resp) => {
            let reader = resp.into_reader();
            match serde_json::from_reader::<_, serde_json::Value>(reader) {
                Ok(v) => {
                    let arr = v.get("cli_agents").and_then(|x| x.as_array()).cloned().unwrap_or_default();
                    arr.into_iter()
                        .filter_map(|item| serde_json::from_value::<LocalAgentInfo>(item).ok())
                        .collect()
                }
                Err(e) => {
                    eprintln!("[discover_local_agents] parse error: {}", e);
                    Vec::new()
                }
            }
        }
        Err(e) => {
            // agent-proxy 未启动 / 网络不通 — 不阻塞 UI
            eprintln!("[discover_local_agents] proxy unreachable: {}", e);
            Vec::new()
        }
    }
}

/// 高级模式:手填 Agent(不走本地 CLI)。
#[tauri::command]
pub fn create_agent(project_id: String, name: String, prompt: String, model: String) -> Agent {
    let now = Utc::now().to_rfc3339();
    let agent = Agent {
        id: uuid::Uuid::new_v4().to_string(),
        project_id,
        name,
        system_prompt: if prompt.is_empty() { "你是一个有用的AI助手。".to_string() } else { prompt },
        model: if model.is_empty() { "default".to_string() } else { model },
        status: "idle".to_string(),
        current_task_id: None,
        source: "manual".to_string(),
        cli_type: None,
        local_agent_id: None,
        cli_version: None,
        cli_path: None,
        created_at: now.clone(),
        last_used_at: now,
    };
    storage::save_agent(&agent);
    agent
}

/// 主入口:从本地 CLI 引入 Agent 到项目。
/// 同一个项目下,同一个 cli_type 只允许挂一个(避免重复占位)。
/// 已存在则返回 Err,不静默覆盖。
#[tauri::command]
pub fn import_local_agent(
    project_id: String,
    cli_type: String,
    command: String,
    cli_path: Option<String>,
    cli_version: Option<String>,
    local_agent_id: Option<String>,
) -> Result<Agent, String> {
    // 查重:同 project + 同 cli_type 已存在则拒绝
    let existing: Vec<Agent> = storage::read_agents_by_project(&project_id)
        .into_iter()
        .filter(|a| a.cli_type.as_deref() == Some(&cli_type))
        .collect();
    if !existing.is_empty() {
        return Err(format!("本项目已挂载 {} 类型的 Agent", cli_type));
    }

    let display_name = match cli_type.as_str() {
        "claude-code" => "Claude Code",
        "hermes" => "Hermes",
        "opencode" => "OpenCode",
        other => other,
    };
    let now = Utc::now().to_rfc3339();
    let agent = Agent {
        id: uuid::Uuid::new_v4().to_string(),
        project_id,
        name: display_name.to_string(),
        system_prompt: format!("通过本地 {} CLI 引入的 Agent。", display_name),
        model: "default".to_string(),
        status: "idle".to_string(),
        current_task_id: None,
        source: "local".to_string(),
        cli_type: Some(cli_type),
        local_agent_id,
        cli_version,
        cli_path: cli_path.or(Some(command)),
        created_at: now.clone(),
        last_used_at: now,
    };
    storage::save_agent(&agent);
    Ok(agent)
}

#[tauri::command]
pub fn delete_agent(id: String) -> Result<(), String> {
    storage::remove_agent(&id);
    Ok(())
}

#[tauri::command]
pub fn clone_agent(project_id: String, source_id: String, name: String) -> Result<Agent, String> {
    let source = storage::find_agent(&source_id).ok_or("源Agent不存在")?;
    let now = Utc::now().to_rfc3339();
    let agent = Agent {
        id: uuid::Uuid::new_v4().to_string(),
        project_id,
        name: if name.is_empty() { format!("{} (副本)", source.name) } else { name },
        system_prompt: source.system_prompt,
        model: source.model,
        status: "idle".to_string(),
        current_task_id: None,
        source: source.source.clone(),
        cli_type: source.cli_type.clone(),
        local_agent_id: source.local_agent_id.clone(),
        cli_version: source.cli_version.clone(),
        cli_path: source.cli_path.clone(),
        created_at: now.clone(),
        last_used_at: now,
    };
    storage::save_agent(&agent);
    Ok(agent)
}

// ===== 任务命令 =====

#[tauri::command]
pub fn list_tasks(project_id: String) -> Vec<Task> {
    storage::read_tasks_by_project(&project_id)
}

#[tauri::command]
pub fn create_task(project_id: String, title: String, desc: String, parent_id: Option<String>) -> Task {
    let now = Utc::now().to_rfc3339();
    let task = Task {
        id: uuid::Uuid::new_v4().to_string(),
        project_id,
        parent_id,
        title,
        description: desc,
        status: "todo".to_string(),
        priority: 0,
        start_date: None,
        due_date: None,
        milestone: false,
        assigned_agent_id: None,
        assigned_agent_name: None,
        children: Vec::new(),
        output: None,
        agent_output: None,
        waiting_for_input: None,
        receipts: None,
        custom_fields: serde_json::json!({}),
        tags: Vec::new(),
        sort_order: 0,
        created_at: now.clone(),
        updated_at: now,
        completed_at: None,
    };
    storage::save_task(&task);

    // 如果有父任务，更新父任务的children
    if let Some(pid) = &task.parent_id {
        if let Some(mut parent) = storage::find_task(pid) {
            parent.children.push(task.id.clone());
            storage::save_task(&parent);
        }
    }

    task
}

#[tauri::command]
pub fn delete_task(id: String) -> Result<(), String> {
    // 先从父任务中移除
    if let Some(task) = storage::find_task(&id) {
        if let Some(pid) = &task.parent_id {
            if let Some(mut parent) = storage::find_task(pid) {
                parent.children.retain(|c| c != &id);
                storage::save_task(&parent);
            }
        }
    }
    storage::remove_task(&id);
    Ok(())
}

#[tauri::command]
pub fn assign_task(task_id: String, agent_id: String) -> Result<Task, String> {
    let mut task = storage::find_task(&task_id).ok_or("任务不存在")?;
    let agent = storage::find_agent(&agent_id).ok_or("Agent不存在")?;

    task.assigned_agent_id = Some(agent_id.clone());
    task.assigned_agent_name = Some(agent.name.clone());
    task.status = "doing".to_string();
    task.updated_at = Utc::now().to_rfc3339();

    // 更新Agent状态
    let mut agent = agent;
    agent.status = "working".to_string();
    agent.current_task_id = Some(task_id.clone());
    agent.last_used_at = Utc::now().to_rfc3339();
    storage::save_agent(&agent);

    storage::save_task(&task);

    // 后台触发 agent-proxy 真实执行。task 已经持久化为 doing,
    // 即使后台失败,任务也不会卡死:失败时改 waiting + 写错误到 output。
    let task_id_bg = task.id.clone();
    let agent_id_bg = agent.id.clone();
    let cli_type_bg = agent.cli_type.clone();
    let prompt_bg = format!(
        "任务标题: {}\n任务描述: {}\n\n请直接给出结果,不要解释你的工具调用过程。",
        task.title, task.description
    );
    std::thread::spawn(move || {
        run_task_background(&task_id_bg, &agent_id_bg, cli_type_bg.as_deref(), &prompt_bg);
    });

    Ok(task)
}

/// 重试卡在 doing 的任务(网络抖 / agent-proxy 重启后状态丢失 / LLM 超时等场景)。
/// 把 task 改回 doing 后再后台跑一次。
#[tauri::command]
pub fn retry_task(task_id: String) -> Result<Task, String> {
    let mut task = storage::find_task(&task_id).ok_or("任务不存在")?;
    let agent_id = task
        .assigned_agent_id
        .clone()
        .ok_or("任务没有分配 Agent,无法重试")?;
    let agent = storage::find_agent(&agent_id).ok_or("Agent不存在")?;

    task.status = "doing".to_string();
    task.updated_at = Utc::now().to_rfc3339();
    storage::save_task(&task);

    let task_id_bg = task.id.clone();
    let agent_id_bg = agent.id.clone();
    let cli_type_bg = agent.cli_type.clone();
    let prompt_bg = format!(
        "任务标题: {}\n任务描述: {}\n\n请直接给出结果,不要解释你的工具调用过程。",
        task.title, task.description
    );
    std::thread::spawn(move || {
        run_task_background(&task_id_bg, &agent_id_bg, cli_type_bg.as_deref(), &prompt_bg);
    });
    Ok(task)
}

/// 后台执行核心:调本地 agent-proxy,成功 → review + output,失败 → waiting + 错误信息。
/// cli_type 为 None(手填 agent)时不调 LLM,直接停在 doing 等用户手动操作。
fn run_task_background(task_id: &str, agent_id: &str, cli_type: Option<&str>, prompt: &str) {
    let Some(cli_type) = cli_type else {
        eprintln!("[run_task_background] agent {} 非本地 CLI,跳过执行", agent_id);
        return;
    };
    match agent_runner::run_agent(cli_type, prompt) {
        Ok(output) => {
            if let Some(mut t) = storage::find_task(task_id) {
                t.output = Some(output.clone());
                t.agent_output = Some(output);
                t.status = "review".to_string();
                t.updated_at = Utc::now().to_rfc3339();
                storage::save_task(&t);
            }
            // 释放 Agent
            if let Some(mut a) = storage::find_agent(agent_id) {
                a.status = "idle".to_string();
                a.current_task_id = None;
                storage::save_agent(&a);
            }
        }
        Err(e) => {
            eprintln!("[run_task_background] task {} agent-proxy 执行失败: {}", task_id, e);
            if let Some(mut t) = storage::find_task(task_id) {
                t.status = "waiting".to_string();
                t.output = Some(format!("[执行失败,点「重试」再来一次]\n\n{}", e));
                t.updated_at = Utc::now().to_rfc3339();
                storage::save_task(&t);
            }
            if let Some(mut a) = storage::find_agent(agent_id) {
                a.status = "idle".to_string();
                a.current_task_id = None;
                storage::save_agent(&a);
            }
        }
    }
}

/// 任意状态流转。合法的状态: todo | doing | waiting | review | done
/// 切到 done 时同时设置 completed_at;doing 时如果原来有 assigned_agent,会保留分配。
#[tauri::command]
pub fn update_task_status(task_id: String, status: String) -> Result<Task, String> {
    let valid = ["todo", "doing", "waiting", "review", "done"];
    if !valid.contains(&status.as_str()) {
        return Err(format!("非法状态: {}", status));
    }
    let mut task = storage::find_task(&task_id).ok_or("任务不存在")?;
    let now = Utc::now().to_rfc3339();
    task.status = status.clone();
    task.updated_at = now.clone();
    if status == "done" {
        task.completed_at = Some(now);
        // 释放 Agent
        if let Some(agent_id) = &task.assigned_agent_id {
            if let Some(mut agent) = storage::find_agent(agent_id) {
                agent.status = "idle".to_string();
                agent.current_task_id = None;
                storage::save_agent(&agent);
            }
        }
    }
    storage::save_task(&task);
    Ok(task)
}

#[tauri::command]
pub fn review_task(task_id: String, approved: bool) -> Result<Task, String> {
    let mut task = storage::find_task(&task_id).ok_or("任务不存在")?;
    let now = Utc::now().to_rfc3339();

    if approved {
        task.status = "done".to_string();
        task.completed_at = Some(now.clone());
    } else {
        task.status = "todo".to_string();
    }
    task.updated_at = now;

    // Agent回归空闲
    if let Some(agent_id) = &task.assigned_agent_id {
        if let Some(mut agent) = storage::find_agent(agent_id) {
            agent.status = "idle".to_string();
            agent.current_task_id = None;
            storage::save_agent(&agent);
        }
    }

    storage::save_task(&task);
    Ok(task)
}

// ===== Agent状态 =====

#[tauri::command]
pub fn get_agent_status(agent_id: String) -> Result<AgentStatus, String> {
    let agent = storage::find_agent(&agent_id).ok_or("Agent不存在")?;
    Ok(AgentStatus {
        agent_id: agent.id.clone(),
        status: agent.status.clone(),
        running: agent.status == "working",
        current_task_id: agent.current_task_id.clone(),
        output: None, // TODO: 实际执行时填充
    })
}

// ===== 消息 =====

#[tauri::command]
pub async fn send_task_message(
    app: tauri::AppHandle,
    task_id: String,
    message: String,
) -> Result<TaskExchangeResult, String> {
    // 1. Store the user's message first so it's persisted even if the
    //    LLM call later fails.
    let now = chrono::Utc::now().to_rfc3339();
    let user_msg = TaskMessage {
        id: uuid::Uuid::new_v4().to_string(),
        task_id: task_id.clone(),
        role: "user".to_string(),
        content: message.clone(),
        created_at: now.clone(),
    };
    storage::save_task_message(&user_msg);

    // 2. Look up the task + assigned agent. If no agent is assigned we
    //    just return — the UI can prompt the user to assign one.
    let task = match storage::find_task(&task_id) {
        Some(t) => t,
        None => return Ok(TaskExchangeResult { user: user_msg, agent: None }),
    };
    let agent_id = match &task.assigned_agent_id {
        Some(a) => a.clone(),
        None => return Ok(TaskExchangeResult { user: user_msg, agent: None }),
    };
    let agent = match storage::find_agent(&agent_id) {
        Some(a) => a,
        None => {
            return Ok(TaskExchangeResult {
                user: user_msg,
                agent: None,
            })
        }
    };

    // 3. Build the message context: system prompt (agent), task
    //    description, prior messages, the new user message.
    let history = storage::read_task_messages(&task_id);
    let mut history_msgs: Vec<crate::agent_session::ChatMessage> = Vec::new();
    if let Some(first) = history.first() {
        // Anchor the conversation with the task description so the agent
        // has the brief in context.
        if !task.description.is_empty() {
            history_msgs.push(crate::agent_session::ChatMessage {
                role: "user".to_string(),
                content: format!("[Task: {}]\n{}", task.title, task.description),
            });
        }
        let _ = first; // silence unused
    }
    for m in &history {
        if m.role == "user" {
            history_msgs.push(crate::agent_session::ChatMessage {
                role: "user".to_string(),
                content: m.content.clone(),
            });
        } else if m.role == "agent" {
            history_msgs.push(crate::agent_session::ChatMessage {
                role: "assistant".to_string(),
                content: m.content.clone(),
            });
        }
    }
    // The just-stored user message is already in `history`; avoid double.
    history_msgs.pop();

    // 4. Call the proxy. The session id is stable per-agent so the
    //    underlying CLI keeps the conversation context.
    let result = crate::agent_session::run_agent_turn_inner(
        &app,
        agent.id.clone(),
        agent.system_prompt.clone(),
        message,
        Some(history_msgs),
    )
    .await;

    match result {
        Ok(out) => {
            // Persist the assistant reply as an agent message.
            let agent_msg = TaskMessage {
                id: uuid::Uuid::new_v4().to_string(),
                task_id: task_id.clone(),
                role: "agent".to_string(),
                content: out.reply.clone(),
                created_at: now.clone(),
            };
            storage::save_task_message(&agent_msg);
            // Bump agent last_used_at and mark working->idle (a turn is done).
            let mut a = agent.clone();
            a.last_used_at = now;
            a.status = "idle".to_string();
            a.current_task_id = None;
            storage::save_agent(&a);
            Ok(TaskExchangeResult {
                user: user_msg,
                agent: Some(agent_msg),
            })
        }
        Err(e) => {
            // Don't fail the whole call — the user message is saved.
            // Surface the error as an agent message so the UI shows it.
            let err_msg = TaskMessage {
                id: uuid::Uuid::new_v4().to_string(),
                task_id: task_id.clone(),
                role: "agent".to_string(),
                content: format!("[error] {}", e),
                created_at: now,
            };
            storage::save_task_message(&err_msg);
            Ok(TaskExchangeResult {
                user: user_msg,
                agent: Some(err_msg),
            })
        }
    }
}

#[derive(serde::Serialize)]
pub struct TaskExchangeResult {
    pub user: TaskMessage,
    pub agent: Option<TaskMessage>,
}

#[tauri::command]
pub fn get_task_messages(task_id: String) -> Vec<TaskMessage> {
    storage::read_task_messages(&task_id)
}

// ===== 配置 =====

#[tauri::command]
pub fn get_config() -> AppConfig {
    storage::read_config()
}

#[tauri::command]
pub fn save_config(config: AppConfig) -> Result<(), String> {
    storage::write_config(&config);
    Ok(())
}

// ===== 任务更新 =====

#[tauri::command]
pub fn update_task(task_id: String, params: UpdateTaskParams) -> Result<Task, String> {
    let mut task = storage::find_task(&task_id).ok_or("任务不存在")?;
    let now = Utc::now().to_rfc3339();

    if let Some(title) = params.title { task.title = title; }
    if let Some(desc) = params.description { task.description = desc; }
    if let Some(status) = params.status { task.status = status; }
    if let Some(priority) = params.priority { task.priority = priority; }
    if let Some(start_date) = params.start_date { task.start_date = Some(start_date); }
    if let Some(due_date) = params.due_date { task.due_date = Some(due_date); }
    if let Some(milestone) = params.milestone { task.milestone = milestone; }
    if let Some(agent_id) = params.assigned_agent_id { task.assigned_agent_id = Some(agent_id); }
    if let Some(tags) = params.tags { task.tags = tags; }
    if let Some(sort_order) = params.sort_order { task.sort_order = sort_order; }
    if let Some(cf) = params.custom_fields { task.custom_fields = cf; }

    task.updated_at = now;
    storage::save_task(&task);
    Ok(task)
}

#[tauri::command]
pub fn batch_update_tasks(task_ids: Vec<String>, status: Option<String>, priority: Option<i32>, tags: Option<Vec<String>>) -> Result<i32, String> {
    let mut count = 0;
    for tid in &task_ids {
        if let Some(mut task) = storage::find_task(tid) {
            let now = Utc::now().to_rfc3339();
            if let Some(ref s) = status { task.status = s.clone(); }
            if let Some(p) = priority { task.priority = p; }
            if let Some(ref t) = tags { task.tags = t.clone(); }
            task.updated_at = now;
            storage::save_task(&task);
            count += 1;
        }
    }
    Ok(count)
}

// ===== 标签命令 =====

#[tauri::command]
pub fn list_tags(project_id: String) -> Vec<Tag> {
    storage::read_tags_by_project(&project_id)
}

#[tauri::command]
pub fn create_tag(project_id: String, name: String, color: String) -> Tag {
    let tag = Tag {
        id: uuid::Uuid::new_v4().to_string(),
        project_id,
        name,
        color,
    };
    storage::save_tag(&tag);
    tag
}

#[tauri::command]
pub fn delete_tag(id: String) -> Result<(), String> {
    storage::remove_tag(&id);
    Ok(())
}

// ===== 任务依赖命令 =====

#[tauri::command]
pub fn get_task_dependencies(task_id: String) -> Vec<String> {
    storage::get_task_dependencies(&task_id)
}

#[tauri::command]
pub fn set_task_dependencies(task_id: String, depends_on: Vec<String>) -> Result<(), String> {
    // 循环依赖检测
    for dep_id in &depends_on {
        if dep_id == &task_id {
            return Err("不能依赖自己".to_string());
        }
    }
    storage::set_task_dependencies(&task_id, &depends_on);
    Ok(())
}

// ===== 文档命令 =====

#[tauri::command]
pub fn list_documents(project_id: String) -> Vec<ProjectDocument> {
    storage::read_documents_by_project(&project_id)
}

#[tauri::command]
pub fn create_document(project_id: String, title: String, content: String) -> ProjectDocument {
    let now = Utc::now().to_rfc3339();
    let doc = ProjectDocument {
        id: uuid::Uuid::new_v4().to_string(),
        project_id,
        title,
        content,
        parent_id: None,
        sort_order: 0,
        created_at: now.clone(),
        updated_at: now,
    };
    storage::save_document(&doc);
    doc
}

#[tauri::command]
pub fn update_document(doc_id: String, title: Option<String>, content: Option<String>) -> Result<ProjectDocument, String> {
    let mut doc = storage::find_document(&doc_id).ok_or("文档不存在")?;
    let now = Utc::now().to_rfc3339();
    if let Some(t) = title { doc.title = t; }
    if let Some(c) = content { doc.content = c; }
    doc.updated_at = now;
    storage::save_document(&doc);
    Ok(doc)
}

#[tauri::command]
pub fn delete_document(doc_id: String) -> Result<(), String> {
    storage::remove_document(&doc_id);
    Ok(())
}
