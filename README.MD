# z-biz-tool-worker

> AI 任务看板 — 项目管理 / Agent 员工管理 / 任务分配 / 执行监控 / 验收

![tech](https://img.shields.io/badge/Tauri-2-FFC131?logo=tauri)
![tech](https://img.shields.io/badge/React-19-61DAFB?logo=react)
![tech](https://img.shields.io/badge/AntD-6-0170FE?logo=antdesign)
![tech](https://img.shields.io/badge/TypeScript-5-3178C6?logo=typescript)
![tech](https://img.shields.io/badge/Rust-stable-DEA584?logo=rust)
![tech](https://img.shields.io/badge/Zustand-5-433931)

---

## 概览

**AI 任务看板**，对标 Teambition / Trello / Jira 的纵向管理条（Kanban）形态，但管理的不只是人，而是 **AI Agent 员工**：

- 第一个管理条是 **Agent 员工**（每个 Agent 绑定一个本地 LLM CLI 实例，如 Claude Code）
- 任务卡在多条管理条间拖拽表达状态变更
- 任务被**指派**给某个 Agent 后，该 Agent 在后台拉起本地 CLI 执行；执行结果回写到任务，进 `review` 等验收

核心定位：用户负责**给任务、指派 Agent、看状态、验收结果**，任务的具体执行由 Agent 在后台完成。

> ⚠️ 关于「主动领取」的准确说法（2026-10 核对代码后订正）：
> 本仓**没有**「Agent 自己扫描未结束的任务列表并自动领取」的机制。
> `App.tsx` 里那个 5 秒轮询是**界面刷新**（`list_tasks` + 失败退避），不是 Agent 抢单；
> 唯一的指派入口是用户操作：任务详情面板的「分配给」下拉框（`invoke("assign_task")`）。
> 认领的**并发安全**由后端保证（一条带 `WHERE` 的条件 UPDATE，见 `src-tauri/src/db.rs` 的
> `claim_task` / `reassign_task`），但「谁来领」这件事目前由人决定。

---

## 设计目标

1. **给任务、收结果** — 用户只需向系统添加任务，剩下交给 Agent
2. **多 Agent 并行** — 启动多个 Agent 实例，任务并行消费
3. **可观测** — 每个任务都明确是哪个 Agent 在干、当前执行到哪一步、状态是什么
4. **可验收** — 任务从 `doing` 流转到 `review` 后由用户验收，通过后流转到 `done`

---

## 核心数据模型

```ts
interface Project {
  id, name, description, created_at, updated_at
}

interface Agent {
  id, project_id,
  name,
  system_prompt,        // Agent 的人设/系统提示词
  model,                // 调用的 LLM 模型
  status: "idle" | "working" | "offline",
  current_task_id,      // 正在执行的任务
  source,               // manual | imported
  cli_type,             // claude-code | hermes | opencode（绑了才会在后台真跑）
  local_agent_id, cli_version, cli_path,
  created_at, last_used_at
}

interface Task {
  id, project_id,
  title, description,
  status: "todo" | "doing" | "waiting" | "review" | "done",
  priority,             // 0..3
  assigned_agent_id, assigned_agent_name,   // 分配给哪个 Agent
  parent_id, children,  // 父子任务（数据模型支持，UI 暂无创建入口）
  start_date, due_date, // YYYY-MM-DD
  milestone, output, agent_output, waiting_for_input,
  custom_fields, tags, sort_order,
  created_at, updated_at, completed_at
}

interface TaskMessage {
  id, task_id,
  role: "user" | "agent",
  content,
  created_at
}
```

---

## 功能

### 📋 项目管理
- 多 Project 切换
- 每个 Project 独立的任务列表 + Agent 列表
- Project 统计面板：任务总数 / 各状态数量、Agent 总数 / 各状态数量

### 🐝 Agent 员工管理
- 注册 Agent：填写名字 / system prompt / 模型；也可从本机扫描并导入已装的 LLM CLI
- 状态机（**当前实际会走的**）：`idle` → `working` → `idle`
  —— 接下任务时进 `working`，执行完成 / 失败 / 任务释放时回 `idle`。
  类型里还有一个 `offline`，但**当前没有任何代码路径会写入它**（只被统计，不被设置）。
- Agent 当前任务实时显示
- ⚠️ 手动创建（未绑定本地 CLI）的 Agent 被指派后，任务会停在 `doing` 等人工处理 ——
  后台执行只在 Agent 绑定了 `cli_type` 时才发生

### 🎯 任务看板（Teambition 风格）
- 5 列状态：`todo` / `doing` / `waiting` / `review` / `done`
- 任务卡拖拽切换状态（5 个状态之间**任意**可拖；当前**没有**流转规则校验 ——
  规则引擎仍列在下方路线图里）
- 父子任务：数据模型支持 `parent_id` / `children`，但**当前 UI 没有创建子任务的入口**
- 任务分配：在**任务详情面板**的「分配给」下拉框里选 Agent
  （看板是 5 条状态列，**没有** Agent 列，也没有「拖到 Agent 列即分配」）
- 任务依赖：任务详情面板可设置「前置依赖任务」（**不强制**前置必须先完成）
- 任务消息流：每个任务下保存 `user` / `agent` 角色对话历史

### 📊 实时监控
- 任务从被指派到完成的实时状态更新（界面每 5 秒拉一次，失败自动退避）
- Agent 工作状态实时反映

### ✅ 验收
- `review` 状态的任务卡由用户人工验收
- 通过 → `done`；不通过 → 打回 `todo` 重新排队
- 两种情况都会**释放 Agent**（Agent 回到 `idle`，任务上的分配标记一并清掉）
  —— 所以打回 `todo` 的任务需要**重新指派**才会再跑起来
- 任务消息流支持评论/反馈

### ⚙️ 设置
- 主题切换
- 默认模型配置
- API URL 配置（支持自建 / 第三方 LLM 网关）

---

## 技术栈

| 层 | 技术 |
|---|---|
| 桌面运行时 | Tauri 2 (Rust + 系统 WebView) |
| 前端框架 | React 19 + TypeScript 5 |
| UI 组件 | Ant Design 6 |
| 状态管理 | Zustand 5 |
| 数据持久化 | **SQLite**（Rust 后端 `rusqlite`）；localStorage 只存 UI 偏好与未提交草稿 |
| Agent 运行时 | 本地 node 进程拉起 LLM CLI（Claude Code / hermes / opencode） |
| 构建 | Vite 6 |

---

## 项目结构

```
src/
├─ App.tsx                  顶层布局 + 轮询刷新
├─ main.tsx                 React 入口
├─ components/
│  ├─ views/                6 个视图：Kanban / List / Gantt / Calendar / Dashboard / Documents
│  ├─ Settings/             设置面板
│  ├─ TaskDetailPanel.tsx   任务详情（状态 / 分配 / 依赖 / 消息流）
│  ├─ WorkflowEditor.tsx    工作流编辑
│  └─ TagManager.tsx        标签管理
├─ stores/                  Zustand：workerStore / viewStore
├─ hooks/                   useDraft 等
├─ utils/                   taskFilters（54 条断言）/ ganttLayout / calendarLayout
├─ types/index.ts           TypeScript 类型定义
tests/                      前端测试（node --experimental-strip-types --test）
agent-proxy/                本地 LLM CLI 代理（独立 npm 包，需先 build）
src-tauri/
├─ src/
│  ├─ db.rs                 SQLite 读写层
│  ├─ storage.rs            全局 DB 门面
│  ├─ commands.rs           Tauri 命令
│  ├─ task_state.rs         任务状态流转规则（纯逻辑，有单测）
│  ├─ agent_proxy.rs        拉起 / 回收 agent-proxy 子进程
│  ├─ agent_runner.rs       单次任务执行
│  ├─ agent_session.rs      Agent ↔ proxy 会话绑定
│  ├─ models.rs / lib.rs / main.rs
└─ tauri.conf.json
```

---

## 开发

```bash
# 装依赖
npm install

# ⚠️ 必须先编 agent-proxy，否则 Tauri 构建会红在
#    `resource path `../agent-proxy/dist` doesn't exist`
#    （agent-proxy/dist 被 .gitignore 挡住，不在仓库里）
npm run build:all      # = npm run build && npm run agent-proxy:build

# 前端开发（HMR）
npm run dev

# 类型检查
npm run typecheck

# 测试
npm test               # 前端：node --experimental-strip-types --test tests/*.test.ts
cd src-tauri && cargo test --lib   # 后端单测

# 生产构建（前端）
npm run build

# 桌面应用开发（启动 Tauri 原生窗口）
npm run tauri dev

# 桌面应用打包
npm run tauri build
```

---

## 平台支持

- **macOS** — Apple Silicon + Intel
- **Windows** — x86_64
- **Linux** — deb / AppImage / rpm

---

## 路线图

- [ ] 任务流转规则引擎（哪些状态之间可流转、是否需要 review）
- [ ] 父子任务依赖关系（必须先完成子任务）
- [ ] Agent 任务优先级队列
- [ ] 任务超时告警 / 自动重试
- [ ] 任务执行截图 / 日志附件
- [ ] 多 Project 并行运行
- [ ] 数据导出（项目/任务/Agent 配置）
- [ ] 移动端查看进度
- [ ] Agent 执行成本（token）统计

---

## License

MIT
