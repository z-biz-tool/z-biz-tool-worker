import { useState } from "react";
import { Card, Typography, Button, Space, Input, Tag, Empty, Modal, message, Divider } from "antd";
import { PlusOutlined, DeleteOutlined, ArrowRightOutlined, SettingOutlined } from "@ant-design/icons";

const { Text } = Typography;

const DEFAULT_STATUSES = [
  { key: "todo", label: "待处理", color: "#d9d9d9" },
  { key: "doing", label: "进行中", color: "#1677ff" },
  { key: "waiting", label: "等待中", color: "#faad14" },
  { key: "review", label: "待验收", color: "#ff7a45" },
  { key: "done", label: "已完成", color: "#52c41a" },
];

interface StatusItem {
  key: string;
  label: string;
  color: string;
}

interface WorkflowEditorProps {
  onSave?: (statuses: StatusItem[]) => void;
}

export default function WorkflowEditor({ onSave }: WorkflowEditorProps) {
  const [statuses, setStatuses] = useState<StatusItem[]>(DEFAULT_STATUSES);
  const [editOpen, setEditOpen] = useState(false);
  const [editForm, setEditForm] = useState<StatusItem>({ key: "", label: "", color: "#1677ff" });
  const [editIndex, setEditIndex] = useState<number | null>(null);

  const handleAdd = () => {
    setEditForm({ key: `status_${Date.now()}`, label: "", color: "#1677ff" });
    setEditIndex(null);
    setEditOpen(true);
  };

  const handleEdit = (index: number) => {
    setEditForm({ ...statuses[index] });
    setEditIndex(index);
    setEditOpen(true);
  };

  const handleSaveEdit = () => {
    if (!editForm.label.trim()) return message.warning("请输入状态名称");
    if (editIndex !== null) {
      const next = [...statuses];
      next[editIndex] = editForm;
      setStatuses(next);
    } else {
      setStatuses([...statuses, editForm]);
    }
    setEditOpen(false);
  };

  const handleDelete = (index: number) => {
    Modal.confirm({
      title: `删除状态「${statuses[index].label}」?`,
      content: "删除后使用该状态的任务将变为「待处理」",
      onOk: () => {
        setStatuses(statuses.filter((_, i) => i !== index));
        message.success("已删除");
      },
    });
  };

  const handleMove = (from: number, to: number) => {
    if (to < 0 || to >= statuses.length) return;
    const next = [...statuses];
    const [item] = next.splice(from, 1);
    next.splice(to, 0, item);
    setStatuses(next);
  };

  const handleSave = () => {
    if (onSave) onSave(statuses);
    message.success("工作流已保存");
  };

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
        <Space>
          <SettingOutlined />
          <Text strong>自定义工作流</Text>
          <Text type="secondary">({statuses.length} 个状态)</Text>
        </Space>
        <Space>
          <Button icon={<PlusOutlined />} onClick={handleAdd}>添加状态</Button>
          <Button type="primary" onClick={handleSave}>保存</Button>
        </Space>
      </div>

      <Text type="secondary" style={{ marginBottom: 12, display: "block", fontSize: 12 }}>
        拖拽调整状态顺序，任务状态将按此顺序流转
      </Text>

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        {statuses.map((s, i) => (
          <div key={s.key} style={{ display: "flex", alignItems: "center", gap: 4 }}>
            <Card
              size="small"
              hoverable
              style={{ cursor: "pointer", minWidth: 100 }}
              onClick={() => handleEdit(i)}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <div style={{ width: 12, height: 12, borderRadius: "50%", background: s.color, flexShrink: 0 }} />
                <Text style={{ fontSize: 13 }}>{s.label}</Text>
                <Button
                  type="text"
                  size="small"
                  danger
                  icon={<DeleteOutlined />}
                  onClick={(e) => { e.stopPropagation(); handleDelete(i); }}
                />
              </div>
            </Card>
            {i < statuses.length - 1 && (
              <ArrowRightOutlined style={{ color: "#bbb" }} />
            )}
          </div>
        ))}
      </div>

      <Modal
        title={editIndex !== null ? "编辑状态" : "添加状态"}
        open={editOpen}
        onOk={handleSaveEdit}
        onCancel={() => setEditOpen(false)}
      >
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <div>
            <Text type="secondary" style={{ fontSize: 12, marginBottom: 4, display: "block" }}>状态名称</Text>
            <Input
              value={editForm.label}
              onChange={(e) => setEditForm({ ...editForm, label: e.target.value })}
              placeholder="如：测试中"
            />
          </div>
          <div>
            <Text type="secondary" style={{ fontSize: 12, marginBottom: 4, display: "block" }}>颜色</Text>
            <input
              type="color"
              value={editForm.color}
              onChange={(e) => setEditForm({ ...editForm, color: e.target.value })}
              style={{ width: 40, height: 32, border: "none", cursor: "pointer" }}
            />
          </div>
        </div>
      </Modal>
    </div>
  );
}
