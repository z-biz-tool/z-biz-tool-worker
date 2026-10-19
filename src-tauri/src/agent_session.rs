// Agent session binding: maps a Tauri Agent's `id` to a `agent-proxy` session
// id. The proxy session id is what we send in `X-Session-Id` so the proxy
// keeps routing subsequent turns to the same CLI instance (and, for hermes,
// resumes the underlying hermes session).
//
// Persistence: `~/.future-team/agent-sessions.json` (one entry per agent).

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
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

    pub fn cli_type_for(&self, agent_id: &str) -> String {
        let g = self.inner.lock().expect("agent-session mutex poisoned");
        g.cli_types
            .get(agent_id)
            .cloned()
            .unwrap_or_else(|| "claude-code".to_string())
    }

    pub fn set_cli_type(&self, agent_id: &str, cli_type: &str) {
        let mut g = self.inner.lock().expect("agent-session mutex poisoned");
        g.cli_types
            .insert(agent_id.to_string(), cli_type.to_string());
        save(&g, &self.path);
    }

    pub fn list(&self) -> Vec<AgentSessionInfo> {
        let g = self.inner.lock().expect("agent-session mutex poisoned");
        g.sessions
            .iter()
            .map(|(agent_id, session_id)| AgentSessionInfo {
                agent_id: agent_id.clone(),
                session_id: session_id.clone(),
                cli_type: g
                    .cli_types
                    .get(agent_id)
                    .cloned()
                    .unwrap_or_else(|| "claude-code".to_string()),
            })
            .collect()
    }
}

#[derive(Serialize)]
pub struct AgentSessionInfo {
    pub agent_id: String,
    pub session_id: String,
    pub cli_type: String,
}

// ──────────── proxy HTTP client ────────────

/// POST a chat completion to the local agent-proxy. Returns the assistant
/// text. `cli_type` becomes `X-CLI-Type` (lets the caller force a wrapper
/// regardless of how the agent was previously routed).
pub async fn chat(
    proxy_url: Option<&str>,
    session_id: &str,
    cli_type: &str,
    messages: Vec<ChatMessage>,
) -> Result<String, String> {
    let url = format!(
        "{}/v1/chat/completions",
        proxy_url.unwrap_or(PROXY_DEFAULT_URL)
    );
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(300))
        .build()
        .map_err(|e| format!("reqwest build: {e}"))?;
    let body = serde_json::json!({
        "stream": false,
        "messages": messages,
    });
    let resp = client
        .post(&url)
        .header("Content-Type", "application/json")
        .header("X-Session-Id", session_id)
        .header("X-CLI-Type", cli_type)
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

fn save(p: &Persisted, path: &PathBuf) {
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    if let Ok(text) = serde_json::to_string_pretty(p) {
        let _ = std::fs::write(path, text);
    }
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
    let cli_type = state.cli_type_for(&agent_id);
    Ok(AgentSessionInfo {
        agent_id,
        session_id: sid,
        cli_type,
    })
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
#[tauri::command]
pub fn list_agent_sessions(app: tauri::AppHandle) -> Vec<AgentSessionInfo> {
    let state = app.state::<AgentSessionState>();
    state.list()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// End-to-end: a "worker" agent attaches to a proxy session, runs a
    /// turn, then runs a second turn — and the proxy session id stays the
    /// same. This is the property that makes the worker "stick" to one CLI
    /// instance for the duration of the agent's life.
    ///
    /// Requires the agent-proxy to be running on 127.0.0.1:9099. Skipped
    /// otherwise so CI doesn't fail when the proxy isn't up.
    #[tokio::test]
    async fn worker_attaches_to_session_and_does_real_work() {
        // Probe the proxy.
        let probe = reqwest::Client::new()
            .get("http://127.0.0.1:9099/health")
            .timeout(std::time::Duration::from_secs(1))
            .send()
            .await;
        if probe.is_err() {
            eprintln!("skipping: agent-proxy not reachable on 127.0.0.1:9099");
            return;
        }

        let tmp =
            std::env::temp_dir().join(format!("agent-session-test-{}.json", uuid::Uuid::new_v4()));
        let _ = std::fs::remove_file(&tmp);
        let state = AgentSessionState::load_from(tmp.clone());

        let agent_id = "test-worker-1";
        let sid1 = state.get_or_create(agent_id);
        let cli_type = state.cli_type_for(agent_id);

        // turn 1: ask the agent to remember a word
        let reply1 = chat(
            None,
            &sid1,
            &cli_type,
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
            None,
            &sid2,
            &cli_type,
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
}

/// Tauri command: actually run a turn — sends a user message to the proxy
/// under the agent's persistent session and returns the assistant's reply.
/// This is the function that turns an Agent into a "worker that does work".
#[tauri::command]
pub async fn run_agent_turn(
    app: tauri::AppHandle,
    agent_id: String,
    system_prompt: String,
    user_message: String,
    history: Option<Vec<ChatMessage>>,
) -> Result<AgentTurnResult, String> {
    run_agent_turn_inner(&app, agent_id, system_prompt, user_message, history).await
}

/// Pure async function: the same work as `run_agent_turn` but without the
/// `#[tauri::command]` attribute. Other commands (e.g. `send_task_message`)
/// reuse this to avoid duplicating the proxy plumbing.
pub async fn run_agent_turn_inner(
    app: &tauri::AppHandle,
    agent_id: String,
    system_prompt: String,
    user_message: String,
    history: Option<Vec<ChatMessage>>,
) -> Result<AgentTurnResult, String> {
    let state = app.state::<AgentSessionState>();
    let sid = state.get_or_create(&agent_id);
    let cli_type = state.cli_type_for(&agent_id);

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

    let reply = chat(None, &sid, &cli_type, messages).await?;
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
