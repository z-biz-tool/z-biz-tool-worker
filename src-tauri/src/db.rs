use rusqlite::{params, Connection, Result as SqlResult};
use std::path::PathBuf;
use std::sync::Mutex;
use crate::models::*;

const DB_NAME: &str = "data.db";
const DATA_DIR_NAME: &str = ".z-biz-tool-worker";

pub struct Database {
    pub conn: Mutex<Connection>,
}

impl Database {
    pub fn new() -> SqlResult<Self> {
        let db_path = Self::db_path();
        if let Some(parent) = db_path.parent() {
            std::fs::create_dir_all(parent).ok();
        }
        let conn = Connection::open(&db_path)?;
        conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;")?;
        let db = Self { conn: Mutex::new(conn) };
        db.init_schema()?;
        Ok(db)
    }

    fn data_dir() -> PathBuf {
        let home = dirs::home_dir().expect("无法获取用户主目录");
        home.join(DATA_DIR_NAME)
    }

    pub fn db_path() -> PathBuf {
        Self::data_dir().join(DB_NAME)
    }

    pub fn data_dir_path() -> PathBuf {
        Self::data_dir()
    }

    fn init_schema(&self) -> SqlResult<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS projects (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                description TEXT DEFAULT '',
                icon TEXT DEFAULT '',
                color TEXT DEFAULT '#1677ff',
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS tasks (
                id TEXT PRIMARY KEY,
                project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
                parent_id TEXT REFERENCES tasks(id) ON DELETE CASCADE,
                title TEXT NOT NULL,
                description TEXT DEFAULT '',
                status TEXT NOT NULL DEFAULT 'todo',
                priority INTEGER DEFAULT 0,
                start_date TEXT,
                due_date TEXT,
                milestone INTEGER DEFAULT 0,
                assigned_agent_id TEXT,
                assigned_agent_name TEXT,
                children TEXT DEFAULT '[]',
                output TEXT,
                agent_output TEXT,
                waiting_for_input INTEGER,
                receipts TEXT,
                custom_fields TEXT DEFAULT '{}',
                tags TEXT DEFAULT '[]',
                sort_order INTEGER DEFAULT 0,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                completed_at TEXT
            );

            CREATE TABLE IF NOT EXISTS agents (
                id TEXT PRIMARY KEY,
                project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
                name TEXT NOT NULL,
                system_prompt TEXT DEFAULT '',
                model TEXT DEFAULT 'default',
                status TEXT NOT NULL DEFAULT 'idle',
                current_task_id TEXT,
                source TEXT NOT NULL DEFAULT 'manual',
                cli_type TEXT,
                local_agent_id TEXT,
                cli_version TEXT,
                cli_path TEXT,
                created_at TEXT NOT NULL,
                last_used_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS task_messages (
                id TEXT PRIMARY KEY,
                task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
                role TEXT NOT NULL,
                content TEXT NOT NULL,
                created_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS task_attachments (
                id TEXT PRIMARY KEY,
                task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
                filename TEXT NOT NULL,
                filepath TEXT NOT NULL,
                filesize INTEGER DEFAULT 0,
                mime_type TEXT DEFAULT '',
                created_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS tags (
                id TEXT PRIMARY KEY,
                project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
                name TEXT NOT NULL,
                color TEXT DEFAULT '#1677ff'
            );

            CREATE TABLE IF NOT EXISTS task_dependencies (
                task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
                depends_on_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
                PRIMARY KEY (task_id, depends_on_id)
            );

            CREATE TABLE IF NOT EXISTS project_documents (
                id TEXT PRIMARY KEY,
                project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
                title TEXT NOT NULL,
                content TEXT DEFAULT '',
                parent_id TEXT,
                sort_order INTEGER DEFAULT 0,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS workflow_templates (
                id TEXT PRIMARY KEY,
                project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
                name TEXT NOT NULL,
                description TEXT DEFAULT '',
                statuses TEXT NOT NULL DEFAULT '[]',
                created_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS config (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );"
        )?;
        Ok(())
    }

    // ===== 数据迁移: 从旧 JSON 文件迁移 =====
    pub fn migrate_from_json(&self) {
        let home = match dirs::home_dir() {
            Some(h) => h,
            None => {
                eprintln!("[db] 无法获取用户主目录, 跳过 JSON 迁移");
                return;
            }
        };
        // 保留两步迁移路径, 覆盖更老的历史目录:
        //   1. .z-agent-worker            (最初的 JSON 数据)
        //   2. .z-biz-tool-agent-worker   (上一代命名)
        // 当前 DATA_DIR_NAME (.z-biz-tool-worker) 已是 SQLite 目标, 不再需要从自身迁移
        self.migrate_from_dir(&home.join(".z-agent-worker"));
        self.migrate_from_dir(&home.join(".z-biz-tool-agent-worker"));
    }

    fn migrate_from_dir(&self, old_dir: &std::path::Path) {
        if !old_dir.exists() {
            return;
        }
        eprintln!("[db] 发现旧数据目录 {:?}, 开始迁移...", old_dir);

        // 迁移 projects
        let projects_file = old_dir.join("projects.json");
        if projects_file.exists() {
            if let Ok(content) = std::fs::read_to_string(&projects_file) {
                if let Ok(projects) = serde_json::from_str::<Vec<Project>>(&content) {
                    let conn = self.conn.lock().unwrap();
                    for p in &projects {
                        let _ = conn.execute(
                            "INSERT OR IGNORE INTO projects (id, name, description, icon, color, created_at, updated_at)
                             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                            params![p.id, p.name, p.description, p.icon, p.color, p.created_at, p.updated_at],
                        );
                    }
                    eprintln!("[db] 迁移了 {} 个项目", projects.len());
                }
            }
        }

        // 迁移 agents
        let agents_file = old_dir.join("agents.json");
        if agents_file.exists() {
            if let Ok(content) = std::fs::read_to_string(&agents_file) {
                if let Ok(agents) = serde_json::from_str::<Vec<Agent>>(&content) {
                    let conn = self.conn.lock().unwrap();
                    for a in &agents {
                        let _ = conn.execute(
                            "INSERT OR IGNORE INTO agents (id, project_id, name, system_prompt, model, status,
                             current_task_id, source, cli_type, local_agent_id, cli_version, cli_path, created_at, last_used_at)
                             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)",
                            params![a.id, a.project_id, a.name, a.system_prompt, a.model, a.status,
                                a.current_task_id, a.source, a.cli_type, a.local_agent_id, a.cli_version,
                                a.cli_path, a.created_at, a.last_used_at],
                        );
                    }
                    eprintln!("[db] 迁移了 {} 个 Agent", agents.len());
                }
            }
        }

        // 迁移 tasks
        let tasks_file = old_dir.join("tasks.json");
        if tasks_file.exists() {
            if let Ok(content) = std::fs::read_to_string(&tasks_file) {
                if let Ok(tasks) = serde_json::from_str::<Vec<Task>>(&content) {
                    let conn = self.conn.lock().unwrap();
                    for t in &tasks {
                        let children_json = serde_json::to_string(&t.children).unwrap_or_default();
                        let receipts_json = t.receipts.as_ref().map(|v| v.to_string());
                        let custom_fields_json = t.custom_fields.to_string();
                        let tags_json = serde_json::to_string(&t.tags).unwrap_or_default();
                        let _ = conn.execute(
                            "INSERT OR IGNORE INTO tasks (id, project_id, parent_id, title, description, status,
                             priority, start_date, due_date, milestone, assigned_agent_id, assigned_agent_name,
                             children, output, agent_output, waiting_for_input, receipts, custom_fields, tags,
                             sort_order, created_at, updated_at, completed_at)
                             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23)",
                            params![t.id, t.project_id, t.parent_id, t.title, t.description, t.status,
                                t.priority, t.start_date, t.due_date, t.milestone as i32, t.assigned_agent_id,
                                t.assigned_agent_name, children_json, t.output, t.agent_output,
                                t.waiting_for_input.map(|b| b as i32), receipts_json, custom_fields_json,
                                tags_json, t.sort_order, t.created_at, t.updated_at, t.completed_at],
                        );
                    }
                    eprintln!("[db] 迁移了 {} 个任务", tasks.len());
                }
            }
        }

        // 迁移 config
        let config_file = old_dir.join("config.json");
        if config_file.exists() {
            if let Ok(content) = std::fs::read_to_string(&config_file) {
                if let Ok(config) = serde_json::from_str::<AppConfig>(&content) {
                    let conn = self.conn.lock().unwrap();
                    let config_json = serde_json::to_string(&config).unwrap_or_default();
                    let _ = conn.execute(
                        "INSERT OR REPLACE INTO config (key, value) VALUES ('app_config', ?1)",
                        params![config_json],
                    );
                    eprintln!("[db] 迁移了配置");
                }
            }
        }

        // 迁移消息文件
        let messages_dir = old_dir.join("messages");
        if messages_dir.exists() {
            if let Ok(entries) = std::fs::read_dir(&messages_dir) {
                let conn = self.conn.lock().unwrap();
                let mut count = 0;
                for entry in entries.flatten() {
                    if let Some(name) = entry.file_name().to_str() {
                        if name.ends_with(".json") {
                            let _task_id = name.trim_end_matches(".json");
                            if let Ok(content) = std::fs::read_to_string(entry.path()) {
                                if let Ok(messages) = serde_json::from_str::<Vec<TaskMessage>>(&content) {
                                    for m in &messages {
                                        let _ = conn.execute(
                                            "INSERT OR IGNORE INTO task_messages (id, task_id, role, content, created_at)
                                             VALUES (?1, ?2, ?3, ?4, ?5)",
                                            params![m.id, m.task_id, m.role, m.content, m.created_at],
                                        );
                                        count += 1;
                                    }
                                }
                            }
                        }
                    }
                }
                eprintln!("[db] 迁移了 {} 条消息", count);
            }
        }

        eprintln!("[db] {:?} 数据迁移完成", old_dir);
    }
}

// ===== 项目 CRUD =====
pub fn read_projects(db: &Database) -> Vec<Project> {
    let conn = db.conn.lock().unwrap();
    let mut stmt = conn
        .prepare("SELECT id, name, description, icon, color, created_at, updated_at FROM projects ORDER BY updated_at DESC")
        .unwrap();
    stmt.query_map([], |row| {
        Ok(Project {
            id: row.get(0)?,
            name: row.get(1)?,
            description: row.get(2)?,
            icon: row.get(3)?,
            color: row.get(4)?,
            created_at: row.get(5)?,
            updated_at: row.get(6)?,
        })
    })
    .unwrap()
    .filter_map(|r| r.ok())
    .collect()
}

pub fn save_project(db: &Database, project: &Project) {
    let conn = db.conn.lock().unwrap();
    // 不能写 INSERT OR REPLACE：外键开启时它先删冲突行再插，
    // ON DELETE CASCADE 会把该项目的 tasks/agents 一起删掉。
    let _ = conn.execute(
        "INSERT INTO projects (id, name, description, icon, color, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name,
           description = excluded.description,
           icon = excluded.icon,
           color = excluded.color,
           created_at = excluded.created_at,
           updated_at = excluded.updated_at",
        params![project.id, project.name, project.description, project.icon, project.color, project.created_at, project.updated_at],
    );
}

/// 原地改 name/updated_at：id 与 created_at 不动，指向该项目的任务/Agent 不受影响。
pub fn rename_project(db: &Database, id: &str, name: &str, now: &str) -> Result<Project, String> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err("项目名称不能为空".to_string());
    }
    find_project(db, id).ok_or("项目不存在")?;
    let duplicated = read_projects(db)
        .into_iter()
        .any(|p| p.id != id && p.name.trim().to_lowercase() == trimmed.to_lowercase());
    if duplicated {
        return Err("已存在同名项目".to_string());
    }
    let conn = db.conn.lock().unwrap();
    conn.execute(
        "UPDATE projects SET name = ?1, updated_at = ?2 WHERE id = ?3",
        params![trimmed, now, id],
    )
    .map_err(|e| format!("重命名项目失败: {}", e))?;
    drop(conn);
    find_project(db, id).ok_or("重命名后项目读取失败".to_string())
}

pub fn remove_project(db: &Database, id: &str) {
    let conn = db.conn.lock().unwrap();
    let _ = conn.execute("DELETE FROM projects WHERE id = ?1", params![id]);
}

pub fn find_project(db: &Database, id: &str) -> Option<Project> {
    let conn = db.conn.lock().unwrap();
    conn.query_row(
        "SELECT id, name, description, icon, color, created_at, updated_at FROM projects WHERE id = ?1",
        params![id],
        |row| {
            Ok(Project {
                id: row.get(0)?,
                name: row.get(1)?,
                description: row.get(2)?,
                icon: row.get(3)?,
                color: row.get(4)?,
                created_at: row.get(5)?,
                updated_at: row.get(6)?,
            })
        },
    )
    .ok()
}

// ===== Agent CRUD =====
pub fn read_agents_by_project(db: &Database, project_id: &str) -> Vec<Agent> {
    let conn = db.conn.lock().unwrap();
    let mut stmt = conn
        .prepare("SELECT id, project_id, name, system_prompt, model, status, current_task_id,
                  source, cli_type, local_agent_id, cli_version, cli_path, created_at, last_used_at
                  FROM agents WHERE project_id = ?1 ORDER BY created_at")
        .unwrap();
    stmt.query_map(params![project_id], |row| {
        Ok(Agent {
            id: row.get(0)?,
            project_id: row.get(1)?,
            name: row.get(2)?,
            system_prompt: row.get(3)?,
            model: row.get(4)?,
            status: row.get(5)?,
            current_task_id: row.get(6)?,
            source: row.get(7)?,
            cli_type: row.get(8)?,
            local_agent_id: row.get(9)?,
            cli_version: row.get(10)?,
            cli_path: row.get(11)?,
            created_at: row.get(12)?,
            last_used_at: row.get(13)?,
        })
    })
    .unwrap()
    .filter_map(|r| r.ok())
    .collect()
}

pub fn save_agent(db: &Database, agent: &Agent) {
    let conn = db.conn.lock().unwrap();
    let _ = conn.execute(
        "INSERT OR REPLACE INTO agents (id, project_id, name, system_prompt, model, status,
         current_task_id, source, cli_type, local_agent_id, cli_version, cli_path, created_at, last_used_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)",
        params![agent.id, agent.project_id, agent.name, agent.system_prompt, agent.model,
            agent.status, agent.current_task_id, agent.source, agent.cli_type, agent.local_agent_id,
            agent.cli_version, agent.cli_path, agent.created_at, agent.last_used_at],
    );
}

pub fn remove_agent(db: &Database, id: &str) {
    let conn = db.conn.lock().unwrap();
    let _ = conn.execute("DELETE FROM agents WHERE id = ?1", params![id]);
}

pub fn find_agent(db: &Database, id: &str) -> Option<Agent> {
    let conn = db.conn.lock().unwrap();
    conn.query_row(
        "SELECT id, project_id, name, system_prompt, model, status, current_task_id,
         source, cli_type, local_agent_id, cli_version, cli_path, created_at, last_used_at
         FROM agents WHERE id = ?1",
        params![id],
        |row| {
            Ok(Agent {
                id: row.get(0)?,
                project_id: row.get(1)?,
                name: row.get(2)?,
                system_prompt: row.get(3)?,
                model: row.get(4)?,
                status: row.get(5)?,
                current_task_id: row.get(6)?,
                source: row.get(7)?,
                cli_type: row.get(8)?,
                local_agent_id: row.get(9)?,
                cli_version: row.get(10)?,
                cli_path: row.get(11)?,
                created_at: row.get(12)?,
                last_used_at: row.get(13)?,
            })
        },
    )
    .ok()
}

// ===== 任务 CRUD =====

pub fn read_tasks_by_project(db: &Database, project_id: &str) -> Vec<Task> {
    let conn = db.conn.lock().unwrap();
    let mut stmt = conn
        .prepare("SELECT id, project_id, parent_id, title, description, status, priority,
                  start_date, due_date, milestone, assigned_agent_id, assigned_agent_name,
                  children, output, agent_output, waiting_for_input, receipts, custom_fields,
                  tags, sort_order, created_at, updated_at, completed_at
                  FROM tasks WHERE project_id = ?1 ORDER BY sort_order, created_at")
        .unwrap();
    stmt.query_map(params![project_id], |row| {
        let children_str: String = row.get(12)?;
        let children: Vec<String> = serde_json::from_str(&children_str).unwrap_or_default();
        let receipts_str: Option<String> = row.get(16)?;
        let receipts = receipts_str.and_then(|s| serde_json::from_str(&s).ok());
        let custom_fields_str: String = row.get(17)?;
        let custom_fields: serde_json::Value = serde_json::from_str(&custom_fields_str).unwrap_or(serde_json::json!({}));
        let tags_str: String = row.get(18)?;
        let tags: Vec<String> = serde_json::from_str(&tags_str).unwrap_or_default();
        let milestone_int: i32 = row.get(9)?;

        Ok(Task {
            id: row.get(0)?,
            project_id: row.get(1)?,
            parent_id: row.get(2)?,
            title: row.get(3)?,
            description: row.get(4)?,
            status: row.get(5)?,
            priority: row.get(6)?,
            start_date: row.get(7)?,
            due_date: row.get(8)?,
            milestone: milestone_int != 0,
            assigned_agent_id: row.get(10)?,
            assigned_agent_name: row.get(11)?,
            children,
            output: row.get(13)?,
            agent_output: row.get(14)?,
            waiting_for_input: row.get::<_, Option<i32>>(15)?.map(|v| v != 0),
            receipts,
            custom_fields,
            tags,
            sort_order: row.get(19)?,
            created_at: row.get(20)?,
            updated_at: row.get(21)?,
            completed_at: row.get(22)?,
        })
    })
    .unwrap()
    .filter_map(|r| r.ok())
    .collect()
}

pub fn save_task(db: &Database, task: &Task) {
    let conn = db.conn.lock().unwrap();
    let children_json = serde_json::to_string(&task.children).unwrap_or_default();
    let receipts_json = task.receipts.as_ref().map(|v| v.to_string());
    let custom_fields_json = task.custom_fields.to_string();
    let tags_json = serde_json::to_string(&task.tags).unwrap_or_default();

    let _ = conn.execute(
        // 同 save_project：INSERT OR REPLACE 会先删行，tasks 名下挂着 task_messages /
        // task_attachments / task_dependencies / 子任务，全都 ON DELETE CASCADE，
        // 于是"改一下状态"就把这条任务的来龙去脉连带子任务一起删了。
        "INSERT INTO tasks (id, project_id, parent_id, title, description, status,
         priority, start_date, due_date, milestone, assigned_agent_id, assigned_agent_name,
         children, output, agent_output, waiting_for_input, receipts, custom_fields, tags,
         sort_order, created_at, updated_at, completed_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23)
         ON CONFLICT(id) DO UPDATE SET
           project_id = excluded.project_id,
           parent_id = excluded.parent_id,
           title = excluded.title,
           description = excluded.description,
           status = excluded.status,
           priority = excluded.priority,
           start_date = excluded.start_date,
           due_date = excluded.due_date,
           milestone = excluded.milestone,
           assigned_agent_id = excluded.assigned_agent_id,
           assigned_agent_name = excluded.assigned_agent_name,
           children = excluded.children,
           output = excluded.output,
           agent_output = excluded.agent_output,
           waiting_for_input = excluded.waiting_for_input,
           receipts = excluded.receipts,
           custom_fields = excluded.custom_fields,
           tags = excluded.tags,
           sort_order = excluded.sort_order,
           updated_at = excluded.updated_at,
           completed_at = excluded.completed_at",
        params![
            task.id, task.project_id, task.parent_id, task.title, task.description, task.status,
            task.priority, task.start_date, task.due_date, task.milestone as i32, task.assigned_agent_id,
            task.assigned_agent_name, children_json, task.output, task.agent_output,
            task.waiting_for_input.map(|b| b as i32), receipts_json, custom_fields_json,
            tags_json, task.sort_order, task.created_at, task.updated_at, task.completed_at
        ],
    );
}

pub fn remove_task(db: &Database, id: &str) {
    let conn = db.conn.lock().unwrap();
    // 删除子任务
    let child_ids: Vec<String> = {
        let mut stmt = conn.prepare("SELECT id FROM tasks WHERE parent_id = ?1").unwrap();
        stmt.query_map(params![id], |row| row.get(0))
            .unwrap()
            .filter_map(|r| r.ok())
            .collect()
    };
    for cid in &child_ids {
        remove_task(db, cid);
    }
    let _ = conn.execute("DELETE FROM tasks WHERE id = ?1", params![id]);
}

pub fn find_task(db: &Database, id: &str) -> Option<Task> {
    let conn = db.conn.lock().unwrap();
    conn.query_row(
        "SELECT id, project_id, parent_id, title, description, status, priority,
         start_date, due_date, milestone, assigned_agent_id, assigned_agent_name,
         children, output, agent_output, waiting_for_input, receipts, custom_fields,
         tags, sort_order, created_at, updated_at, completed_at
         FROM tasks WHERE id = ?1",
        params![id],
        |row| {
            let children_str: String = row.get(12)?;
            let children: Vec<String> = serde_json::from_str(&children_str).unwrap_or_default();
            let receipts_str: Option<String> = row.get(16)?;
            let receipts = receipts_str.and_then(|s| serde_json::from_str(&s).ok());
            let custom_fields_str: String = row.get(17)?;
            let custom_fields: serde_json::Value = serde_json::from_str(&custom_fields_str).unwrap_or(serde_json::json!({}));
            let tags_str: String = row.get(18)?;
            let tags: Vec<String> = serde_json::from_str(&tags_str).unwrap_or_default();
            let milestone_int: i32 = row.get(9)?;

            Ok(Task {
                id: row.get(0)?,
                project_id: row.get(1)?,
                parent_id: row.get(2)?,
                title: row.get(3)?,
                description: row.get(4)?,
                status: row.get(5)?,
                priority: row.get(6)?,
                start_date: row.get(7)?,
                due_date: row.get(8)?,
                milestone: milestone_int != 0,
                assigned_agent_id: row.get(10)?,
                assigned_agent_name: row.get(11)?,
                children,
                output: row.get(13)?,
                agent_output: row.get(14)?,
                waiting_for_input: row.get::<_, Option<i32>>(15)?.map(|v| v != 0),
                receipts,
                custom_fields,
                tags,
                sort_order: row.get(19)?,
                created_at: row.get(20)?,
                updated_at: row.get(21)?,
                completed_at: row.get(22)?,
            })
        },
    )
    .ok()
}

// ===== 消息 CRUD =====
pub fn read_task_messages(db: &Database, task_id: &str) -> Vec<TaskMessage> {
    let conn = db.conn.lock().unwrap();
    let mut stmt = conn
        .prepare("SELECT id, task_id, role, content, created_at FROM task_messages WHERE task_id = ?1 ORDER BY created_at")
        .unwrap();
    stmt.query_map(params![task_id], |row| {
        Ok(TaskMessage {
            id: row.get(0)?,
            task_id: row.get(1)?,
            role: row.get(2)?,
            content: row.get(3)?,
            created_at: row.get(4)?,
        })
    })
    .unwrap()
    .filter_map(|r| r.ok())
    .collect()
}

pub fn save_task_message(db: &Database, message: &TaskMessage) {
    let conn = db.conn.lock().unwrap();
    let _ = conn.execute(
        "INSERT INTO task_messages (id, task_id, role, content, created_at) VALUES (?1, ?2, ?3, ?4, ?5)",
        params![message.id, message.task_id, message.role, message.content, message.created_at],
    );
}

// ===== 配置 CRUD =====
pub fn read_config(db: &Database) -> AppConfig {
    let conn = db.conn.lock().unwrap();
    let result: Result<String, _> = conn.query_row(
        "SELECT value FROM config WHERE key = 'app_config'",
        [],
        |row| row.get(0),
    );
    match result {
        Ok(json) => serde_json::from_str(&json).unwrap_or_default(),
        Err(_) => AppConfig::default(),
    }
}

pub fn write_config(db: &Database, config: &AppConfig) {
    let conn = db.conn.lock().unwrap();
    let json = serde_json::to_string(config).unwrap_or_default();
    let _ = conn.execute(
        "INSERT OR REPLACE INTO config (key, value) VALUES ('app_config', ?1)",
        params![json],
    );
}

// ===== 标签 CRUD =====
pub fn read_tags_by_project(db: &Database, project_id: &str) -> Vec<Tag> {
    let conn = db.conn.lock().unwrap();
    let mut stmt = conn
        .prepare("SELECT id, project_id, name, color FROM tags WHERE project_id = ?1 ORDER BY name")
        .unwrap();
    stmt.query_map(params![project_id], |row| {
        Ok(Tag {
            id: row.get(0)?,
            project_id: row.get(1)?,
            name: row.get(2)?,
            color: row.get(3)?,
        })
    })
    .unwrap()
    .filter_map(|r| r.ok())
    .collect()
}

pub fn save_tag(db: &Database, tag: &Tag) {
    let conn = db.conn.lock().unwrap();
    let _ = conn.execute(
        "INSERT OR REPLACE INTO tags (id, project_id, name, color) VALUES (?1, ?2, ?3, ?4)",
        params![tag.id, tag.project_id, tag.name, tag.color],
    );
}

pub fn remove_tag(db: &Database, id: &str) {
    let conn = db.conn.lock().unwrap();
    let _ = conn.execute("DELETE FROM tags WHERE id = ?1", params![id]);
}

// ===== 任务依赖 CRUD =====
pub fn get_task_dependencies(db: &Database, task_id: &str) -> Vec<String> {
    let conn = db.conn.lock().unwrap();
    let mut stmt = conn
        .prepare("SELECT depends_on_id FROM task_dependencies WHERE task_id = ?1")
        .unwrap();
    stmt.query_map(params![task_id], |row| row.get(0))
        .unwrap()
        .filter_map(|r| r.ok())
        .collect()
}

pub fn set_task_dependencies(db: &Database, task_id: &str, depends_on: &[String]) {
    let conn = db.conn.lock().unwrap();
    let _ = conn.execute("DELETE FROM task_dependencies WHERE task_id = ?1", params![task_id]);
    for dep_id in depends_on {
        let _ = conn.execute(
            "INSERT INTO task_dependencies (task_id, depends_on_id) VALUES (?1, ?2)",
            params![task_id, dep_id],
        );
    }
}

// ===== 文档 CRUD =====
pub fn read_documents_by_project(db: &Database, project_id: &str) -> Vec<ProjectDocument> {
    let conn = db.conn.lock().unwrap();
    let mut stmt = conn
        .prepare("SELECT id, project_id, title, content, parent_id, sort_order, created_at, updated_at
                  FROM project_documents WHERE project_id = ?1 ORDER BY sort_order, created_at")
        .unwrap();
    stmt.query_map(params![project_id], |row| {
        Ok(ProjectDocument {
            id: row.get(0)?,
            project_id: row.get(1)?,
            title: row.get(2)?,
            content: row.get(3)?,
            parent_id: row.get(4)?,
            sort_order: row.get(5)?,
            created_at: row.get(6)?,
            updated_at: row.get(7)?,
        })
    })
    .unwrap()
    .filter_map(|r| r.ok())
    .collect()
}

pub fn save_document(db: &Database, doc: &ProjectDocument) {
    let conn = db.conn.lock().unwrap();
    let _ = conn.execute(
        "INSERT OR REPLACE INTO project_documents (id, project_id, title, content, parent_id, sort_order, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        params![doc.id, doc.project_id, doc.title, doc.content, doc.parent_id, doc.sort_order, doc.created_at, doc.updated_at],
    );
}

pub fn remove_document(db: &Database, id: &str) {
    let conn = db.conn.lock().unwrap();
    let _ = conn.execute("DELETE FROM project_documents WHERE id = ?1", params![id]);
}

pub fn find_document(db: &Database, id: &str) -> Option<ProjectDocument> {
    let conn = db.conn.lock().unwrap();
    conn.query_row(
        "SELECT id, project_id, title, content, parent_id, sort_order, created_at, updated_at
         FROM project_documents WHERE id = ?1",
        params![id],
        |row| {
            Ok(ProjectDocument {
                id: row.get(0)?,
                project_id: row.get(1)?,
                title: row.get(2)?,
                content: row.get(3)?,
                parent_id: row.get(4)?,
                sort_order: row.get(5)?,
                created_at: row.get(6)?,
                updated_at: row.get(7)?,
            })
        },
    )
    .ok()
}

// ===== 统计 =====
pub fn get_project_stats(db: &Database, project_id: &str) -> ProjectStats {
    let conn = db.conn.lock().unwrap();
    let tasks: Vec<String> = {
        let mut stmt = conn.prepare("SELECT status FROM tasks WHERE project_id = ?1").unwrap();
        stmt.query_map(params![project_id], |row| row.get(0))
            .unwrap()
            .filter_map(|r| r.ok())
            .collect()
    };
    let agents: Vec<String> = {
        let mut stmt = conn.prepare("SELECT status FROM agents WHERE project_id = ?1").unwrap();
        stmt.query_map(params![project_id], |row| row.get(0))
            .unwrap()
            .filter_map(|r| r.ok())
            .collect()
    };

    ProjectStats {
        tasks: TaskStats {
            total: tasks.len() as i32,
            todo: tasks.iter().filter(|s| s.as_str() == "todo").count() as i32,
            doing: tasks.iter().filter(|s| s.as_str() == "doing").count() as i32,
            waiting: tasks.iter().filter(|s| s.as_str() == "waiting").count() as i32,
            review: tasks.iter().filter(|s| s.as_str() == "review").count() as i32,
            done: tasks.iter().filter(|s| s.as_str() == "done").count() as i32,
        },
        agents: AgentStats {
            total: agents.len() as i32,
            working: agents.iter().filter(|s| s.as_str() == "working").count() as i32,
            idle: agents.iter().filter(|s| s.as_str() == "idle").count() as i32,
            offline: agents.iter().filter(|s| s.as_str() == "offline").count() as i32,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn memory_db() -> Database {
        let conn = Connection::open_in_memory().expect("in-memory sqlite");
        conn.execute_batch("PRAGMA foreign_keys=ON;").expect("pragma");
        let db = Database { conn: Mutex::new(conn) };
        db.init_schema().expect("schema");
        db
    }

    fn insert_project(db: &Database, id: &str, name: &str) {
        let conn = db.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO projects (id, name, description, icon, color, created_at, updated_at)
             VALUES (?1, ?2, '', '', '#1677ff', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')",
            params![id, name],
        )
        .unwrap();
    }

    fn insert_task(db: &Database, id: &str, project_id: &str) {
        let conn = db.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO tasks (id, project_id, title, status, created_at, updated_at)
             VALUES (?1, ?2, ?3, 'todo', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')",
            params![id, project_id, format!("task {}", id)],
        )
        .unwrap();
    }

    fn task_count(db: &Database, project_id: &str) -> i64 {
        let conn = db.conn.lock().unwrap();
        conn.query_row(
            "SELECT COUNT(*) FROM tasks WHERE project_id = ?1",
            params![project_id],
            |r| r.get(0),
        )
        .unwrap()
    }

    #[test]
    fn rename_project_keeps_id_and_children() {
        let db = memory_db();
        insert_project(&db, "p1", "旧名字");
        insert_task(&db, "t1", "p1");

        let renamed = rename_project(&db, "p1", "  新名字  ", "2026-02-02T00:00:00Z").unwrap();

        assert_eq!(renamed.id, "p1");
        assert_eq!(renamed.name, "新名字");
        assert_eq!(renamed.created_at, "2026-01-01T00:00:00Z");
        assert_eq!(renamed.updated_at, "2026-02-02T00:00:00Z");
        // 关键：改名不能因为 OR REPLACE 的级联把子表带走
        assert_eq!(task_count(&db, "p1"), 1);
    }

    #[test]
    fn rename_project_rejects_blank_missing_and_duplicate() {
        let db = memory_db();
        insert_project(&db, "p1", "甲项目");
        insert_project(&db, "p2", "乙项目");

        assert!(rename_project(&db, "p1", "   ", "2026-02-02T00:00:00Z").is_err());
        assert!(rename_project(&db, "nope", "新名字", "2026-02-02T00:00:00Z").is_err());
        assert!(rename_project(&db, "p1", " 乙项目 ", "2026-02-02T00:00:00Z").is_err());
        // 只改大小写空格、名字没变的情况不该被查重拦住
        assert!(rename_project(&db, "p1", "甲项目", "2026-02-02T00:00:00Z").is_ok());
    }

    #[test]
    fn save_project_upsert_does_not_cascade_children() {
        let db = memory_db();
        let mut p = Project {
            id: "p1".to_string(),
            name: "甲".to_string(),
            description: String::new(),
            icon: String::new(),
            color: "#1677ff".to_string(),
            created_at: "2026-01-01T00:00:00Z".to_string(),
            updated_at: "2026-01-01T00:00:00Z".to_string(),
        };
        save_project(&db, &p);
        insert_task(&db, "t1", "p1");

        p.name = "乙".to_string();
        p.updated_at = "2026-03-03T00:00:00Z".to_string();
        save_project(&db, &p);

        assert_eq!(find_project(&db, "p1").unwrap().name, "乙");
        assert_eq!(task_count(&db, "p1"), 1);
    }

    #[test]
    fn save_task_upsert_keeps_messages_attachments_and_subtasks() {
        let db = memory_db();
        insert_project(&db, "p1", "项目");
        insert_task(&db, "t1", "p1");
        insert_task(&db, "t2", "p1");
        {
            let conn = db.conn.lock().unwrap();
            conn.execute("UPDATE tasks SET parent_id = 't1' WHERE id = 't2'", [])
                .unwrap();
            conn.execute(
                "INSERT INTO task_messages (id, task_id, role, content, created_at)
                 VALUES ('m1', 't1', 'user', '来龙去脉', '2026-01-01T00:00:00Z')",
                [],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO task_attachments (id, task_id, filename, filepath, created_at)
                 VALUES ('a1', 't1', 'f.txt', '/tmp/f.txt', '2026-01-01T00:00:00Z')",
                [],
            )
            .unwrap();
        }

        let mut task = find_task(&db, "t1").expect("t1 exists");
        task.status = "doing".to_string();
        save_task(&db, &task);

        let conn = db.conn.lock().unwrap();
        let count = |sql: &str| -> i64 { conn.query_row(sql, [], |r| r.get(0)).unwrap() };
        assert_eq!(count("SELECT COUNT(*) FROM task_messages WHERE task_id='t1'"), 1);
        assert_eq!(count("SELECT COUNT(*) FROM task_attachments WHERE task_id='t1'"), 1);
        assert_eq!(count("SELECT COUNT(*) FROM tasks WHERE parent_id='t1'"), 1);
        drop(conn);

        let saved = find_task(&db, "t1").expect("t1 survives its own save");
        assert_eq!(saved.status, "doing");
        assert_eq!(saved.created_at, "2026-01-01T00:00:00Z");
    }
}
