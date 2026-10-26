import { useState, useEffect, useRef } from "react";
import { Card, Typography, Button, Space, Input, Tag, Empty, Modal, message, Spin, Alert } from "antd";
import { PlusOutlined, DeleteOutlined, TagsOutlined } from "@ant-design/icons";
import { invoke } from "@tauri-apps/api/core";
import type { Tag as TagType } from "../types";

const { Text } = Typography;

const TAG_COLORS = ["#1677ff", "#52c41a", "#faad14", "#eb2f96", "#722ed1", "#13c2c2", "#ff4d4f", "#fa8c16"];

const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

interface TagManagerProps {
  projectId: string;
}

export default function TagManager({ projectId }: TagManagerProps) {
  const [tags, setTags] = useState<TagType[]>([]);
  const [newTagName, setNewTagName] = useState("");
  const [newTagColor, setNewTagColor] = useState("#1677ff");
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const loadSeq = useRef(0);

  const loadTags = async () => {
    const seq = ++loadSeq.current;
    if (!projectId) {
      setTags([]);
      setLoadError(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    setLoadError(null);
    try {
      const result = await invoke<TagType[]>("list_tags", { projectId });
      if (seq !== loadSeq.current) return;
      setTags(result);
    } catch (e) {
      if (seq !== loadSeq.current) return;
      // 原实现 catch {} —— 标签加载失败时界面显示「暂无标签」，纯属编造。
      setTags([]);
      setLoadError(errorText(e));
    } finally {
      if (seq === loadSeq.current) setLoading(false);
    }
  };

  useEffect(() => {
    setTags([]);
    void loadTags();
  }, [projectId]);

  const handleCreate = async () => {
    if (!newTagName.trim()) return message.warning("请输入标签名称");
    if (tags.some((t) => t.name === newTagName.trim())) return message.warning("标签已存在");
    setCreating(true);
    try {
      const tag = await invoke<TagType>("create_tag", {
        projectId,
        name: newTagName.trim(),
        color: newTagColor,
      });
      setTags([...tags, tag]);
      setNewTagName("");
      message.success("标签已创建");
    } catch (e) {
      message.error(`创建失败：${errorText(e)}`);
    } finally {
      setCreating(false);
    }
  };

  const handleDelete = (tag: TagType) => {
    Modal.confirm({
      title: `删除标签「${tag.name}」？`,
      content: "使用该标签的任务会移除这个标签，删除后无法恢复。",
      okText: "删除",
      cancelText: "取消",
      okButtonProps: { danger: true },
      autoFocusButton: "cancel",
      onOk: async () => {
        setDeletingId(tag.id);
        try {
          await invoke("delete_tag", { id: tag.id });
        } catch (e) {
          message.error(`删除失败：${errorText(e)}`);
          throw e;
        } finally {
          setDeletingId(null);
        }
        setTags((prev) => prev.filter((t) => t.id !== tag.id));
        message.success("已删除");
      },
    });
  };

  if (!projectId) {
    return (
      <Alert
        type="info"
        showIcon
        message="请先选择项目"
        description="标签按项目隔离，选中项目后才能管理标签。"
      />
    );
  }

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
            aria-label="标签颜色"
            value={newTagColor}
            onChange={(e) => setNewTagColor(e.target.value)}
            style={{ width: 32, height: 32, border: "none", cursor: "pointer", borderRadius: 4 }}
          />
          <Input
            aria-label="标签名称"
            placeholder="标签名称"
            value={newTagName}
            onChange={(e) => setNewTagName(e.target.value)}
            onPressEnter={handleCreate}
            style={{ width: 200 }}
          />
          <Button type="primary" icon={<PlusOutlined />} onClick={handleCreate} loading={creating}>
            创建
          </Button>
        </Space>
      </Card>

      {/* 标签列表 */}
      {loading ? (
        <div style={{ textAlign: "center", padding: 24 }}>
          <Spin size="small" />
        </div>
      ) : loadError ? (
        <Alert
          type="error"
          showIcon
          message="标签加载失败"
          description={loadError}
          action={<Button size="small" onClick={() => void loadTags()}>重试</Button>}
        />
      ) : tags.length === 0 ? (
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
                  loading={deletingId === tag.id}
                  aria-label={`删除标签「${tag.name}」`}
                  icon={<DeleteOutlined />}
                  onClick={() => handleDelete(tag)}
                />
              </div>
            </Card>
          ))}
        </div>
      )}

      {/* 预设颜色：用 button 而不是 div，才能 Tab 到、回车选中 */}
      <div style={{ marginTop: 16 }}>
        <Text type="secondary" style={{ fontSize: 12, marginBottom: 8, display: "block" }}>预设颜色</Text>
        <Space>
          {TAG_COLORS.map((color) => (
            <button
              key={color}
              type="button"
              aria-label={`使用颜色 ${color}`}
              aria-pressed={newTagColor === color}
              onClick={() => setNewTagColor(color)}
              style={{
                width: 24, height: 24, borderRadius: "50%", background: color, padding: 0,
                cursor: "pointer", border: newTagColor === color ? "2px solid #333" : "2px solid transparent",
              }}
            />
          ))}
        </Space>
      </div>
    </div>
  );
}
