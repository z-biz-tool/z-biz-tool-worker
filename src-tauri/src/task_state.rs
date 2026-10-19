//! 任务状态流转规则 —— **纯逻辑，不碰 IO**。
//!
//! 存在的理由（01 的 B2「状态流转零测试」）：
//!
//! 流转规则是本仓的产品核心（`todo → doing → review → done`），
//! 但它原先**散落在 `commands.rs` 的三处 `if` 里**：
//!
//! - `update_task_status`：合法状态白名单、盖 `completed_at`、释放 Agent，三件事各自一个 `if`；
//! - `review_task`：验收通过 ⇒ `done` + 盖时间；不通过 ⇒ 回 `todo`；两种情况都释放 Agent；
//! - `assign_task`：把任务拉到 `doing`。
//!
//! 这三条命令都依赖全局 DB（`storage::get_db()`），没法在单测里驱动，
//! 于是这些规则**一行测试都没有** —— 改坏了不会有任何检查拦住。
//!
//! 现在把它们抽成纯函数：
//! - 规则本身可以逐条断言（本文档下方的 `mod tests`）；
//! - `commands.rs` 仍然按同样的规则跑，**行为不变**，只是「规则」与「副作用」分了家；
//! - 将来加新入口（比如 Web/API）时，规则只有一份，不会各写一遍跑偏。
//!
//! ⚠️ 抽出来的**不是**状态机：看板允许把卡片拖到任意一列，
//!    `done → doing` 之类**当前是被接受的**（这是看板的核心交互，不改）。
//!    这里只把「当前实际行为」钉住，不新增任何流转限制。

/// 本仓承认的全部任务状态。
pub const VALID_STATUSES: [&str; 5] = ["todo", "doing", "waiting", "review", "done"];

/// 该状态是否合法。
pub fn is_valid_status(status: &str) -> bool {
    VALID_STATUSES.contains(&status)
}

/// 校验状态合法性，非法时给出与前端一致的报错文案。
pub fn validate_status(status: &str) -> Result<(), String> {
    if is_valid_status(status) {
        Ok(())
    } else {
        Err(format!("非法状态: {}", status))
    }
}

/// `update_task_status` 的副作用计划。
#[derive(Debug, PartialEq, Eq)]
pub struct StatusUpdatePlan {
    /// 是否给任务盖上 `completed_at`。
    pub stamp_completed_at: bool,
    /// 是否释放任务上的 Agent 绑定（并把该 Agent 置回 idle）。
    pub release_agent: bool,
}

/// `update_task_status` 切到 `status` 时应该做什么。
///
/// 现状（不是理想，是**当前真实行为**）：
/// - 只有切到 `done` 才盖 `completed_at`；
/// - 只有切到 `done` 才释放 Agent —— 切到 `todo` / `waiting` 时**保留**原分配
///   （命令的 doc 注释里写着「doing 时如果原来有 assigned_agent，会保留分配」）。
pub fn plan_status_update(status: &str) -> StatusUpdatePlan {
    StatusUpdatePlan {
        stamp_completed_at: status == "done",
        release_agent: status == "done",
    }
}

/// `review_task` 的副作用计划。
#[derive(Debug, PartialEq, Eq)]
pub struct ReviewPlan {
    /// 验收后任务落到哪个状态。
    pub next_status: &'static str,
    /// 是否盖 `completed_at`。
    pub stamp_completed_at: bool,
    /// 是否释放 Agent —— **两种情况都释放**：
    /// 验收通过 ⇒ 任务完成，Agent 必然空闲；
    /// 验收不通过 ⇒ 任务退回 `todo` 重新排队，Agent 也必须空闲。
    /// （不释放的话，Agent 会被永远卡在 "working"，且任务挂着旧绑定、
    ///   后面谁也领不走它 —— 与 `claim_task` 的「未分配才可领」规则直接冲突。）
    pub release_agent: bool,
}

/// `review_task` 在 `approved` 为真/假时的计划。
pub fn plan_review(approved: bool) -> ReviewPlan {
    if approved {
        ReviewPlan {
            next_status: "done",
            stamp_completed_at: true,
            release_agent: true,
        }
    } else {
        ReviewPlan {
            next_status: "todo",
            stamp_completed_at: false,
            release_agent: true,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── 合法状态白名单 ────────────────────────────────────────────────────

    #[test]
    fn valid_statuses_are_the_five_known_ones() {
        for s in ["todo", "doing", "waiting", "review", "done"] {
            assert!(is_valid_status(s), "{} 应当合法", s);
        }
    }

    #[test]
    fn unknown_status_is_rejected() {
        // 这条是**当前真实行为**：`update_task_status` 对未知状态直接报错。
        assert!(!is_valid_status("archived"));
        assert!(!is_valid_status(""));
        assert!(!is_valid_status("TODO")); // 大小写敏感
        assert!(!is_valid_status(" todo"));
    }

    #[test]
    fn validate_status_error_message_names_the_bad_status() {
        let err = validate_status("archived").unwrap_err();
        assert_eq!(err, "非法状态: archived");
        assert!(validate_status("done").is_ok());
    }

    // ── update_task_status 的规则 ────────────────────────────────────────

    #[test]
    fn only_done_stamps_completed_at() {
        assert!(plan_status_update("done").stamp_completed_at);
        for s in ["todo", "doing", "waiting", "review"] {
            assert!(
                !plan_status_update(s).stamp_completed_at,
                "{} 不该盖完成时间",
                s
            );
        }
    }

    #[test]
    fn only_done_releases_agent() {
        assert!(plan_status_update("done").release_agent);
        for s in ["todo", "doing", "waiting", "review"] {
            assert!(
                !plan_status_update(s).release_agent,
                "{} 不该释放 Agent（当前行为：保留分配）",
                s
            );
        }
    }

    // ── review_task 的规则 ───────────────────────────────────────────────

    #[test]
    fn approved_review_goes_to_done_and_stamps_time() {
        let p = plan_review(true);
        assert_eq!(p.next_status, "done");
        assert!(p.stamp_completed_at);
        assert!(p.release_agent);
    }

    #[test]
    fn rejected_review_goes_back_to_todo_without_stamping_time() {
        let p = plan_review(false);
        assert_eq!(p.next_status, "todo");
        assert!(!p.stamp_completed_at, "退回 todo 不该盖完成时间");
        assert!(p.release_agent, "退回 todo 也必须释放 Agent");
    }

    #[test]
    fn review_always_releases_agent() {
        // 两条分支都释放 —— 这是「退回 todo 后任务能被重新领取」的前提。
        assert!(plan_review(true).release_agent);
        assert!(plan_review(false).release_agent);
    }
}
