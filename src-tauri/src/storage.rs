// storage.rs — SQLite-backed storage layer.
// Provides the same public API as before but delegates to db::Database.
// A global `Database` instance is initialized on first access via `get_db()`.

use std::sync::OnceLock;
use crate::db::{self, Database};
use crate::models::*;

static DB: OnceLock<Database> = OnceLock::new();

pub fn get_db() -> &'static Database {
    DB.get_or_init(|| {
        let db = Database::new().expect("failed to initialize SQLite database");
        db.migrate_from_json();
        db
    })
}

// ===== 项目 =====
pub fn read_projects() -> Vec<Project> {
    db::read_projects(get_db())
}

pub fn save_project(project: &Project) {
    db::save_project(get_db(), project);
}

pub fn remove_project(id: &str) {
    db::remove_project(get_db(), id);
}

pub fn find_project(id: &str) -> Option<Project> {
    db::find_project(get_db(), id)
}

// ===== Agent =====
pub fn read_agents_by_project(project_id: &str) -> Vec<Agent> {
    db::read_agents_by_project(get_db(), project_id)
}

pub fn save_agent(agent: &Agent) {
    db::save_agent(get_db(), agent);
}

pub fn remove_agent(id: &str) {
    db::remove_agent(get_db(), id);
}

pub fn find_agent(id: &str) -> Option<Agent> {
    db::find_agent(get_db(), id)
}

// ===== 任务 =====
pub fn read_tasks_by_project(project_id: &str) -> Vec<Task> {
    db::read_tasks_by_project(get_db(), project_id)
}

pub fn save_task(task: &Task) {
    db::save_task(get_db(), task);
}

pub fn remove_task(id: &str) {
    db::remove_task(get_db(), id);
}

pub fn find_task(id: &str) -> Option<Task> {
    db::find_task(get_db(), id)
}

// ===== 消息 =====
pub fn read_task_messages(task_id: &str) -> Vec<TaskMessage> {
    db::read_task_messages(get_db(), task_id)
}

pub fn save_task_message(message: &TaskMessage) {
    db::save_task_message(get_db(), message);
}

// ===== 配置 =====
pub fn read_config() -> AppConfig {
    db::read_config(get_db())
}

pub fn write_config(config: &AppConfig) {
    db::write_config(get_db(), config);
}

// ===== 标签 =====
pub fn read_tags_by_project(project_id: &str) -> Vec<Tag> {
    db::read_tags_by_project(get_db(), project_id)
}

pub fn save_tag(tag: &Tag) {
    db::save_tag(get_db(), tag);
}

pub fn remove_tag(id: &str) {
    db::remove_tag(get_db(), id);
}

// ===== 任务依赖 =====
pub fn get_task_dependencies(task_id: &str) -> Vec<String> {
    db::get_task_dependencies(get_db(), task_id)
}

pub fn set_task_dependencies(task_id: &str, depends_on: &[String]) {
    db::set_task_dependencies(get_db(), task_id, depends_on);
}

// ===== 文档 =====
pub fn read_documents_by_project(project_id: &str) -> Vec<ProjectDocument> {
    db::read_documents_by_project(get_db(), project_id)
}

pub fn save_document(doc: &ProjectDocument) {
    db::save_document(get_db(), doc);
}

pub fn remove_document(id: &str) {
    db::remove_document(get_db(), id);
}

pub fn find_document(id: &str) -> Option<ProjectDocument> {
    db::find_document(get_db(), id)
}

// ===== 统计 =====
pub fn get_project_stats(project_id: &str) -> ProjectStats {
    db::get_project_stats(get_db(), project_id)
}
