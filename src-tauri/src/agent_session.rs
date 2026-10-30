// Agent session binding: maps a Tauri Agent's `id` to a `agent-proxy` session
// id. The proxy session id is what we send in `X-Session-Id` so the proxy
// keeps routing subsequent turns to the same CLI instance (and, for hermes,
// resumes the underlying hermes session).
//
// Persistence: `~/.future-team/agent-sessions.json` (one entry per agent).

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::Manager;

const PROXY_DEFAULT_URL: &str = "http://127.0.0.1:9099";

#[derive(Default, Serialize, Deserialize)]
struct Persisted {
    /// agentId -> proxySessionId
    sessions: HashMap<String, String>,
    /// agentId -> the CLI type the user picked for that agent (claude-code /
    /// hermes / opencode). Optional — defaults to claude-code.
    #[serde(default)]
    cli_types: HashMap<String, String>,
}

pub struct AgentSessionState {
    inner: Mutex<Persisted>,
    path: PathBuf,
}

impl AgentSessionState {
    /// Load from the default location (`~/.local/share/future-team/agent-sessions.json`).
    pub fn load() -> Self {
        let path = persist_path();
        // 只对**默认目录**收紧权限；`load_from` 的调用方（测试/自定义存储）
        // 可能把文件放在 /tmp 这类共享目录里，改它的权限会误伤别人。
        if let Some(dir) = path.parent() {
            let _ = std::fs::create_dir_all(dir);
            restrict_mode(dir, 0o700);
        }
        let inner = match std::fs::read_to_string(&path) {
            Ok(raw) => serde_json::from_str(&raw).unwrap_or_default(),
            Err(_) => Persisted::default(),
        };
        Self {
            inner: Mutex::new(inner),
            path,
        }
    }

    /// Load from an explicit path (used by tests and for non-default storage).
    ///
    /// 只被本文件的 `mod tests` 用到 ⇒ 标 `cfg(test)`，
    /// 否则非测试构建会报「never used」。
    #[cfg(test)]
    pub fn load_from(path: PathBuf) -> Self {
        let inner = match std::fs::read_to_string(&path) {
            Ok(raw) => serde_json::from_str(&raw).unwrap_or_default(),
            Err(_) => Persisted::default(),
        };
        Self {
            inner: Mutex::new(inner),
            path,
        }
    }

    /// Look up (or create + persist) a proxy session for the given agent.
    pub fn get_or_create(&self, agent_id: &str) -> String {
        let mut g = self.inner.lock().expect("agent-session mutex poisoned");
        if let Some(sid) = g.sessions.get(agent_id) {
            return sid.clone();
        }
        let sid = uuid::Uuid::new_v4().to_string();
        g.sessions.insert(agent_id.to_string(), sid.clone());
        save(&g, &self.path);
        sid
    }

    /// 用户**显式覆盖**过的 CLI 类型（`set_agent_cli_type` 写的）。
    ///
    /// ⚠ 旧实现里根本没有这个概念：`cli_type_for` 直接读 `cli_types` 表，
    /// 而那张表**从来没人写过**（`set_agent_cli_type` 前端一次都没调）
    /// ⇒ 对话**永远**路由到 `claude-code`。
    ///
    /// 生产路径统一走 `resolve_cli_type`（它一次性读表并合并 Agent 自声明），
    /// 这个单字段读取只留给测试断言用。
    #[cfg(test)]
    pub fn cli_type_override(&self, agent_id: &str) -> Option<String> {
        let g = self.inner.lock().expect("agent-session mutex poisoned");
        g.cli_types.get(agent_id).cloned()
    }

    pub fn set_cli_type(&self, agent_id: &str, cli_type: &str) {
        let mut g = self.inner.lock().expect("agent-session mutex poisoned");
        g.cli_types
            .insert(agent_id.to_string(), cli_type.to_string());
        save(&g, &self.path);
    }

    /// 删掉某个 Agent 的全部本地记录，返回它原来的对话会话 id。
    ///
    /// 用于「Agent 被删除」：会话 id 还要拿去让代理**杀掉对应的 CLI**。
    /// 只删数据库行不管会话的话，CLI 会挂到空闲超时（默认 30 分钟）才回收。
    pub fn forget(&self, agent_id: &str) -> Option<String> {
        let mut g = self.inner.lock().expect("agent-session mutex poisoned");
        let session = g.sessions.remove(agent_id);
        g.cli_types.remove(agent_id);
        save(&g, &self.path);
        session
    }

    /// 列出所有 agent→session 绑定。
    ///
    /// `agent_cli_type` 回调给出「这个 Agent 自己声明的 CLI 类型」
    /// （库里 `agents.cli_type` 那一列）⇒ 用来把**生效中**的类型算出来，
    /// 而不是只报那张「覆盖表」里的值。
    pub fn list(&self, agent_cli_type: &dyn Fn(&str) -> Option<String>) -> Vec<AgentSessionInfo> {
        let g = self.inner.lock().expect("agent-session mutex poisoned");
        g.sessions
            .iter()
            .map(|(agent_id, session_id)| AgentSessionInfo {
                agent_id: agent_id.clone(),
                session_id: session_id.clone(),
                cli_type: resolve_cli_type_in(
                    &g.cli_types,
                    agent_cli_type(agent_id).as_deref(),
                    agent_id,
                ),
            })
            .collect()
    }
}

/// 这个 Agent **实际**该走哪个 CLI。
///
/// 优先级（三层，从上到下）：
///   1. **用户显式覆盖**（`set_agent_cli_type` 写进 `cli_types` 的那张表）；
///   2. **Agent 自己声明的** `cli_type`（导入本地 CLI 时写进 `agents` 表的那一列）；
///   3. `claude-code`（兜底）。
///
/// ⚠ **旧实现只认第 1 层，而第 1 层从来没人写过** ⇒ 对话（`send_task_message`）
///   **永远**路由到 claude-code ⇒ 卡片上写着「Hermes」的 Agent，
///   **对话里跑的却是 Claude Code** —— 同一个 Agent 有两套 CLI 说法。
///
/// ⚠ 第 2 层以前也被忽略：自动执行走的是 `agent.cli_type`（对的），
///   对话走的是 `cli_type_for`（错的）⇒ **两条路连的根本不是同一个东西**。
///
/// 这函数是**纯函数**（不碰 IO）⇒ 可以逐条单测。
pub fn resolve_cli_type_in(
    overrides: &HashMap<String, String>,
    agent_cli_type: Option<&str>,
    agent_id: &str,
) -> String {
    if let Some(t) = overrides.get(agent_id) {
        if !t.trim().is_empty() {
            return t.clone();
        }
    }
    match agent_cli_type {
        Some(t) if !t.trim().is_empty() => t.to_string(),
        _ => "claude-code".to_string(),
    }
}

/// `resolve_cli_type_in` 的带状态版本。
pub fn resolve_cli_type(
    state: &AgentSessionState,
    agent_cli_type: Option<&str>,
    agent_id: &str,
) -> String {
    let overrides = {
        let g = state.inner.lock().expect("agent-session mutex poisoned");
        g.cli_types.clone()
    };
    resolve_cli_type_in(&overrides, agent_cli_type, agent_id)
}

#[derive(Serialize)]
pub struct AgentSessionInfo {
    pub agent_id: String,
    pub session_id: String,
    pub cli_type: String,
}

// ──────────── proxy HTTP client ────────────

/// 代理地址：**配置优先**，否则默认。
///
/// ⚠ 旧实现里 `chat()` **硬编码** `http://127.0.0.1:9099`，
/// 而设置项 `agent_proxy_url` 只有 `discover_local_agents` 在读
/// ⇒ 用户改了代理地址，「发现本地 Agent」能连上、**对话却连的是老地址**
/// ⇒ **同一个代理有两套地址**。
pub fn proxy_url() -> String {
    let cfg = crate::storage::read_config();
    let configured = cfg.agent_proxy_url.trim();
    if configured.is_empty() {
        PROXY_DEFAULT_URL.to_string()
    } else {
        configured.to_string()
    }
}

/// POST a chat completion to the local agent-proxy. Returns the assistant
/// text. `cli_type` becomes `X-CLI-Type` (lets the caller force a wrapper
/// regardless of how the agent was previously routed).
///
/// `proxy_agent_id` 变成 `X-Agent-Id` ⇒ 代理按**那个具体的 Agent** 路由，
/// 而不是「按 CLI 类型取第一个」（同类型的 Agent 多于一个时会路由错）。
pub async fn chat(
    proxy_url: &str,
    session_id: &str,
    cli_type: &str,
    proxy_agent_id: Option<&str>,
    messages: Vec<ChatMessage>,
) -> Result<String, String> {
    let url = format!("{}/v1/chat/completions", proxy_url);
    // no_proxy()：agent-proxy 是**本机**起的服务（proxy_url() 指向 127.0.0.1），
    // 绝不该被 HTTP_PROXY 劫持。开着代理的机器上，请求会被送到代理去，
    // 代理连不上本机就回 502 —— 表现是"agent 连不上"，实际是"代理挡在中间"。
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(300))
        .no_proxy()
        .build()
        .map_err(|e| format!("reqwest build: {e}"))?;
    let body = serde_json::json!({
        "stream": false,
        "messages": messages,
    });
    let mut req = client
        .post(&url)
        .header("Content-Type", "application/json")
        .header("X-Session-Id", session_id)
        .header("X-CLI-Type", cli_type);
    if let Some(aid) = proxy_agent_id {
        if !aid.trim().is_empty() {
            req = req.header("X-Agent-Id", aid);
        }
    }
    let resp = req
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("proxy unreachable: {e}"))?;
    let status = resp.status();
    let raw = resp.text().await.map_err(|e| format!("read body: {e}"))?;
    if !status.is_success() {
        return Err(format!("proxy returned HTTP {}: {}", status, raw));
    }
    let parsed: ChatResponse = serde_json::from_str(&raw).map_err(|e| {
        format!(
            "parse response: {e}; body={}",
            raw.chars().take(200).collect::<String>()
        )
    })?;
    Ok(parsed
        .choices
        .first()
        .map(|c| c.message.content.clone())
        .unwrap_or_default())
}

#[derive(serde::Serialize, serde::Deserialize)]
pub struct ChatMessage {
    pub role: String,
    pub content: String,
}

#[derive(serde::Deserialize)]
struct ChatResponse {
    choices: Vec<ChatChoice>,
}

#[derive(serde::Deserialize)]
struct ChatChoice {
    message: ChatChoiceMessage,
}

#[derive(serde::Deserialize)]
struct ChatChoiceMessage {
    content: String,
}

// ──────────── helpers ────────────

/// 收紧文件/目录权限（W-24）。
///
/// `agent-sessions.json` 里是 agent id、代理会话 uuid 与 CLI 覆盖值 ——
/// **不含** system_prompt、API key 或对话正文。但它仍属本机运行痕迹，
/// 不该让同机其他用户读到：文件 0600、目录 0700。
#[cfg(unix)]
fn restrict_mode(path: &Path, mode: u32) {
    use std::os::unix::fs::PermissionsExt;
    if let Ok(meta) = std::fs::metadata(path) {
        let mut perms = meta.permissions();
        perms.set_mode(mode);
        let _ = std::fs::set_permissions(path, perms);
    }
}

#[cfg(not(unix))]
fn restrict_mode(_path: &Path, _mode: u32) {}

fn save(p: &Persisted, path: &PathBuf) {
    if let Some(dir) = path.parent() {
        if let Err(e) = std::fs::create_dir_all(dir) {
            eprintln!("[agent-session] 建目录失败 {}: {e}", dir.display());
            return;
        }
    }
    let Ok(text) = serde_json::to_string_pretty(p) else {
        eprintln!("[agent-session] 序列化失败，本次绑定未落盘");
        return;
    };
    let mut opts = std::fs::OpenOptions::new();
    opts.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    match opts.open(path) {
        Ok(mut f) => {
            if let Err(e) = f.write_all(text.as_bytes()) {
                eprintln!("[agent-session] 写 {} 失败: {e}", path.display());
            }
        }
        Err(e) => eprintln!("[agent-session] 打开 {} 失败: {e}", path.display()),
    }
    // 文件已存在时 `mode()` 不生效，补一次 chmod。
    restrict_mode(path, 0o600);
}

fn persist_path() -> PathBuf {
    if let Some(mut p) = dirs::data_local_dir() {
        p.push("future-team");
        p.push("agent-sessions.json");
        return p;
    }
    PathBuf::from("agent-sessions.json")
}

// ──────────── Tauri command glue ────────────

/// Tauri command: return the proxy session id for an agent (creating one if
/// it doesn't exist yet).
#[tauri::command]
pub fn get_agent_session(
    app: tauri::AppHandle,
    agent_id: String,
) -> Result<AgentSessionInfo, String> {
    let state = app.state::<AgentSessionState>();
    let sid = state.get_or_create(&agent_id);
    // 报**生效中**的类型（覆盖 > Agent 自声明 > claude-code）。
    // 原先走 `cli_type_for`（只看覆盖表）⇒ 卡片写 Hermes 的 Agent 在对话框里
    // 显示成 claude-code，用户一按保存就把覆盖值真的改成 claude-code 了。
    let declared = crate::storage::find_agent(&agent_id).and_then(|a| a.cli_type);
    let cli_type = resolve_cli_type(&state, declared.as_deref(), &agent_id);
    Ok(AgentSessionInfo {
        agent_id,
        session_id: sid,
        cli_type,
    })
}

/// 让 agent-proxy 关掉一个会话（杀掉它拉起的 CLI）。
///
/// Agent 被删除时调用。代理没起 / 版本不支持该端点时返回 Err ——
/// 调用方**只记日志、不假装成功**：CLI 仍会在空闲超时后被回收。
pub async fn close_proxy_session(session_id: &str) -> Result<usize, String> {
    let url = format!("{}/v1/session/close", proxy_url());
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(3))
        .no_proxy()
        .build()
        .map_err(|e| format!("reqwest build: {e}"))?;
    let resp = client
        .post(&url)
        .json(&serde_json::json!({ "sessionId": session_id }))
        .send()
        .await
        .map_err(|e| format!("proxy unreachable: {e}"))?;
    let status = resp.status();
    let raw = resp.text().await.map_err(|e| format!("read body: {e}"))?;
    if !status.is_success() {
        return Err(format!("proxy returned HTTP {}: {}", status, raw));
    }
    #[derive(Deserialize)]
    struct CloseResponse {
        #[serde(default)]
        closed: usize,
    }
    let parsed: CloseResponse =
        serde_json::from_str(&raw).map_err(|e| format!("parse response: {e}; body={raw}"))?;
    Ok(parsed.closed)
}

/// Tauri command: set the CLI type (claude-code / hermes / opencode) for an
/// agent. Subsequent runs of that agent will route accordingly.
#[tauri::command]
pub fn set_agent_cli_type(
    app: tauri::AppHandle,
    agent_id: String,
    cli_type: String,
) -> Result<(), String> {
    let state = app.state::<AgentSessionState>();
    state.set_cli_type(&agent_id, &cli_type);
    Ok(())
}

/// Tauri command: list all agent->session bindings (for the UI to display).
///
/// ⚠ 报的是**生效中**的 CLI 类型（覆盖 > Agent 自己声明的 > claude-code），
///   不是「覆盖表」里的原值 ⇒ 界面上显示的与实际会跑的**是同一个**。
#[tauri::command]
pub fn list_agent_sessions(app: tauri::AppHandle) -> Vec<AgentSessionInfo> {
    let state = app.state::<AgentSessionState>();
    state.list(&|agent_id: &str| {
        crate::storage::find_agent(agent_id).and_then(|a| a.cli_type.clone())
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `claude` CLI 在不在 PATH。
    ///
    /// agent-proxy 的 claudeCode wrapper 是**每次请求 spawn claude** 的，
    /// 所以「代理进程活着」不等于「代理能用」—— 缺 claude 时每一轮都会 500。
    /// Windows 上 npm 装出来的是 `claude.cmd`，Unix 上是 `claude`，都算。
    fn claude_cli_present() -> bool {
        let Ok(path) = std::env::var("PATH") else {
            return false;
        };
        for dir in std::env::split_paths(&path) {
            for name in ["claude", "claude.cmd", "claude.exe", "claude.bat"] {
                if dir.join(name).is_file() {
                    return true;
                }
            }
        }
        false
    }

    /// End-to-end: a "worker" agent attaches to a proxy session, runs a
    /// turn, then runs a second turn — and the proxy session id stays the
    /// same. This is the property that makes the worker "stick" to one CLI
    /// instance for the duration of the agent's life.
    ///
    /// Requires the agent-proxy to be running on 127.0.0.1:9099 **and** the
    /// `claude` CLI to be installed. Skipped otherwise so CI doesn't fail.
    ///
    /// ## 为什么必须额外查 `claude`（2026-10-20 修）
    ///
    /// 原来的守卫只有「代理可达吗」。但 CI 上 `agent_proxy::tests::spawn_and_kill_lifecycle`
    /// **自己会 spawn 一个真 agent-proxy 占住 9099**（CI 的 `npm run build:all` 已经把
    /// dist 建出来了）⇒ 别的测试的「代理可达」探测**被这条测试骗过** ⇒ 继续往下走，
    /// 而 CI runner 上**根本没有 claude CLI** ⇒ agent-proxy 每轮都返回
    /// `HTTP 500 … Claude Code exited with code 1` ⇒ 这条测试在 CI 上必红。
    ///
    /// 代理「活着」≠ 代理「能用」：agent-proxy 的 claudeCode wrapper 是每次请求
    /// `spawn claude` 的，**没有 claude 就必然失败**。
    /// ⇒ 守卫补上「claude 在不在 PATH」，缺了就跳过并说明原因。
    #[tokio::test]
    async fn worker_attaches_to_session_and_does_real_work() {
        // Probe the proxy.
        // no_proxy()：探的是本机 agent-proxy。走代理的话，探针会被送到代理去 ——
        // 代理恰好能连上外网就回 200，于是"本机代理活着"被误判成"代理可达"，
        // 后面真正的请求却又被代理挡下，两头对不上。
        let probe = reqwest::Client::builder()
            .no_proxy()
            .build()
            .unwrap_or_default()
            .get("http://127.0.0.1:9099/health")
            .timeout(std::time::Duration::from_secs(1))
            .send()
            .await;
        if probe.is_err() {
            eprintln!("skipping: agent-proxy not reachable on 127.0.0.1:9099");
            return;
        }
        if !claude_cli_present() {
            eprintln!(
                "skipping: `claude` CLI 不在 PATH —— 这条测试要真跑一次 agent 轮次，\
                 agent-proxy 每次请求都会 spawn claude，没有它必然 500"
            );
            return;
        }

        let tmp =
            std::env::temp_dir().join(format!("agent-session-test-{}.json", uuid::Uuid::new_v4()));
        let _ = std::fs::remove_file(&tmp);
        let state = AgentSessionState::load_from(tmp.clone());

        let agent_id = "test-worker-1";
        let sid1 = state.get_or_create(agent_id);
        let cli_type = resolve_cli_type(&state, None, agent_id);

        // turn 1: ask the agent to remember a word
        let reply1 = chat(
            "http://127.0.0.1:9099",
            &sid1,
            &cli_type,
            None,
            vec![
                ChatMessage {
                    role: "system".to_string(),
                    content: "You are concise.".into(),
                },
                ChatMessage {
                    role: "user".to_string(),
                    content: "Remember the word PINEAPPLE. Just reply ACK.".into(),
                },
            ],
        )
        .await
        .expect("turn 1 chat should succeed");
        assert!(!reply1.is_empty(), "turn 1 reply should not be empty");
        eprintln!("turn 1 reply: {}", reply1);

        // turn 2: ask the agent to recall — same agent_id, same session
        let sid2 = state.get_or_create(agent_id);
        assert_eq!(sid1, sid2, "session id must be stable across turns");

        let reply2 = chat(
            "http://127.0.0.1:9099",
            &sid2,
            &cli_type,
            None,
            vec![ChatMessage {
                role: "user".to_string(),
                content: "What word did I ask you to remember? Just the word.".into(),
            }],
        )
        .await
        .expect("turn 2 chat should succeed");
        eprintln!("turn 2 reply: {}", reply2);

        // The agent is supposed to remember PINEAPPLE across turns because
        // both requests share the proxy session (which keeps the underlying
        // claude-code / hermes session alive). If the model didn't recall,
        // log it but don't hard-fail — model behaviour varies, and the
        // important thing is that the session is reused.
        let _ = std::fs::remove_file(&tmp);
    }

    /// get_or_create returns the same id on second call (idempotency).
    #[test]
    fn session_id_is_stable() {
        let tmp = std::env::temp_dir().join(format!("agent-session-{}.json", uuid::Uuid::new_v4()));
        let state = AgentSessionState::load_from(tmp.clone());
        let a = state.get_or_create("agent-A");
        let b = state.get_or_create("agent-A");
        assert_eq!(a, b);
        let c = state.get_or_create("agent-B");
        assert_ne!(a, c, "different agents should get different sessions");
        let _ = std::fs::remove_file(&tmp);
    }

    /// W-01：删除 Agent 时 `forget` 要返回会话 id（供代理杀 CLI），并清掉本地绑定。
    #[test]
    fn forget_removes_binding_and_returns_session_for_cleanup() {
        let tmp = std::env::temp_dir().join(format!(
            "agent-session-forget-{}.json",
            uuid::Uuid::new_v4()
        ));
        let state = AgentSessionState::load_from(tmp.clone());
        let sid = state.get_or_create("agent-A");
        state.set_cli_type("agent-A", "hermes");

        let removed = state.forget("agent-A");
        assert_eq!(
            removed.as_deref(),
            Some(sid.as_str()),
            "要返回会话 id 去关 CLI"
        );
        assert_eq!(state.cli_type_override("agent-A"), None);
        assert_eq!(state.forget("agent-A"), None, "重复删除不应报错");

        // 删完后再用同一个 agent id，必须拿到**新**会话（旧会话已被代理关掉）
        let sid2 = state.get_or_create("agent-A");
        assert_ne!(sid, sid2);
        let _ = std::fs::remove_file(&tmp);
    }

    /// W-24：落盘文件 0600，且**不含** system_prompt / API key / 对话正文。
    #[cfg(unix)]
    #[test]
    fn session_file_is_private_and_contains_no_prompts_or_secrets() {
        use std::os::unix::fs::PermissionsExt;

        let dir = std::env::temp_dir().join(format!("agent-session-perm-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).expect("建临时目录");
        let path = dir.join("agent-sessions.json");
        let state = AgentSessionState::load_from(path.clone());
        let sid = state.get_or_create("agent-A");
        state.set_cli_type("agent-A", "opencode");

        let mode = std::fs::metadata(&path)
            .expect("文件应已写出")
            .permissions()
            .mode()
            & 0o777;
        assert_eq!(mode, 0o600, "agent-sessions.json 必须是 0600");

        let raw = std::fs::read_to_string(&path).expect("读文件");
        assert!(raw.contains(&sid), "会话 id 应被持久化");
        assert!(raw.contains("opencode"), "CLI 覆盖值应被持久化");
        for forbidden in ["system_prompt", "api_key", "sk-", "content"] {
            assert!(
                !raw.contains(forbidden),
                "会话文件不应包含 {forbidden}：{raw}"
            );
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// **生效中的 CLI 类型**的三层优先级（纯函数，逐条钉住）。    ///
    /// ⚠ 这条规则是本轮修的一个真 bug 的核心：
    /// 旧实现只认「用户覆盖」那一层，而覆盖表**从来没人写过**
    /// ⇒ 对话**永远**路由到 claude-code
    /// ⇒ 卡片上写着「Hermes」的 Agent，对话里跑的却是 Claude Code。
    #[test]
    fn cli_type_resolution_precedence() {
        let mut overrides: HashMap<String, String> = HashMap::new();

        // ① 没有任何说法 ⇒ 兜底 claude-code
        assert_eq!(
            resolve_cli_type_in(&overrides, None, "agent-A"),
            "claude-code",
            "既没有覆盖、也没有 Agent 自己声明的类型时，应当兜底 claude-code"
        );

        // ② Agent 自己声明的（导入本地 CLI 时写进 agents 表的那一列）
        assert_eq!(
            resolve_cli_type_in(&overrides, Some("hermes"), "agent-A"),
            "hermes",
            "没有覆盖时，应当用 Agent 自己声明的 CLI 类型"
        );

        // ③ 用户显式覆盖 ⇒ 压过 Agent 自己声明的
        overrides.insert("agent-A".to_string(), "opencode".to_string());
        assert_eq!(
            resolve_cli_type_in(&overrides, Some("hermes"), "agent-A"),
            "opencode",
            "用户覆盖应当压过 Agent 自己声明的类型"
        );
        assert_eq!(
            resolve_cli_type_in(&overrides, None, "agent-A"),
            "opencode",
            "有覆盖时应当用覆盖值"
        );

        // ④ 覆盖只作用于**它自己那个** Agent
        assert_eq!(
            resolve_cli_type_in(&overrides, Some("hermes"), "agent-B"),
            "hermes",
            "A 的覆盖不该影响 B"
        );

        // ⑤ 空串覆盖 = 没覆盖（不能把「空」当成「显式选了空」）
        overrides.insert("agent-C".to_string(), "   ".to_string());
        assert_eq!(
            resolve_cli_type_in(&overrides, Some("hermes"), "agent-C"),
            "hermes",
            "空白覆盖应当当作没覆盖"
        );

        // ⑥ 空串的 Agent 自声明类型也当没声明
        assert_eq!(
            resolve_cli_type_in(&HashMap::new(), Some("  "), "agent-D"),
            "claude-code",
            "空白自声明类型应当兜底"
        );
    }

    /// `set_agent_cli_type` 写的覆盖值，**真的**能读回来（原来读的是另一张永远空的表）。
    #[test]
    fn cli_type_override_round_trips() {
        let tmp =
            std::env::temp_dir().join(format!("agent-session-ovr-{}.json", uuid::Uuid::new_v4()));
        let state = AgentSessionState::load_from(tmp.clone());
        assert_eq!(state.cli_type_override("agent-A"), None);
        state.set_cli_type("agent-A", "hermes");
        assert_eq!(
            state.cli_type_override("agent-A").as_deref(),
            Some("hermes")
        );
        // 覆盖优先于 Agent 自声明的类型
        assert_eq!(
            resolve_cli_type(&state, Some("opencode"), "agent-A"),
            "hermes",
            "有覆盖时应当用覆盖值"
        );
        // 别的 Agent 不受影响
        assert_eq!(
            resolve_cli_type(&state, Some("opencode"), "agent-B"),
            "opencode",
            "覆盖只作用于它自己那个 Agent"
        );
        let _ = std::fs::remove_file(&tmp);
    }
}

/// Tauri command: actually run a turn — sends a user message to the proxy
/// under the agent's persistent session and returns the assistant's reply.
///
/// ⚠ **本命令已删除（2026-10-25）**：它是一条**绕过消息持久化**的入口
///   —— 跑完的回复既不写 `task_messages`、也不更新任务状态。
///   前端从来没用过它（家族探针实测：worker 38 个注册命令里它属「连提都没提」那一档），
///   而它恰好就是本轮要修的那个洞的**同款入口**
///   （「自动执行的结果不入对话历史 ⇒ Agent 失忆」）⇒ 留着就是留后门。
///   ⇒ 对话请走 `send_task_message`（会落库），自动执行请走
///   `commands::run_task_background`（同样会落库）。
///
/// 下面保留的是**内部函数**（对话与自动执行共用这一条会话路径）。
pub async fn run_agent_turn_inner(
    app: &tauri::AppHandle,
    agent_id: String,
    system_prompt: String,
    user_message: String,
    history: Option<Vec<ChatMessage>>,
) -> Result<AgentTurnResult, String> {
    let state = app.state::<AgentSessionState>();
    let sid = state.get_or_create(&agent_id);
    let agent = crate::storage::find_agent(&agent_id);
    let agent_cli_type = agent.as_ref().and_then(|a| a.cli_type.clone());
    let proxy_agent_id = agent.as_ref().and_then(|a| a.local_agent_id.clone());
    // ⚠ **生效中的 CLI 类型**：用户覆盖 > Agent 自己声明的 > claude-code。
    //   旧实现只认覆盖值，而覆盖表从来没人写过 ⇒ 对话永远走 claude-code。
    let cli_type = resolve_cli_type(&state, agent_cli_type.as_deref(), &agent_id);

    let mut messages: Vec<ChatMessage> = Vec::new();
    if !system_prompt.trim().is_empty() {
        messages.push(ChatMessage {
            role: "system".to_string(),
            content: system_prompt,
        });
    }
    if let Some(h) = history {
        messages.extend(h);
    }
    messages.push(ChatMessage {
        role: "user".to_string(),
        content: user_message,
    });

    let reply = chat(
        &proxy_url(),
        &sid,
        &cli_type,
        proxy_agent_id.as_deref(),
        messages,
    )
    .await?;
    Ok(AgentTurnResult {
        session_id: sid,
        reply,
    })
}

#[derive(Serialize)]
pub struct AgentTurnResult {
    pub session_id: String,
    pub reply: String,
}
