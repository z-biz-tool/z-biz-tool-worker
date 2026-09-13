import { useMemo, useState } from "react";
import { Table, Tag, Button, Space, Select, Modal, Input, message, Dropdown, Typography } from "antd";
import { PlusOutlined, DeleteOutlined, UserOutlined } from "@ant-design/icons";
import type { ColumnsType } from "antd/es/table";
import type { Task, Agent } from "../../types";
import { useWorkerStore } from "../../stores/workerStore";

const { Text } = Typography;
const { TextArea } = Input;

const STATUS_MAP: Record<string, { color: string; label: string }> = {
  todo: { color: "default", label: "待处理" },
  doing: { color: "processing", label: "进行中" },
  waiting: { color: "warning", label: "等待中" },
  review: { color: "orange", label: "待验收" },
  done: { color: "success", label: "已完成" },
};

const PRIORITY_MAP: Record<number, { color: string; label: string }> = {
  0: { color: "default", label: "无" },
  1: { color: "blue", label: "低" },
  2: { color: "orange", label: "中" },
  3: { color: "red", label: "高" },
};

interface ListViewProps {
  tasks: Task[];
  agents: Agent[];
  onTaskClick: (task: Task) => void;
}

export default function ListView({ tasks, agents, onTaskClick }: ListViewProps) {
  const store = useWorkerStore();
  const [newTaskOpen, setNewTaskOpen] = useState(false);
  const [newTaskForm, setNewTaskForm] = useState({ title: "", desc: "" });
  const [selectedRowKeys, setSelectedRowKeys] = useState<React.Key[]>([]);

  const handleCreateTask = async () => {
    if (!newTaskForm.title.trim()) return message.warning("请输入任务标题");
    const currentProject = store.projects.find((p) => p.id === store.currentProjectId);
    if (!currentProject) return;
    await store.createTask(currentProject.id, newTaskForm.title, newTaskForm.desc);
    setNewTaskOpen(false);
    setNewTaskForm({ title: "", desc: "" });
  };

  const handleBatchStatusChange = async (status: string) => {
    for (const id of selectedRowKeys) {
      await store.updateTaskStatus(id as string, status);
    }
    setSelectedRowKeys([]);
    message.success(`已批量更新 ${selectedRowKeys.length} 个任务`);
  };

  const columns: ColumnsType<Task> = [
    {
      title: "标题",
      dataIndex: "title",
      key: "title",
      render: (text, record) => (
        <a onClick={() => onTaskClick(record)}>{text}</a>
      ),
      sorter: (a, b) => a.title.localeCompare(b.title),
    },
    {
      title: "状态",
      dataIndex: "status",
      key: "status",
      width: 100,
      render: (status: string) => {
        const cfg = STATUS_MAP[status] || { color: "default", label: status };
        return <Tag color={cfg.color}>{cfg.label}</Tag>;
      },
      filters: Object.entries(STATUS_MAP).map(([k, v]) => ({ text: v.label, value: k })),
      onFilter: (value, record) => record.status === value,
    },
    {
      title: "优先级",
      dataIndex: "priority",
      key: "priority",
      width: 80,
      render: (p: number) => {
        const cfg = PRIORITY_MAP[p] || { color: "default", label: "无" };
        return <Tag color={cfg.color}>{cfg.label}</Tag>;
      },
      sorter: (a, b) => a.priority - b.priority,
    },
    {
      title: "Agent",
      dataIndex: "assigned_agent_name",
      key: "agent",
      width: 120,
      render: (name: string | null) => name || <Text type="secondary">未分配</Text>,
    },
    {
      title: "截止日期",
      dataIndex: "due_date",
      key: "due_date",
      width: 120,
      render: (d: string | null) =>
        d ? new Date(d).toLocaleDateString("zh-CN") : <Text type="secondary">-</Text>,
      sorter: (a, b) => (a.due_date || "").localeCompare(b.due_date || ""),
    },
    {
      title: "创建时间",
      dataIndex: "created_at",
      key: "created_at",
      width: 120,
      render: (d: string) => new Date(d).toLocaleDateString("zh-CN"),
      sorter: (a, b) => a.created_at.localeCompare(b.created_at),
      defaultSortOrder: "descend",
    },
    {
      title: "操作",
      key: "actions",
      width: 80,
      render: (_, record) => (
        <Dropdown
          menu={{
            items: [
              { key: "del", label: "删除", icon: <DeleteOutlined />, danger: true },
            ],
            onClick: ({ key }) => {
              if (key === "del") {
                Modal.confirm({
                  title: `删除任务 "${record.title}"?`,
                  onOk: () => store.deleteTask(record.id),
                });
              }
            },
          }}
          trigger={["click"]}
        >
          <Button type="text" size="small" icon={<DeleteOutlined />} />
        </Dropdown>
      ),
    },
  ];

  return (
    <div>
      <div style={{ marginBottom: 12, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <Space>
          {selectedRowKeys.length > 0 && (
            <Space>
              <Text>已选 {selectedRowKeys.length} 项</Text>
              <Select
                placeholder="批量改状态"
                style={{ width: 130 }}
                onChange={handleBatchStatusChange}
                options={Object.entries(STATUS_MAP).map(([k, v]) => ({ value: k, label: v.label }))}
              />
              <Button danger onClick={() => setSelectedRowKeys([])}>取消选择</Button>
            </Space>
          )}
        </Space>
        <Button type="primary" icon={<PlusOutlined />} onClick={() => setNewTaskOpen(true)}>
          新建任务
        </Button>
      </div>

      <Table
        rowSelection={{
          selectedRowKeys,
          onChange: setSelectedRowKeys,
        }}
        columns={columns}
        dataSource={tasks}
        rowKey="id"
        size="small"
        pagination={{ pageSize: 20, showSizeChanger: true, showTotal: (t) => `共 ${t} 条` }}
        onRow={(record) => ({ onClick: () => onTaskClick(record), style: { cursor: "pointer" } })}
      />

      <Modal title="新建任务" open={newTaskOpen} onOk={handleCreateTask} onCancel={() => setNewTaskOpen(false)}>
        <Input
          placeholder="任务标题"
          value={newTaskForm.title}
          onChange={(e) => setNewTaskForm({ ...newTaskForm, title: e.target.value })}
          style={{ marginBottom: 8 }}
        />
        <TextArea
          placeholder="任务描述"
          rows={4}
          value={newTaskForm.desc}
          onChange={(e) => setNewTaskForm({ ...newTaskForm, desc: e.target.value })}
        />
      </Modal>
    </div>
  );
}
