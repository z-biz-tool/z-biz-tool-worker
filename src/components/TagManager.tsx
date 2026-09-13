import { useState, useEffect } from "react";
import { Card, Typography, Button, Space, Input, Tag, Empty, Modal, message, ColorPicker } from "antd";
import { PlusOutlined, DeleteOutlined, TagsOutlined } from "@ant-design/icons";
import { invoke } from "@tauri-apps/api/core";
import type { Tag as TagType } from "../types";

const { Text } = Typography;

const TAG_COLORS = ["#1677ff", "#52c41a", "#faad14", "#eb2f96", "#722ed1", "#13c2c2", "#ff4d4f", "#fa8c16"];

interface TagManagerProps {
  projectId: string;
}

export default function TagManager({ projectId }: TagManagerProps) {
  const [tags, setTags] = useState<TagType[]>([]);
  const [newTagName, setNewTagName] = useState("");
  const [newTagColor, setNewTagColor] = useState("#1677ff");
  const [loading, setLoading] = useState(false);

  const loadTags = async () => {
    try {
      const result = await invoke<TagType[]>("list_tags", { projectId });
      setTags(result);
    } catch {}
  };

  useEffect(() => { if (projectId) loadTags(); }, [projectId]);

  const handleCreate = async () => {
    if (!newTagName.trim()) return message.warning("请输入标签名称");
    if (tags.some((t) => t.name === newTagName.trim())) return message.warning("标签已存在");
    setLoading(true);
    try {
      const tag = await invoke<TagType>("create_tag", {
        projectId,
        name: newTagName.trim(),
        color: newTagColor,
      });
      setTags([...tags, tag]);
      setNewTagName("");
      message.success("标签已创建");
    } catch {
      message.error("创建失败");
    } finally {
      setLoading(false);
    }
  };

  const handleDelete = async (tagId: string) => {
    Modal.confirm({
      title: "确定删除此标签?",
      content: "删除后，使用该标签的任务将移除该标签",
      onOk: async () => {
        try {
          await invoke("delete_tag", { id: tagId });
          setTags(tags.filter((t) => t.id !== tagId));
          message.success("已删除");
        } catch {
          message.error("删除失败");
        }
      },
    });
  };

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
        <Space>
          <TagsOutlined />
          <Text strong>标签管理</Text>
          <Text type="secondary">({tags.length} 个标签)</Text>
        </Space>
      </div>

      {/* 新建标签 */}
      <Card size="small" style={{ marginBottom: 16 }}>
        <Space>
          <input
            type="color"
            value={newTagColor}
            onChange={(e) => setNewTagColor(e.target.value)}
            style={{ width: 32, height: 32, border: "none", cursor: "pointer", borderRadius: 4 }}
          />
          <Input
            placeholder="标签名称"
            value={newTagName}
            onChange={(e) => setNewTagName(e.target.value)}
            onPressEnter={handleCreate}
            style={{ width: 200 }}
          />
          <Button type="primary" icon={<PlusOutlined />} onClick={handleCreate} loading={loading}>
            创建
          </Button>
        </Space>
      </Card>

      {/* 标签列表 */}
      {tags.length === 0 ? (
        <Empty description="暂无标签" image={Empty.PRESENTED_IMAGE_SIMPLE} />
      ) : (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
          {tags.map((tag) => (
            <Card
              key={tag.id}
              size="small"
              style={{ minWidth: 120 }}
              hoverable
            >
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                <Space>
                  <div style={{ width: 12, height: 12, borderRadius: "50%", background: tag.color }} />
                  <Text>{tag.name}</Text>
                </Space>
                <Button
                  type="text"
                  size="small"
                  danger
                  icon={<DeleteOutlined />}
                  onClick={() => handleDelete(tag.id)}
                />
              </div>
            </Card>
          ))}
        </div>
      )}

      {/* 预设颜色 */}
      <div style={{ marginTop: 16 }}>
        <Text type="secondary" style={{ fontSize: 12, marginBottom: 8, display: "block" }}>预设颜色</Text>
        <Space>
          {TAG_COLORS.map((color) => (
            <div
              key={color}
              onClick={() => setNewTagColor(color)}
              style={{
                width: 24, height: 24, borderRadius: "50%", background: color,
                cursor: "pointer", border: newTagColor === color ? "2px solid #333" : "2px solid transparent",
              }}
            />
          ))}
        </Space>
      </div>
    </div>
  );
}
