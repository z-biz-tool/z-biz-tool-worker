use crate::models::*;
use crate::storage;
use crate::task_state;
use chrono::Utc;

/// 代理地址（**单一真源**）。
///
/// ⚠ 旧实现有两份：这里读设置里的 `agent_proxy_url`，
/// 而 `agent_session::chat()` **硬编码** `http://127.0.0.1:9099`
/// ⇒ 用户改了代理地址，「发现本地 Agent」连的是新地址、**对话连的是老地址**
/// ⇒ 同一个代理有两套地址 ⇒ 对话要么连不上、要么连到另一个实例。
/// ⇒ 现在两边都走 `agent_session::proxy_url()`。
fn get_proxy_url() -> String {
    crate::agent_session::proxy_url()
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

/// 改名只动 name/updated_at：项目 id 不变，任务与 Agent 的归属关系保持原样。
#[tauri::command]
pub fn rename_project(id: String, name: String) -> Result<Project, String> {
    let now = Utc::now().to_rfc3339();
    storage::rename_project(&id, &name, &now)
}

#[tauri::command]
pub fn get_project_stats(id: String) -> Result<ProjectStats, String> {
    // 统计口径**只有一份**：db::get_project_stats。
    //
    // 原先这里另写了一遍（在 Rust 侧把该项目的任务/Agent 全读出来再 filter），
    // 与 db 层那版（SQL 侧只取 status 列）**是同一套规则的两份实现** ——
    // 正是「同一套规则前后端各写一遍必然漂移」的形态：
    // 一份改字段名，另一份不会跟着改，数字对不上时没人知道该信哪个。
    // 现在统一走 db 层那份（顺带少读一堆整行）。
    Ok(storage::get_project_stats(&id))
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
                    let arr = v
                        .get("cli_agents")
                        .and_then(|x| x.as_array())
                        .cloned()
                        .unwrap_or_default();
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
        system_prompt: if prompt.is_empty() {
            "你是一个有用的AI助手。".to_string()
        } else {
            prompt
        },
        model: if model.is_empty() {
            "default".to_string()
        } else {
            model
        },
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
        name: if name.is_empty() {
            format!("{} (副本)", source.name)
        } else {
            name
        },
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
pub fn create_task(
    project_id: String,
    title: String,
    desc: String,
    parent_id: Option<String>,
) -> Task {
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
pub async fn assign_task(
    app: tauri::AppHandle,
    task_id: String,
    agent_id: String,
) -> Result<Task, String> {
    let agent = storage::find_agent(&agent_id).ok_or("Agent不存在")?;
    let task = storage::find_task(&task_id).ok_or("任务不存在")?;
    let now = Utc::now().to_rfc3339();

    // 01 B3「并发领取竞态」：原来是「find → 改内存 → save」三步，
    // 而 save_task 是无条件 upsert ⇒ 两个 Agent 同时领同一个任务时，
    // 后写的覆盖先写的，先写的那个 Agent 已经在跑 LLM 但任务归属已被改掉。
    //
    // 现在分两条**带 WHERE 的 UPDATE**：
    // - 任务**还没人领** ⇒ claim（抢单）：`assigned_agent_id IS NULL` 才算成功，
    //   两个 Agent 同时抢只有一个赢家，另一个明确失败，不默默覆盖。
    // - 任务**已经归别人** ⇒ reassign（用户显式改派）：`assigned_agent_id = 旧值` 才算成功，
    //   中途被别人改派过就失败，不把别人的绑定顶掉。
    // 两条都不是「无条件整行写」，所以也不会把窗口期里别人改的别的字段覆盖回去。
    let claimed = match task.assigned_agent_id.as_deref() {
        None => storage::claim_task(&task_id, &task.status, &agent_id, &agent.name, &now)?,
        Some(old_agent_id) => {
            storage::reassign_task(&task_id, old_agent_id, &agent_id, &agent.name, &now)?
        }
    };
    if !claimed {
        return Err(match task.assigned_agent_id.as_deref() {
            None => "任务已被其他 Agent 认领，请刷新后重试".to_string(),
            Some(_) => "任务的分配已发生变化（可能已被改派给别人），请刷新后重试".to_string(),
        });
    }

    // 改派时把**旧 Agent** 放回空闲。
    //
    // 原实现没有这一步：改派只改了任务上的绑定，旧 Agent 的 status 仍停在
    // "working"、current_task_id 仍指着这个已经不属于它的任务 ⇒
    // 那个 Agent 永远显示"工作中"，也不会去接别的活。
    // 只在旧 Agent **确实在跑这个任务**时才放它空闲（current_task_id 对得上），
    // 免得误伤正在干别的活的 Agent。
    if let Some(old_agent_id) = task.assigned_agent_id.as_deref() {
        if old_agent_id != agent_id {
            if let Some(mut old_agent) = storage::find_agent(old_agent_id) {
                if old_agent.current_task_id.as_deref() == Some(task_id.as_str()) {
                    old_agent.status = "idle".to_string();
                    old_agent.current_task_id = None;
                    storage::save_agent(&old_agent);
                }
            }
        }
    }

    // 更新Agent状态
    let mut agent = agent;
    agent.status = "working".to_string();
    agent.current_task_id = Some(task_id.clone());
    agent.last_used_at = Utc::now().to_rfc3339();
    storage::save_agent(&agent);

    // 重新读回，落库后的实际状态
    let task = storage::find_task(&task_id).ok_or("任务不存在")?;

    // 后台触发 agent-proxy 真实执行。task 已经持久化为 doing,
    // 即使后台失败,任务也不会卡死:失败时改 waiting + 写错误到 output。
    //
    // ⚠ 走 Tauri 的异步运行时（不是 `std::thread`）——
    //   因为执行路径换成了 `agent_session::run_agent_turn_inner`（async），
    //   它与**面板对话**共用同一个 proxy session（同一个 Agent ⇒ 同一个会话）。
    let task_id_bg = task.id.clone();
    let agent_id_bg = agent.id.clone();
    let prompt_bg = format!(
        "任务标题: {}\n任务描述: {}\n\n请直接给出结果,不要解释你的工具调用过程。",
        task.title, task.description
    );
    let app_bg = app.clone();
    tauri::async_runtime::spawn(async move {
        run_task_background(&app_bg, &task_id_bg, &agent_id_bg, &prompt_bg).await;
    });

    Ok(task)
}

/// 重试卡在 doing 的任务(网络抖 / agent-proxy 重启后状态丢失 / LLM 超时等场景)。
/// 把 task 改回 doing 后再后台跑一次。
///
/// ⚠ **重试不再是「从零开始」**：执行走的是**同一个 Agent 的同一条会话**，
///   并且带上这个任务已有的消息历史 ⇒ Agent 记得上次跑到哪、也记得用户的追问。
///   （旧实现走 `agent_runner::run_agent`：每次 `/v1/session/open` 开**新**会话、
///   不带任何历史 ⇒ 每次重试都从空白开始。）
#[tauri::command]
pub async fn retry_task(app: tauri::AppHandle, task_id: String) -> Result<Task, String> {
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
    let prompt_bg = format!(
        "任务标题: {}\n任务描述: {}\n\n请直接给出结果,不要解释你的工具调用过程。",
        task.title, task.description
    );
    let app_bg = app.clone();
    tauri::async_runtime::spawn(async move {
        run_task_background(&app_bg, &task_id_bg, &agent_id_bg, &prompt_bg).await;
    });
    Ok(task)
}

/// 后台执行核心：跑一轮 Agent，并把**结果写进对话历史**。
///
/// ⚠ **本轮改了三处**（旧实现全是坏的）：
///  1. **会话**：旧实现走 `agent_runner::run_agent` ⇒ 每次 `/v1/session/open` 开**新**会话、
///     不带历史 ⇒ 自动执行与面板对话是**两个互不相干的对话**。
///     现在走 `agent_session::run_agent_turn_inner` ⇒ **同一个 Agent ⇒ 同一个 proxy session**。
///  2. **历史**：现在把这条任务已有的消息当上下文带进去 ⇒ 重试不是从零开始。
///  3. **落进对话历史**：旧实现只写 `task.output` / `task.agent_output`
///     ⇒ **对话里什么都没有** ⇒ 用户在面板里问「你刚才那个结果里 X 是多少」，
///     Agent **看不到自己刚才的输出**（`send_task_message` 只读 `task_messages`）
///     ⇒ **界面显示着结果、Agent 却失忆**。
///     现在成功/失败都写一条 `role="agent"` 的消息 ⇒ 用户看得见、Agent 也记得。
///
/// `agent` 没有 `cli_type`（手填 Agent）时不调 LLM，直接停在 doing 等用户手动操作（原行为不变）。
async fn run_task_background(app: &tauri::AppHandle, task_id: &str, agent_id: &str, prompt: &str) {
    let agent = match storage::find_agent(agent_id) {
        Some(a) => a,
        None => {
            eprintln!("[run_task_background] agent {} 不存在,跳过执行", agent_id);
            return;
        }
    };
    if agent.cli_type.is_none() {
        eprintln!(
            "[run_task_background] agent {} 非本地 CLI,跳过执行",
            agent_id
        );
        return;
    }

    // 历史：这个任务已有的消息（用户追问 + 之前的自动执行结果）⇒ 重试能接上
    let history_msgs = build_history_msgs(task_id);

    let result = crate::agent_session::run_agent_turn_inner(
        app,
        agent_id.to_string(),
        agent.system_prompt.clone(),
        prompt.to_string(),
        Some(history_msgs),
    )
    .await;

    let now = Utc::now().to_rfc3339();
    match result {
        Ok(out) => {
            if let Some(mut t) = storage::find_task(task_id) {
                t.output = Some(out.reply.clone());
                t.agent_output = Some(out.reply.clone());
                t.status = "review".to_string();
                t.updated_at = now.clone();
                storage::save_task(&t);
            }
            // ★ 结果也进对话历史 ⇒ 用户看得见、Agent 记得（见上面的第 3 条）
            storage::save_task_message(&TaskMessage {
                id: uuid::Uuid::new_v4().to_string(),
                task_id: task_id.to_string(),
                role: "agent".to_string(),
                content: out.reply,
                created_at: now.clone(),
            });
            // 释放 Agent
            if let Some(mut a) = storage::find_agent(agent_id) {
                a.status = "idle".to_string();
                a.current_task_id = None;
                storage::save_agent(&a);
            }
        }
        Err(e) => {
            eprintln!(
                "[run_task_background] task {} agent-proxy 执行失败: {}",
                task_id, e
            );
            let failed_text = format!("[执行失败,点「重试」再来一次]\n\n{}", e);
            if let Some(mut t) = storage::find_task(task_id) {
                t.status = "waiting".to_string();
                t.output = Some(failed_text.clone());
                t.updated_at = now.clone();
                storage::save_task(&t);
            }
            // 失败也要留痕：用户与 Agent 都要看得见「上次没成」
            storage::save_task_message(&TaskMessage {
                id: uuid::Uuid::new_v4().to_string(),
                task_id: task_id.to_string(),
                role: "agent".to_string(),
                content: failed_text,
                created_at: now.clone(),
            });
            if let Some(mut a) = storage::find_agent(agent_id) {
                a.status = "idle".to_string();
                a.current_task_id = None;
                storage::save_agent(&a);
            }
        }
    }
}

/// 这个任务已有的消息 ⇒ LLM 上下文。
///
/// `role` 只有 `user` / `agent` 两种 ⇒ 直接映射成 OpenAI 的 `user` / `assistant`。
fn build_history_msgs(task_id: &str) -> Vec<crate::agent_session::ChatMessage> {
    storage::read_task_messages(task_id)
        .into_iter()
        .filter_map(|m| {
            let role = match m.role.as_str() {
                "user" => "user",
                "agent" => "assistant",
                _ => return None,
            };
            Some(crate::agent_session::ChatMessage {
                role: role.to_string(),
                content: m.content,
            })
        })
        .collect()
}

/// 任意状态流转。合法的状态: todo | doing | waiting | review | done
/// 切到 done 时同时设置 completed_at;doing 时如果原来有 assigned_agent,会保留分配。
#[tauri::command]
pub fn update_task_status(task_id: String, status: String) -> Result<Task, String> {
    // 状态白名单与"要不要盖完成时间 / 要不要释放 Agent"的规则都在 task_state 里，
    // 那里有逐条单测（01 B2「状态流转零测试」）。
    task_state::validate_status(&status)?;
    let plan = task_state::plan_status_update(&status);

    let mut task = storage::find_task(&task_id).ok_or("任务不存在")?;
    let now = Utc::now().to_rfc3339();
    task.status = status.clone();
    task.updated_at = now.clone();
    if plan.stamp_completed_at {
        task.completed_at = Some(now.clone());
        // 释放 Agent
        //
        // 顺带修掉一个真实的字段不一致：原来只把 Agent 置回 idle、
        // 却**没清 task.assigned_agent_id** ⇒ 任务已经完成，
        // 界面上却还显示"已分配给某某"，而那个 Agent 已经是空闲状态。
        // 看板（KanbanView）与任务详情（TaskDetailPanel）都读这个字段。
        if let Some(agent_id) = task.assigned_agent_id.clone() {
            if let Some(mut agent) = storage::find_agent(&agent_id) {
                agent.status = "idle".to_string();
                agent.current_task_id = None;
                storage::save_agent(&agent);
            }
        }
    }
    // 先把状态落盘
    storage::save_task(&task);

    // **再**释放任务上的 Agent 绑定。
    //
    // 顺序不能反：save_task 是整行 upsert，写的是内存里那份 task
    // （此时 assigned_agent_id 还指着旧 Agent）—— 如果先释放再 save_task，
    // 那次 upsert 会把刚清掉的绑定**原样写回去**，等于什么都没做。
    //
    // 放在最后还有个好处：release_task_agent 是**条件更新**
    //（`WHERE id = ? AND assigned_agent_id = ?`），中途若任务已被改派给别人，
    // 它不会把别人的绑定清掉。
    if plan.release_agent {
        if let Some(agent_id) = task.assigned_agent_id.clone() {
            storage::release_task_agent(
                &task_id,
                &agent_id,
                &status,
                task.completed_at.as_deref(),
                &now,
            )?;
            task.assigned_agent_id = None;
            task.assigned_agent_name = None;
        }
    }
    Ok(task)
}

#[tauri::command]
pub fn review_task(task_id: String, approved: bool) -> Result<Task, String> {
    // 规则见 task_state::plan_review（有单测）：验收通过 ⇒ done + 盖完成时间；
    // 不通过 ⇒ 回 todo；**两种情况都释放 Agent**。
    let plan = task_state::plan_review(approved);

    let mut task = storage::find_task(&task_id).ok_or("任务不存在")?;
    let now = Utc::now().to_rfc3339();

    task.status = plan.next_status.to_string();
    if plan.stamp_completed_at {
        task.completed_at = Some(now.clone());
    }
    task.updated_at = now.clone();

    // Agent回归空闲
    //
    // 同 update_task_status：释放 Agent 时要把任务上的绑定一并清掉，
    // 否则验收通过后任务仍显示"已分配给某某"，而那个 Agent 已经空闲。
    if plan.release_agent {
        if let Some(agent_id) = task.assigned_agent_id.clone() {
            if let Some(mut agent) = storage::find_agent(&agent_id) {
                agent.status = "idle".to_string();
                agent.current_task_id = None;
                storage::save_agent(&agent);
            }
        }
    }

    // 先落盘状态，再释放绑定（顺序理由见 update_task_status 的注释：
    // save_task 是整行 upsert，放在释放之后会把内存里的旧绑定写回去）
    storage::save_task(&task);

    if plan.release_agent {
        if let Some(agent_id) = task.assigned_agent_id.clone() {
            storage::release_task_agent(
                &task_id,
                &agent_id,
                &task.status,
                task.completed_at.as_deref(),
                &now,
            )?;
            task.assigned_agent_id = None;
            task.assigned_agent_name = None;
        }
    }

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
        None => {
            return Ok(TaskExchangeResult {
                user: user_msg,
                agent: None,
            })
        }
    };
    let agent_id = match &task.assigned_agent_id {
        Some(a) => a.clone(),
        None => {
            return Ok(TaskExchangeResult {
                user: user_msg,
                agent: None,
            })
        }
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
    if !task.description.is_empty() {
        // Anchor the conversation with the task description so the agent
        // has the brief in context.
        history_msgs.push(crate::agent_session::ChatMessage {
            role: "user".to_string(),
            content: format!("[Task: {}]\n{}", task.title, task.description),
        });
    }
    for m in &history {
        // 刚存进去的那条用户消息**不算**进历史（否则这一轮会把它说两遍）。
        // ⚠ 用 id 精确排除，而不是「无脑 pop 最后一条」——
        //   自动执行的结果现在也会进 history（role=agent），
        //   无脑 pop 会把**它**弹掉 ⇒ 正好把我们要保留的东西删了。
        if m.id == user_msg.id {
            continue;
        }
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

    // ★ 任务已有的产出也要进上下文 ——
    //   否则用户问「你刚才那个结果里 X 是多少」时，Agent **看不见自己刚交付的东西**
    //   （界面上明明显示着结果，Agent 却答不上来 ⇒ 界面说成功、事实不是）。
    //   自动执行的结果现在也会写进 `task_messages` ⇒ 自动执行过的任务天然覆盖；
    //   这一条是为了**旧数据**（产出在 task 上、对话里没有）。
    let task_output = task
        .output
        .as_deref()
        .or(task.agent_output.as_deref())
        .map(str::trim)
        .filter(|s| !s.is_empty());
    if let Some(out) = task_output {
        let already = history_msgs
            .iter()
            .any(|m| m.role == "assistant" && m.content.trim() == out);
        if !already {
            history_msgs.push(crate::agent_session::ChatMessage {
                role: "assistant".to_string(),
                content: out.to_string(),
            });
        }
    }

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

    if let Some(title) = params.title {
        task.title = title;
    }
    if let Some(desc) = params.description {
        task.description = desc;
    }
    if let Some(status) = params.status {
        task.status = status;
    }
    if let Some(priority) = params.priority {
        task.priority = priority;
    }
    if let Some(start_date) = params.start_date {
        task.start_date = Some(start_date);
    }
    if let Some(due_date) = params.due_date {
        task.due_date = Some(due_date);
    }
    if let Some(milestone) = params.milestone {
        task.milestone = milestone;
    }
    if let Some(agent_id) = params.assigned_agent_id {
        task.assigned_agent_id = Some(agent_id);
    }
    if let Some(tags) = params.tags {
        task.tags = tags;
    }
    if let Some(sort_order) = params.sort_order {
        task.sort_order = sort_order;
    }
    if let Some(cf) = params.custom_fields {
        task.custom_fields = cf;
    }

    task.updated_at = now;
    storage::save_task(&task);
    Ok(task)
}

#[tauri::command]
pub fn batch_update_tasks(
    task_ids: Vec<String>,
    status: Option<String>,
    priority: Option<i32>,
    tags: Option<Vec<String>>,
) -> Result<i32, String> {
    let mut count = 0;
    for tid in &task_ids {
        if let Some(mut task) = storage::find_task(tid) {
            let now = Utc::now().to_rfc3339();
            if let Some(ref s) = status {
                task.status = s.clone();
            }
            if let Some(p) = priority {
                task.priority = p;
            }
            if let Some(ref t) = tags {
                task.tags = t.clone();
            }
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
pub fn update_document(
    doc_id: String,
    title: Option<String>,
    content: Option<String>,
) -> Result<ProjectDocument, String> {
    let mut doc = storage::find_document(&doc_id).ok_or("文档不存在")?;
    let now = Utc::now().to_rfc3339();
    if let Some(t) = title {
        doc.title = t;
    }
    if let Some(c) = content {
        doc.content = c;
    }
    doc.updated_at = now;
    storage::save_document(&doc);
    Ok(doc)
}

#[tauri::command]
pub fn delete_document(doc_id: String) -> Result<(), String> {
    storage::remove_document(&doc_id);
    Ok(())
}
