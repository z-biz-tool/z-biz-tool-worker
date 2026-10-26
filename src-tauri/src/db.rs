use crate::models::*;
use rusqlite::{params, Connection, Result as SqlResult};
use std::path::PathBuf;
use std::sync::Mutex;

const DB_NAME: &str = "data.db";
const DATA_DIR_NAME: &str = ".z-biz-tool-worker";

/// 把文件/目录权限收窄到指定 mode（仅 Unix 生效）。
/// 失败静默：权限加固是纵深防御，不能因此让应用起不来。
#[cfg(unix)]
fn restrict_mode(path: &std::path::Path, mode: u32) {
    use std::os::unix::fs::PermissionsExt;
    if let Ok(meta) = std::fs::metadata(path) {
        let mut perms = meta.permissions();
        if perms.mode() & 0o777 != mode {
            perms.set_mode(mode);
            let _ = std::fs::set_permissions(path, perms);
        }
    }
}

#[cfg(not(unix))]
fn restrict_mode(_path: &std::path::Path, _mode: u32) {}

pub struct Database {
    pub conn: Mutex<Connection>,
}

impl Database {
    pub fn new() -> SqlResult<Self> {
        let db_path = Self::db_path();
        if let Some(parent) = db_path.parent() {
            std::fs::create_dir_all(parent).ok();
            // 数据目录只给当前用户。库里的 agents.system_prompt 是**明文**
            // （见 db.rs 里 system_prompt TEXT DEFAULT ''），同机其他用户
            // 不该有读的机会。
            restrict_mode(parent, 0o700);
        }
        let conn = Connection::open(&db_path)?;
        restrict_mode(&db_path, 0o600);
        conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;")?;
        // WAL/SHM 是主库的明文副本，同样收口。文件是懒创建的，尽力而为。
        restrict_mode(&db_path.with_extension("db-wal"), 0o600);
        restrict_mode(&db_path.with_extension("db-shm"), 0o600);
        let db = Self {
            conn: Mutex::new(conn),
        };
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
            );",
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
                                if let Ok(messages) =
                                    serde_json::from_str::<Vec<TaskMessage>>(&content)
                                {
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
        params![
            project.id,
            project.name,
            project.description,
            project.icon,
            project.color,
            project.created_at,
            project.updated_at
        ],
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
        .prepare(
            "SELECT id, project_id, name, system_prompt, model, status, current_task_id,
                  source, cli_type, local_agent_id, cli_version, cli_path, created_at, last_used_at
                  FROM agents WHERE project_id = ?1 ORDER BY created_at",
        )
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
        .prepare(
            "SELECT id, project_id, parent_id, title, description, status, priority,
                  start_date, due_date, milestone, assigned_agent_id, assigned_agent_name,
                  children, output, agent_output, waiting_for_input, receipts, custom_fields,
                  tags, sort_order, created_at, updated_at, completed_at
                  FROM tasks WHERE project_id = ?1 ORDER BY sort_order, created_at",
        )
        .unwrap();
    stmt.query_map(params![project_id], |row| {
        let children_str: String = row.get(12)?;
        let children: Vec<String> = serde_json::from_str(&children_str).unwrap_or_default();
        let receipts_str: Option<String> = row.get(16)?;
        let receipts = receipts_str.and_then(|s| serde_json::from_str(&s).ok());
        let custom_fields_str: String = row.get(17)?;
        let custom_fields: serde_json::Value =
            serde_json::from_str(&custom_fields_str).unwrap_or(serde_json::json!({}));
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

/// **条件认领**任务：只在任务仍处于 `expected_status` 且尚未被分配时才算成功。
///
/// 存在的理由（01 B3「并发领取竞态」）：
/// `assign_task` 原来是「find_task → 改内存 → save_task」三步，
/// 而 `save_task` 是**无条件 upsert**（`ON CONFLICT DO UPDATE` 不带 WHERE）。
/// 两次调用之间 find 与 save 各自持锁、中间有窗口 ⇒ 两个 Agent 同时领同一个
/// 任务时，**后写的覆盖先写的**，先写的那个 Agent 已经在跑 LLM，
/// 但任务归属已经被改掉了 —— 谁也不知道任务到底归谁。
///
/// 这里把「检查」与「写入」合成**一条 SQL**：
/// `UPDATE ... WHERE id = ? AND status = ? AND assigned_agent_id IS NULL`
/// —— affected_rows 为 0 就说明条件已经不成立（被别人抢走了 / 状态变了），
/// 调用方据此报错，而不是默默覆盖。
///
/// 返回值：true = 认领成功；false = 条件不成立（任务已被别人领走）。
pub fn claim_task(
    db: &Database,
    task_id: &str,
    expected_status: &str,
    agent_id: &str,
    agent_name: &str,
    now: &str,
) -> Result<bool, String> {
    let conn = db.conn.lock().unwrap();
    let affected = conn
        .execute(
            "UPDATE tasks
                SET status = 'doing',
                    assigned_agent_id = ?2,
                    assigned_agent_name = ?3,
                    updated_at = ?4
              WHERE id = ?1
                AND status = ?5
                AND assigned_agent_id IS NULL",
            params![task_id, agent_id, agent_name, now, expected_status],
        )
        .map_err(|e| format!("认领任务失败: {}", e))?;
    Ok(affected > 0)
}

/// **条件改派**：把任务从 `old_agent_id` 改到 `new_agent_id`。
///
/// 与 `claim_task` 分成两条路，是因为两者面对的是**不同的语义**：
///
/// - `claim_task` = 「抢一个还没人领的任务」。两个 Agent 同时抢时**只允许一个赢家**，
///   另一个必须明确失败（不然就是 B3 那个竞态：后写的覆盖先写的，
///   先写的那个 Agent 已经在跑 LLM，但任务归属被改掉了）。
/// - `reassign_task` = 「用户显式把任务改派给另一个 Agent」（任务详情面板的 Agent 下拉框）。
///   这是**人的意图**，不是竞态 —— 后写覆盖先写是应有之义。
///
/// 但**仍然带条件**（`WHERE id = ? AND assigned_agent_id = ?old`）：
/// 若在「读」与「写」之间任务已被改派给别人，就不覆盖、如实报错，
/// 免得把别人的绑定顶掉。
///
/// 返回值：true = 改派成功；false = 条件不成立（中途已被别人改派）。
pub fn reassign_task(
    db: &Database,
    task_id: &str,
    old_agent_id: &str,
    new_agent_id: &str,
    new_agent_name: &str,
    now: &str,
) -> Result<bool, String> {
    let conn = db.conn.lock().unwrap();
    let affected = conn
        .execute(
            "UPDATE tasks
                SET status = 'doing',
                    assigned_agent_id = ?3,
                    assigned_agent_name = ?4,
                    updated_at = ?5
              WHERE id = ?1
                AND assigned_agent_id = ?2",
            params![task_id, old_agent_id, new_agent_id, new_agent_name, now],
        )
        .map_err(|e| format!("改派任务失败: {}", e))?;
    Ok(affected > 0)
}

/// 释放任务上的 Agent 绑定，并把任务状态改到 `new_status`。
///
/// 与 `claim_task` 成对：**条件更新**（`WHERE id = ? AND assigned_agent_id = ?`），
/// 避免"释放 A 的任务"与"把任务改派给 B"交错时把 B 的绑定一起清掉。
///
/// 返回值：true = 更新到；false = 该任务已不归这个 Agent（说明中途被改派了）。
pub fn release_task_agent(
    db: &Database,
    task_id: &str,
    agent_id: &str,
    new_status: &str,
    completed_at: Option<&str>,
    now: &str,
) -> Result<bool, String> {
    let conn = db.conn.lock().unwrap();
    let affected = conn
        .execute(
            "UPDATE tasks
                SET assigned_agent_id = NULL,
                    assigned_agent_name = NULL,
                    status = ?2,
                    completed_at = COALESCE(?3, completed_at),
                    updated_at = ?4
              WHERE id = ?1
                AND assigned_agent_id = ?5",
            params![task_id, new_status, completed_at, now, agent_id],
        )
        .map_err(|e| format!("释放任务失败: {}", e))?;
    Ok(affected > 0)
}

pub fn remove_task(db: &Database, id: &str) {
    let conn = db.conn.lock().unwrap();
    // 删除子任务
    let child_ids: Vec<String> = {
        let mut stmt = conn
            .prepare("SELECT id FROM tasks WHERE parent_id = ?1")
            .unwrap();
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
            let custom_fields: serde_json::Value =
                serde_json::from_str(&custom_fields_str).unwrap_or(serde_json::json!({}));
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
        // ⚠ **`created_at` 相同的时候要按插入顺序排**（`rowid` 是 tiebreaker）：
        //   同一轮里「用户消息」和「Agent 回复」用的是**同一个**时间戳
        //   （`send_task_message` 里 `now` 只取一次）⇒ 只按 `created_at` 排序时
        //   它们的先后是**不确定**的 ⇒ 对话顺序会随机跳。
        .prepare("SELECT id, task_id, role, content, created_at FROM task_messages WHERE task_id = ?1 ORDER BY created_at, rowid")
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
    let _ = conn.execute(
        "DELETE FROM task_dependencies WHERE task_id = ?1",
        params![task_id],
    );
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
        .prepare(
            "SELECT id, project_id, title, content, parent_id, sort_order, created_at, updated_at
                  FROM project_documents WHERE project_id = ?1 ORDER BY sort_order, created_at",
        )
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
        let mut stmt = conn
            .prepare("SELECT status FROM tasks WHERE project_id = ?1")
            .unwrap();
        stmt.query_map(params![project_id], |row| row.get(0))
            .unwrap()
            .filter_map(|r| r.ok())
            .collect()
    };
    let agents: Vec<String> = {
        let mut stmt = conn
            .prepare("SELECT status FROM agents WHERE project_id = ?1")
            .unwrap();
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
        conn.execute_batch("PRAGMA foreign_keys=ON;")
            .expect("pragma");
        let db = Database {
            conn: Mutex::new(conn),
        };
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
        assert_eq!(
            count("SELECT COUNT(*) FROM task_messages WHERE task_id='t1'"),
            1
        );
        assert_eq!(
            count("SELECT COUNT(*) FROM task_attachments WHERE task_id='t1'"),
            1
        );
        assert_eq!(count("SELECT COUNT(*) FROM tasks WHERE parent_id='t1'"), 1);
        drop(conn);

        let saved = find_task(&db, "t1").expect("t1 survives its own save");
        assert_eq!(saved.status, "doing");
        assert_eq!(saved.created_at, "2026-01-01T00:00:00Z");
    }

    // ===== 01 B3：并发领取竞态 =====
    //
    // 原来的 assign_task 是「find → 改内存 → save」三步，而 save_task 是
    // **无条件 upsert** ⇒ 两个 Agent 同时领同一个任务时，后写的覆盖先写的。
    // 现在认领走一条带 WHERE 的 UPDATE，条件不成立就明确失败。

    /// 造一条带指定状态与分配情况的任务
    fn insert_task_with(
        db: &Database,
        id: &str,
        project_id: &str,
        status: &str,
        assigned_agent_id: Option<&str>,
    ) {
        let conn = db.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO tasks (id, project_id, title, status, assigned_agent_id, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')",
            params![id, project_id, format!("task {}", id), status, assigned_agent_id],
        )
        .unwrap();
    }

    #[test]
    fn claim_task_succeeds_only_once() {
        let db = memory_db();
        insert_project(&db, "p1", "项目");
        insert_task_with(&db, "t1", "p1", "todo", None);

        let first = claim_task(&db, "t1", "todo", "agent-a", "A", "2026-02-02T00:00:00Z").unwrap();
        assert!(first, "第一个认领应当成功");

        // 第二个 Agent 来领同一个任务：条件已不成立（assigned_agent_id 不再为 NULL）
        let second = claim_task(&db, "t1", "todo", "agent-b", "B", "2026-02-02T00:01:00Z").unwrap();
        assert!(!second, "第二个认领必须失败 —— 这就是竞态修复点");

        // 且任务归属必须是**第一个**认领者，不能被后者覆盖
        let task = find_task(&db, "t1").expect("t1");
        assert_eq!(task.assigned_agent_id.as_deref(), Some("agent-a"));
        assert_eq!(task.assigned_agent_name.as_deref(), Some("A"));
        assert_eq!(task.status, "doing");
    }

    #[test]
    fn claim_task_fails_when_status_changed() {
        let db = memory_db();
        insert_project(&db, "p1", "项目");
        insert_task_with(&db, "t1", "p1", "todo", None);

        // 任务在"读状态"与"认领"之间被别人改成了 review
        {
            let conn = db.conn.lock().unwrap();
            conn.execute("UPDATE tasks SET status = 'review' WHERE id = 't1'", [])
                .unwrap();
        }

        let claimed = claim_task(
            &db,
            "t1",
            "todo", // 认领方以为自己读到的是 todo
            "agent-a",
            "A",
            "2026-02-02T00:00:00Z",
        )
        .unwrap();
        assert!(!claimed, "状态已变时认领必须失败");
        let task = find_task(&db, "t1").expect("t1");
        assert_eq!(task.status, "review", "不能把状态改回去");
        assert!(task.assigned_agent_id.is_none());
    }

    #[test]
    fn claim_task_does_not_touch_other_fields() {
        // 认领走的是**定点 UPDATE**，不是整行 upsert ——
        // 所以它不会把读-改-写窗口里别人改的其它字段一起覆盖掉。
        let db = memory_db();
        insert_project(&db, "p1", "项目");
        insert_task_with(&db, "t1", "p1", "todo", None);
        {
            let conn = db.conn.lock().unwrap();
            conn.execute(
                "UPDATE tasks SET title = '别人改的标题', priority = 3 WHERE id = 't1'",
                [],
            )
            .unwrap();
        }

        claim_task(&db, "t1", "todo", "agent-a", "A", "2026-02-02T00:00:00Z").unwrap();

        let task = find_task(&db, "t1").expect("t1");
        assert_eq!(task.title, "别人改的标题", "认领不该覆盖别人改的标题");
        assert_eq!(task.priority, 3, "认领不该覆盖别人改的优先级");
        assert_eq!(task.assigned_agent_id.as_deref(), Some("agent-a"));
    }

    #[test]
    fn release_task_agent_clears_binding_and_sets_status() {
        let db = memory_db();
        insert_project(&db, "p1", "项目");
        insert_task_with(&db, "t1", "p1", "doing", Some("agent-a"));

        let released = release_task_agent(
            &db,
            "t1",
            "agent-a",
            "done",
            Some("2026-02-02T00:00:00Z"),
            "2026-02-02T00:00:00Z",
        )
        .unwrap();
        assert!(released);

        let task = find_task(&db, "t1").expect("t1");
        assert!(task.assigned_agent_id.is_none(), "释放后不该还挂着 Agent");
        assert!(task.assigned_agent_name.is_none());
        assert_eq!(task.status, "done");
        assert_eq!(task.completed_at.as_deref(), Some("2026-02-02T00:00:00Z"));
    }

    #[test]
    fn release_task_agent_does_not_clear_another_agents_binding() {
        // 中途被改派给别人时，释放"旧 Agent"不能把新 Agent 的绑定清掉。
        let db = memory_db();
        insert_project(&db, "p1", "项目");
        insert_task_with(&db, "t1", "p1", "doing", Some("agent-b"));

        let released = release_task_agent(
            &db,
            "t1",
            "agent-a", // 要释放的是 A，但任务已经归 B
            "done",
            Some("2026-02-02T00:00:00Z"),
            "2026-02-02T00:00:00Z",
        )
        .unwrap();
        assert!(!released, "任务已不归该 Agent 时不该改它");

        let task = find_task(&db, "t1").expect("t1");
        assert_eq!(
            task.assigned_agent_id.as_deref(),
            Some("agent-b"),
            "B 的绑定必须保住"
        );
        assert_eq!(task.status, "doing", "状态也不该被改");
    }

    // ===== 改派（用户显式换 Agent）=====

    #[test]
    fn reassign_task_moves_binding_to_new_agent() {
        let db = memory_db();
        insert_project(&db, "p1", "项目");
        insert_task_with(&db, "t1", "p1", "doing", Some("agent-a"));

        let ok =
            reassign_task(&db, "t1", "agent-a", "agent-b", "B", "2026-02-02T00:00:00Z").unwrap();
        assert!(ok);

        let task = find_task(&db, "t1").expect("t1");
        assert_eq!(task.assigned_agent_id.as_deref(), Some("agent-b"));
        assert_eq!(task.assigned_agent_name.as_deref(), Some("B"));
        assert_eq!(task.status, "doing", "改派后任务应当进入 doing");
    }

    #[test]
    fn reassign_task_fails_when_old_binding_is_gone() {
        // 读完之后、写入之前，任务被别人改派了 ⇒ 本次改派必须失败，
        // 绝不能把"新的那个 Agent"顶掉。
        let db = memory_db();
        insert_project(&db, "p1", "项目");
        insert_task_with(&db, "t1", "p1", "doing", Some("agent-a"));
        {
            let conn = db.conn.lock().unwrap();
            conn.execute(
                "UPDATE tasks SET assigned_agent_id = 'agent-c', assigned_agent_name = 'C' WHERE id = 't1'",
                [],
            )
            .unwrap();
        }

        let ok = reassign_task(
            &db,
            "t1",
            "agent-a", // 我们以为还归 A
            "agent-b",
            "B",
            "2026-02-02T00:00:00Z",
        )
        .unwrap();
        assert!(!ok, "旧绑定已变时改派必须失败");

        let task = find_task(&db, "t1").expect("t1");
        assert_eq!(
            task.assigned_agent_id.as_deref(),
            Some("agent-c"),
            "C 的绑定必须保住"
        );
    }

    #[test]
    fn claim_task_refuses_task_already_owned_by_someone_else() {
        // 已经归 A 的任务，B 不能"抢"走（claim 的语义是领**没人领**的）。
        let db = memory_db();
        insert_project(&db, "p1", "项目");
        insert_task_with(&db, "t1", "p1", "doing", Some("agent-a"));

        let ok = claim_task(&db, "t1", "doing", "agent-b", "B", "2026-02-02T00:00:00Z").unwrap();
        assert!(!ok, "已归属的任务不能被别人 claim 走");
        let task = find_task(&db, "t1").expect("t1");
        assert_eq!(task.assigned_agent_id.as_deref(), Some("agent-a"));
    }

    #[test]
    fn released_task_can_be_claimed_again() {
        // 闭环：验收不通过 ⇒ 任务回到 todo 且**解除了绑定** ⇒ 之后能被别人重新领走。
        // 如果释放时不清绑定，这条会红 —— 而且产品上就是死局：
        // 任务回到 todo 却谁都领不走。
        let db = memory_db();
        insert_project(&db, "p1", "项目");
        insert_task_with(&db, "t1", "p1", "review", Some("agent-a"));

        let released =
            release_task_agent(&db, "t1", "agent-a", "todo", None, "2026-02-02T00:00:00Z").unwrap();
        assert!(released);

        let claimed =
            claim_task(&db, "t1", "todo", "agent-b", "B", "2026-02-03T00:00:00Z").unwrap();
        assert!(claimed, "释放后的任务应当能被重新领取");

        let task = find_task(&db, "t1").expect("t1");
        assert_eq!(task.assigned_agent_id.as_deref(), Some("agent-b"));
        assert_eq!(task.status, "doing");
    }

    /// 插入一个指定状态的 Agent
    fn insert_agent_with(db: &Database, id: &str, project_id: &str, status: &str) {
        let conn = db.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO agents (id, project_id, name, system_prompt, model, status, created_at, last_used_at)
             VALUES (?1, ?2, ?3, '', 'default', ?4, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')",
            params![id, project_id, format!("agent {}", id), status],
        )
        .unwrap();
    }

    // ===== 项目统计（收敛成唯一实现后锁住口径）=====

    #[test]
    fn get_project_stats_counts_task_statuses() {
        let db = memory_db();
        insert_project(&db, "p1", "项目");
        insert_task_with(&db, "t1", "p1", "todo", None);
        insert_task_with(&db, "t2", "p1", "doing", None);
        insert_task_with(&db, "t3", "p1", "doing", None);
        insert_task_with(&db, "t4", "p1", "waiting", None);
        insert_task_with(&db, "t5", "p1", "review", None);
        insert_task_with(&db, "t6", "p1", "done", None);

        let stats = get_project_stats(&db, "p1");
        assert_eq!(stats.tasks.total, 6);
        assert_eq!(stats.tasks.todo, 1);
        assert_eq!(stats.tasks.doing, 2);
        assert_eq!(stats.tasks.waiting, 1);
        assert_eq!(stats.tasks.review, 1);
        assert_eq!(stats.tasks.done, 1);
    }

    #[test]
    fn get_project_stats_only_counts_the_given_project() {
        // 统计必须**按 project 过滤** —— 漏了这一条，
        // 项目面板就会把别的项目的任务算进来。
        let db = memory_db();
        insert_project(&db, "p1", "项目一");
        insert_project(&db, "p2", "项目二");
        insert_task_with(&db, "t1", "p1", "todo", None);
        insert_task_with(&db, "t2", "p2", "doing", None);
        insert_task_with(&db, "t3", "p2", "done", None);

        let stats = get_project_stats(&db, "p1");
        assert_eq!(stats.tasks.total, 1);
        assert_eq!(stats.tasks.todo, 1);
        assert_eq!(stats.tasks.doing, 0);
        assert_eq!(stats.tasks.done, 0);
    }

    #[test]
    fn get_project_stats_counts_agent_statuses() {
        let db = memory_db();
        insert_project(&db, "p1", "项目");
        insert_project(&db, "p2", "别的项目");
        insert_agent_with(&db, "a1", "p1", "working");
        insert_agent_with(&db, "a2", "p1", "idle");
        insert_agent_with(&db, "a3", "p1", "offline");
        insert_agent_with(&db, "a4", "p2", "working"); // 别的项目

        let stats = get_project_stats(&db, "p1");
        assert_eq!(stats.agents.total, 3);
        assert_eq!(stats.agents.working, 1);
        assert_eq!(stats.agents.idle, 1);
        assert_eq!(stats.agents.offline, 1);
    }

    #[test]
    fn get_project_stats_of_empty_project_is_all_zero() {
        let db = memory_db();
        insert_project(&db, "p1", "空项目");
        let stats = get_project_stats(&db, "p1");
        assert_eq!(stats.tasks.total, 0);
        assert_eq!(stats.agents.total, 0);
    }

    #[test]
    fn release_task_agent_keeps_other_columns_intact() {
        // 释放是**定点 UPDATE**，不能像整行 upsert 那样把别的列覆盖回旧值。
        let db = memory_db();
        insert_project(&db, "p1", "项目");
        insert_task_with(&db, "t1", "p1", "doing", Some("agent-a"));
        {
            let conn = db.conn.lock().unwrap();
            conn.execute(
                "UPDATE tasks SET title = '改过的标题', output = '已有的产出' WHERE id = 't1'",
                [],
            )
            .unwrap();
        }

        release_task_agent(
            &db,
            "t1",
            "agent-a",
            "done",
            Some("2026-02-02T00:00:00Z"),
            "2026-02-02T00:00:00Z",
        )
        .unwrap();

        let task = find_task(&db, "t1").expect("t1");
        assert_eq!(task.title, "改过的标题", "释放不该回退标题");
        assert_eq!(
            task.output.as_deref(),
            Some("已有的产出"),
            "释放不该清掉产出"
        );
    }

    // ===== W-23/W-24：落盘机密性与文件权限（结论落成测试）=====

    fn unique_tmp_dir(tag: &str) -> std::path::PathBuf {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("z-biz-{}-{}-{}", tag, std::process::id(), nanos));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[cfg(unix)]
    #[test]
    fn restrict_mode_makes_files_owner_only() {
        use std::os::unix::fs::PermissionsExt;
        let dir = unique_tmp_dir("perm");
        let file = dir.join("data.db");
        std::fs::write(&file, b"x").unwrap();

        restrict_mode(&dir, 0o700);
        restrict_mode(&file, 0o600);

        let mode = |p: &std::path::Path| {
            std::fs::metadata(p).unwrap().permissions().mode() & 0o777
        };
        assert_eq!(mode(&dir), 0o700);
        assert_eq!(mode(&file), 0o600);
        // 不存在的路径（如尚未创建的 -wal/-shm）不能 panic
        restrict_mode(&dir.join("missing"), 0o600);

        std::fs::remove_dir_all(&dir).ok();
    }

    /// W-23 结论：`agents.system_prompt` 是**明文**存进 SQLite 的，
    /// 没有加密、没有脱敏。机主之外的人只要能读到 data.db 就能读到它。
    /// 本测试直接从磁盘文件里找机密字符串，防止有人「以为加了密」。
    #[test]
    fn system_prompt_is_stored_in_plaintext_on_disk() {
        let dir = unique_tmp_dir("plain");
        let path = dir.join("data.db");
        let db = {
            let conn = Connection::open(&path).unwrap();
            conn.execute_batch("PRAGMA foreign_keys=ON;").unwrap();
            let db = Database {
                conn: Mutex::new(conn),
            };
            db.init_schema().unwrap();
            db
        };
        insert_project(&db, "p1", "项目");
        let secret = "TOP-SECRET-SYSTEM-PROMPT-7f3a9c";
        {
            let conn = db.conn.lock().unwrap();
            conn.execute(
                "INSERT INTO agents (id, project_id, name, system_prompt, model, status, created_at, last_used_at)
                 VALUES ('a1', 'p1', 'A', ?1, 'default', 'idle', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')",
                params![secret],
            )
            .unwrap();
        }
        drop(db);

        let bytes = std::fs::read(&path).unwrap();
        let text = String::from_utf8_lossy(&bytes);
        assert!(
            text.contains(secret),
            "W-23：system_prompt 若已加密，磁盘上不应出现明文；此断言失败说明加密已加，需更新结论"
        );

        std::fs::remove_dir_all(&dir).ok();
    }
}
