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

- 第一个管理条是 **Agent 员工**（每个 Agent 启动一个本地 terminal，里面跑 Claude Code 等 LLM 实例）
- 任务卡在多条管理条间拖拽表达状态变更
- 每个 Agent 实例能感知当前未结束的任务列表，**主动领取任务执行**

核心定位：用户只负责**给任务、看状态、验收结果**，任务执行由 Agent 自动消费。

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
  created_at, last_used_at
}

interface Task {
  id, project_id,
  title, description,
  status: "todo" | "doing" | "waiting" | "review" | "done",
  assigned_agent_id,    // 分配给哪个 Agent
  parent_id, children,  // 父子任务（任务可拆解）
  created_at, updated_at
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
- 注册 Agent：填写名字 / system prompt / 模型
- 启动/停止 Agent（每个 Agent 绑定一个本地 terminal + Claude Code 实例）
- 状态机：`idle` → `working` → `idle`（任务领取/完成后切换），或 `offline`（手动停止）
- Agent 当前任务实时显示

### 🎯 任务看板（Teambition 风格）
- 5 列状态：`todo` / `doing` / `waiting` / `review` / `done`
- 任务卡拖拽切换状态（支持 `todo → doing` 等流转规则校验）
- 父子任务：任务可拆解为子任务
- 任务分配：拖拽任务到 Agent 列自动分配
- 任务消息流：每个任务下保存 `user` / `agent` 角色对话历史

### 📊 实时监控
- 任务从被领取到完成的实时状态更新
- Agent 工作状态实时反映
- 任务流转日志

### ✅ 验收
- `review` 状态的任务卡由用户人工验收
- 通过 → `done`，不通过 → 打回 `todo` 重新执行
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
| 数据持久化 | localStorage（可扩展到 SQLite/后端） |
| Agent 运行时 | 本地 terminal + Claude Code / 其他 LLM CLI |
| 构建 | Vite 6 |

---

## 项目结构

```
src/
├─ App.tsx                  顶层布局 + 路由
├─ main.tsx                 React 入口
├─ stores/
│  └─ workerStore.ts         Zustand 状态（Project / Agent / Task / Message）
└─ types/
   └─ index.ts               TypeScript 类型定义
src-tauri/
└─ src/                      Tauri 后端
```

---

## 开发

```bash
# 装依赖
npm install

# 前端开发（HMR）
npm run dev

# 类型检查
npm run typecheck

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
