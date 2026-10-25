mod agent_proxy;
mod agent_runner;
mod agent_session;
mod commands;
mod db;
mod models;
mod storage;
mod task_state;

use std::sync::Mutex;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_dialog::init())
        // Owned by the app so the event loop can find it on shutdown.
        .manage(agent_proxy::AgentProxyHandle(Mutex::new(None)))
        // Agent -> proxy session mapping. Survives across launches.
        .manage(agent_session::AgentSessionState::load())
        .invoke_handler(tauri::generate_handler![
            commands::list_projects,
            commands::create_project,
            commands::rename_project,
            commands::delete_project,
            commands::get_project_stats,
            commands::list_agents,
            commands::create_agent,
            commands::delete_agent,
            commands::clone_agent,
            commands::discover_local_agents,
            commands::import_local_agent,
            commands::list_tasks,
            commands::create_task,
            commands::delete_task,
            commands::assign_task,
            commands::retry_task,
            commands::review_task,
            commands::update_task_status,
            commands::update_task,
            commands::batch_update_tasks,
            commands::get_agent_status,
            commands::send_task_message,
            commands::get_task_messages,
            commands::get_config,
            commands::save_config,
            commands::list_tags,
            commands::create_tag,
            commands::delete_tag,
            commands::get_task_dependencies,
            commands::set_task_dependencies,
            commands::list_documents,
            commands::create_document,
            commands::update_document,
            commands::delete_document,
            agent_session::get_agent_session,
            agent_session::set_agent_cli_type,
            agent_session::list_agent_sessions,
            agent_session::run_agent_turn,
        ])
        .setup(|app| {
            match agent_proxy::spawn() {
                Ok(child) => {
                    let state = app.state::<agent_proxy::AgentProxyHandle>();
                    *state.0.lock().expect("agent-proxy mutex poisoned") = Some(child);
                }
                Err(e) => {
                    // Don't block app startup — the rest of the UI works fine
                    // without the proxy. The user can see the error in stderr.
                    eprintln!("[agent-proxy] failed to start: {}", e);
                }
            }
            Ok(())
        })
        // 单窗口应用：关窗即退出。macOS 上默认关窗只隐藏窗口、应用驻留 Dock，
        // 那条路径上 RunEvent::Exit 不触发，agent-proxy 和它拉起的 CLI
        // 会继续跑、继续烧 token。exit(0) 会正常走完事件循环并触发
        // RunEvent::Exit，那里负责杀进程组。
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { .. } = event {
                window.app_handle().exit(0);
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|app_handle, event| {
        if let tauri::RunEvent::Exit = event {
            // Detach the Child from the State before calling kill — the
            // MutexGuard borrows from `state` which itself borrows from
            // `app_handle`, so we must release the lock while the borrow
            // chain is still in scope.
            let child_opt = {
                let state = app_handle.state::<agent_proxy::AgentProxyHandle>();
                let mut guard = state.0.lock().expect("agent-proxy mutex poisoned");
                let taken = guard.take();
                drop(guard);
                taken
            };
            if let Some(mut child) = child_opt {
                eprintln!("[agent-proxy] shutting down child process");
                agent_proxy::kill(&mut child);
            }
        }
    });
}
