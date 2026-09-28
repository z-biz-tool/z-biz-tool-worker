# Z-Biz Worker 技术规格文档

## 一、项目概述

**项目名称：** z-biz-tool-worker
**项目类型：** 多Agent协作的任务管理系统
**核心功能：** 通过多Agent并行执行 + 父子任务拆解 + 事件驱动协作，实现复杂任务的自动化执行
**目标用户：** 需要多Agent协同处理复杂项目的团队/个人

---

## 二、系统架构

### 2.1 整体架构

```
┌─────────────────────────────────────────────────────────┐
│                      Electron App                       │
├─────────────────────┬───────────────────────────────────┤
│   React Frontend    │         Express Backend           │
│                     │                                   │
│  ┌───────────────┐  │  ┌─────────┐  ┌───────────────┐  │
│  │ 左侧Agent面板 │  │  │  Router │  │ Agent进程管理  │  │
│  │ - 制造员工   │  │  │         │  │ - Hermes本地  │  │
│  │ - 克隆员工   │  │  │         │  │ - 进程托管    │  │
│  │ - Agent列表  │  │  │         │  │ - SSE输出     │  │
│  └───────────────┘  │  └─────────┘  └───────────────┘  │
│                     │         │                        │
│  ┌───────────────┐  │  ┌─────────┐  ┌───────────────┐  │
│  │ 任务看板     │  │  │ 事件引擎 │  │ 任务状态机    │  │
│  │ - 父任务卡片 │  │  │         │  │ - todo/doing  │  │
│  │ - 子任务展开 │  │  │         │  │ - review/done │  │
│  │ - 拖拽状态  │  │  │         │  │ - waiting     │  │
│  └───────────────┘  │  └─────────┘  └───────────────┘  │
│                     │         │                        │
│  ┌───────────────┐  │  ┌─────────┐  ┌───────────────┐  │
│  │ 任务详情     │  │  │ 上下文  │  │ 文件系统     │  │
│  │ - 输出流    │  │  │ 文档    │  │ - JSON存储   │  │
│  │ - 验收操作  │  │  │ 管理    │  │ - 项目隔离   │  │
│  └───────────────┘  │  └─────────┘  └───────────────┘  │
└─────────────────────┴───────────────────────────────────┘
```

### 2.2 技术栈

| 层级 | 技术 | 用途 |
|------|------|------|
| 桌面壳 | Electron | 跨平台桌面应用 |
| 前端框架 | React 18 + TypeScript | UI组件化 |
| 前端状态 | useState/useEffect + Context | 状态管理 |
| 样式 | CSS (原生) | 样式隔离 |
| 构建 | Vite | 开发/构建 |
| 后端框架 | Express | API服务 |
| Agent引擎 | Hermes Agent (本地) | 本地LLM推理 |
| 进程管理 | node-pty | 伪终端 |
| 实时通信 | SSE | Agent输出推送 |
| 数据存储 | JSON文件系统 | 持久化 |

---

## 三、数据结构

### 3.1 项目目录结构

```
z-biz-tool-worker/
├── data/                          # 数据根目录
│   └── projects/                 # 项目目录
│       └── {project_id}/         # 单个项目（完全隔离）
│           ├── context.json      # 项目上下文文档
│           ├── meta.json         # 项目元信息
│           ├── agents/           # Agent配置目录
│           │   └── {agent_id}.json
│           └── tasks/            # 任务目录
│               └── {task_id}.json
├── electron/
│   ├── main.js                   # Electron主进程 + Express服务
│   └── preload.js                # 预加载脚本
└── src/
    ├── App.tsx                   # 主应用
    ├── index.css                 # 全局样式
    └── main.tsx                  # 入口
```

### 3.2 context.json（项目上下文文档）

**用途：** 项目级共享文档，所有Agent可读，父任务完成后写回

```json
{
  "projectId": "proj_xxx",
  "name": "项目名称",
  "description": "项目描述",
  "goals": "项目目标/愿景",
  "techStack": "技术栈说明",
  "constraints": "约束条件",
  "currentProgress": "当前进度摘要",
  "artifacts": {
    "key1": "产出物1的路径或内容摘要",
    "key2": "产出物2的路径或内容摘要"
  },
  "updatedAt": "2026-05-19T12:00:00Z",
  "updatedBy": "agent_id"
}
```

### 3.3 task_*.json（任务数据）

**用途：** 描述单个任务的状态、产出、父子关系

```json
{
  "id": "task_xxx",
  "projectId": "proj_xxx",
  "parentId": null,
  "title": "任务标题",
  "description": "任务详细描述",
  "status": "todo|doing|waiting|review|done",
  "priority": 1,
  "assignedAgentId": "agent_xxx",
  "assignedAgentName": "Agent名称",
  "children": ["task_child1", "task_child2"],
  "receipts": {},
  "output": "Agent执行输出",
  "agentOutput": "Agent实时输出（SSE推送）",
  "artifacts": [
    {
      "name": "产出物文件名",
      "path": "相对路径",
      "description": "产出物描述"
    }
  ],
  "contextSnapshot": "执行时的上下文快照",
  "createdAt": "2026-05-19T10:00:00Z",
  "updatedAt": "2026-05-19T12:00:00Z",
  "completedAt": null
}
```

**状态流转：**

```
                    ┌──────────┐
                    │   todo   │
                    └────┬─────┘
                         │ 分配Agent
                         ▼
                    ┌──────────┐
              ┌─────│  doing   │─────┐
              │     └────┬─────┘     │
              │          │           │
         有子任务    子任务全done    无子任务
              │          │           │
              ▼          ▼           ▼
        ┌──────────┐ ┌──────────┐ ┌──────────┐
        │ waiting  │ │ 父任务   │ │   done   │
        │ (等子任务)│ │ 验收+处理 │ │          │
        └────┬─────┘ └────┬─────┘ └──────────┘
             │            │
        子任务打回     ┌────┴────┐
             │         │         │
             ▼         ▼         ▼
          todo     ┌──────────┐  done
                   │  review  │
                   └────┬─────┘
                        │ 用户验收
                        ▼
                   ┌──────────┐
                   │   done   │
                   └──────────┘
```

### 3.4 agent_*.json（Agent配置）

**用途：** 定义Agent的身份定位、模型、当前状态

```json
{
  "id": "agent_xxx",
  "projectId": "proj_xxx",
  "name": "任务拆解Agent",
  "identity": {
    "role": "任务规划师",
    "systemPrompt": "你是一个专业的任务规划师，擅长将复杂任务拆解为可执行的子任务..."
  },
  "model": {
    "provider": "hermes-local",
    "modelName": "本地模型名",
    "temperature": 0.7
  },
  "status": "idle|working|offline",
  "currentTaskId": null,
  "createdAt": "2026-05-19T10:00:00Z",
  "lastUsedAt": "2026-05-19T12:00:00Z"
}
```

---

## 四、功能模块

### 4.1 项目管理

| 功能 | 描述 |
|------|------|
| 创建项目 | 输入名称/描述，创建独立的项目目录 |
| 删除项目 | 删除项目目录及所有数据 |
| 切换项目 | 切换后左侧Agent列表 + 看板数据全部切换 |
| 列表展示 | 首页展示所有项目卡片 |

### 4.2 Agent管理（左侧面板）

| 功能 | 描述 |
|------|------|
| 制造Agent | 创建新Agent（定义身份+模型） |
| 克隆Agent | 复制现有Agent配置，生成无上下文的新实例 |
| 列表展示 | 显示当前项目所有Agent（idle/working/offline状态） |
| 删除Agent | 移除Agent配置（不影响运行中的进程） |
| 状态同步 | 实时显示Agent当前状态 |

### 4.3 任务管理（看板）

| 功能 | 描述 |
|------|------|
| 创建任务 | 在看板列中添加新任务 |
| 父子嵌套 | 父任务可展开子任务列表 |
| 状态拖拽 | 拖拽改变任务状态（仅用户操作时） |
| 分配Agent | 选中任务 → 选择Agent执行 |
| 任务拆解 | 父任务分配拆解Agent → 自动生成子任务 |
| 查看详情 | 点击任务卡片 → 弹窗显示详情+输出 |

### 4.4 任务执行流程

```
1. 分配Agent
   └─ 选中任务 → 选择Agent → 任务状态=todo→doing
   └─ Agent读取context.json + task.json
   └─ Agent开始执行

2. 子任务执行（父任务的子任务）
   └─ 子任务完成后 → 自动通知父任务
   └─ 父任务验收（通过/打回）
   └─ 打回 → 子任务todo → 同Agent继续

3. 父任务收尾
   └─ 所有子任务验收通过
   └─ 父任务收集子任务回执（receipts）
   └─ 父任务切换doing，做自己的事情
   └─ 完成后写回context.json
   └─ 父任务状态=done

4. 验收
   └─ 子任务 → 父任务验收
   └─ 父任务 → 用户验收（用户点验收按钮）
```

### 4.5 事件驱动机制

```
事件类型：
- TASK_COMPLETED    子任务完成
- TASK_REJECTED     父任务打回子任务
- TASK_ALL_CHILDREN_DONE  所有子任务完成
- AGENT_OUTPUT      Agent输出更新
- CONTEXT_UPDATED   上下文文档更新
```

**事件流转：**
```
子任务完成 → 写入task.json → 发布TASK_COMPLETED事件
                                         │
                                         ▼
                                  父任务收到事件
                                         │
                                         ▼
                              父任务验收子任务（自动）
                                    │         │
                                 通过        打回
                                    │         │
                                    ▼         ▼
                              receipts写入  子任务→todo
                                    │
                                    ▼
                        检查所有子任务是否完成
                                    │
                              全部完成 →
                                    │
                                    ▼
                          父任务切换doing
                                    │
                                    ▼
                          父任务执行自己的事情
                                    │
                                    ▼
                          完成后写回context.json
                                    │
                                    ▼
                          父任务状态=done
```

---

## 五、API设计

### 5.1 项目API

| Method | Path | 描述 |
|--------|------|------|
| GET | /api/projects | 获取项目列表 |
| POST | /api/projects | 创建项目 |
| GET | /api/projects/:id | 获取项目详情 |
| DELETE | /api/projects/:id | 删除项目 |

### 5.2 Agent API

| Method | Path | 描述 |
|--------|------|------|
| GET | /api/agents?projectId= | 获取项目Agent列表 |
| POST | /api/agents | 创建Agent |
| POST | /api/agents/clone | 克隆Agent |
| DELETE | /api/agents/:id | 删除Agent |
| GET | /api/agents/:id/status | 获取Agent状态 |

### 5.3 任务API

| Method | Path | 描述 |
|--------|------|------|
| GET | /api/tasks?projectId= | 获取项目任务列表（扁平） |
| GET | /api/tasks/:id | 获取任务详情 |
| POST | /api/tasks | 创建任务 |
| PUT | /api/tasks/:id | 更新任务 |
| DELETE | /api/tasks/:id | 删除任务 |
| POST | /api/tasks/:id/assign | 分配Agent |
| POST | /api/tasks/:id/review | 验收任务（父→子） |
| GET | /api/tasks/:id/stream | SSE输出流 |

### 5.4 上下文API

| Method | Path | 描述 |
|--------|------|------|
| GET | /api/projects/:id/context | 获取上下文文档 |
| PUT | /api/projects/:id/context | 更新上下文文档 |

---

## 六、前端交互设计

### 6.1 页面布局

```
┌─────────────────────────────────────────────────────────┐
│  Header: 项目切换 / 项目名称 / 刷新按钮                  │
├─────────────┬───────────────────────────────────────────┤
│             │                                           │
│  左侧面板   │              任务看板                      │
│             │                                           │
│  ┌─────────┐│  ┌─────────┬─────────┬─────────┬──────┐│
│  │ 制造员工 ││  │  todo   │ doing   │ waiting │ done ││
│  │ + 克隆  ││  │         │         │         │      ││
│  └─────────┘│  │ [任务1] │ [任务3] │ [任务5] │[任务7]││
│             │  │ [任务2] │         │         │      ││
│  Agent列表  │  │         │         │         │      ││
│  ┌─────────┐│  │ ┌───────┤         │         │      ││
│  │Agent1 ○ ││  │ │父任务4├┤         │         │      ││
│  │ idle    ││  │ │├子任务a│         │         │      ││
│  ├─────────┤│  │ │├子任务b│         │         │      ││
│  │Agent2 ● ││  │ │└───────┘│         │         │      ││
│  │ working ││  └─────────┴─────────┴─────────┴──────┘│
│  └─────────┘│                                           │
│             │  ┌─────────────────────────────────────┐  │
│             │  │ 任务详情弹窗（选中任务后）            │  │
│             │  │ - 任务描述                            │  │
│             │  │ - Agent输出（实时SSE）               │  │
│             │  │ - 验收/打回按钮                       │  │
│             │  └─────────────────────────────────────┘  │
└─────────────┴───────────────────────────────────────────┘
```

### 6.2 任务卡片交互

- 点击卡片 → 打开详情弹窗
- 父任务卡片左侧有展开/收起按钮 → 展开显示子任务列表
- 拖拽 → 改变任务状态（仅手动操作）
- 选中任务 → 右侧可分配Agent

### 6.3 Agent分配流程

```
1. 选中任务卡片（高亮）
2. 点击左侧Agent列表中的某个Agent
3. 弹出确认框（可选：查看Agent信息/修改任务描述）
4. 确认后：
   - 任务状态 → doing
   - Agent状态 → working
   - 任务详情弹窗自动打开，显示实时输出
5. Agent执行完成：
   - 如果是子任务 → 自动通知父任务验收
   - 如果是普通任务 → 状态 → review（等待用户验收）
```

---

## 七、后端核心逻辑

### 7.1 Agent进程管理

```javascript
// Agent进程池
const agentProcesses = new Map();
// key: agentId, value: { process, taskId, output, model }

// 启动Agent
async function startAgent(agentId, taskId) {
  // 1. 读取Agent配置
  // 2. 读取任务配置
  // 3. 读取context.json
  // 4. 构建prompt（Agent identity + task description + context）
  // 5. 启动Hermes进程
  // 6. 建立SSE连接推送给前端
}

// 停止Agent
function stopAgent(agentId) {
  // 1. kill进程
  // 2. 更新状态
  // 3. 任务状态回归
}
```

### 7.2 事件引擎

```javascript
// 简单的事件总线
const eventBus = new EventEmitter();

// 订阅事件
eventBus.on('TASK_COMPLETED', async (data) => {
  const { taskId, projectId } = data;
  // 通知父任务验收
  await handleTaskCompletion(taskId, projectId);
});
```

### 7.3 父任务验收逻辑

```javascript
async function handleTaskCompletion(childTaskId, projectId) {
  // 1. 读取子任务数据
  // 2. 找到父任务
  // 3. 父任务验收子任务
  //    - 检查子任务产出是否符合要求
  //    - 通过：写入父任务的receipts
  //    - 打回：子任务状态=todo，事件通知Agent继续
  // 4. 检查是否所有子任务都完成
  // 5. 如果全完成：父任务切换doing，Agent继续执行
  // 6. 父任务完成后：写回context.json，状态=done
}
```

---

## 八、Agent模型集成

### 8.1 Hermes本地Agent

**配置项：**
- Herms Agent CLI路径
- 模型名称
- 系统Prompt（来自Agent配置）

**调用方式：**
```bash
hermes --model <modelName> --prompt "<systemPrompt>\n\n<taskDescription>"
```

### 8.2 模型无关设计

后续可扩展支持：
- OpenAI GPT
- Anthropic Claude
- 本地Ollama
- 自定义API

通过 `model.provider` + `model.config` 解耦

---

## 九、非功能性需求

### 9.1 性能
- 前端轮询间隔：3秒（状态同步）
- SSE推送延迟：<1秒
- 文件系统操作：同步JSON读写（数据量小）

### 9.2 数据安全
- 项目数据完全隔离
- Agent进程资源限制
- 无网络依赖，纯本地运行

### 9.3 可扩展性
- 事件驱动架构，易于添加新事件类型
- Agent模型可插拔
- 任务类型可扩展（增加字段即可）

---

## 十、开发计划

### Phase 1: 基础骨架
- [ ] 项目目录结构搭建
- [ ] 数据结构定义
- [ ] Express路由骨架
- [ ] 前端项目框架

### Phase 2: 项目管理
- [ ] 项目CRUD API
- [ ] 前端项目列表/切换

### Phase 3: Agent管理
- [ ] Agent CRUD API
- [ ] Agent制造/克隆功能
- [ ] 左侧Agent面板

### Phase 4: 任务管理
- [ ] 任务CRUD API
- [ ] 父子任务关系
- [ ] 看板展示
- [ ] 任务展开

### Phase 5: Agent执行
- [ ] Hermes进程托管
- [ ] SSE输出推送
- [ ] 任务分配流程

### Phase 6: 事件驱动
- [ ] 事件总线
- [ ] 子任务完成通知
- [ ] 父任务验收逻辑
- [ ] 上下文写回

### Phase 7: 完善
- [ ] 任务详情弹窗
- [ ] 实时输出
- [ ] 状态同步
- [ ] UI优化
