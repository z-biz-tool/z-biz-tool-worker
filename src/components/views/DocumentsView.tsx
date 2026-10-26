import { useState, useEffect, useRef } from "react";
import { Card, Button, Input, List, Typography, Space, Modal, Empty, message, Spin, Alert } from "antd";
import { PlusOutlined, FileTextOutlined, DeleteOutlined, EditOutlined } from "@ant-design/icons";
import { invoke } from "@tauri-apps/api/core";
import MDEditor from "@uiw/react-md-editor";
import type { ProjectDocument } from "../../types";
import {
  addDocument, isDocumentDirty, nextSelectionAfterRemove, removeDocument, replaceDocument,
} from "../../utils/documentsLayout";

const { Text } = Typography;

const errorText = (e: unknown): string => {
  if (typeof e === "string") return e;
  if (e instanceof Error) return e.message;
  return String(e);
};

interface DocumentsViewProps {
  projectId: string;
}

export default function DocumentsView({ projectId }: DocumentsViewProps) {
  const [docs, setDocs] = useState<ProjectDocument[]>([]);
  const [selectedDoc, setSelectedDoc] = useState<ProjectDocument | null>(null);
  const [editMode, setEditMode] = useState(false);
  const [editContent, setEditContent] = useState("");
  const [newDocOpen, setNewDocOpen] = useState(false);
  const [newDocTitle, setNewDocTitle] = useState("");
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [creating, setCreating] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const loadSeq = useRef(0);

  const loadDocs = async () => {
    const seq = ++loadSeq.current;
    if (!projectId) {
      setDocs([]);
      setSelectedDoc(null);
      setEditMode(false);
      setLoadError(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    setLoadError(null);
    try {
      const result = await invoke<ProjectDocument[]>("list_documents", { projectId });
      if (seq !== loadSeq.current) return; // 项目已经切走，旧请求的结果不能覆盖新项目
      setDocs(result);
    } catch (e) {
      if (seq !== loadSeq.current) return;
      // 加载失败不能显示成「暂无文档」—— 那是在编数据。
      setDocs([]);
      setLoadError(errorText(e));
    } finally {
      if (seq === loadSeq.current) setLoading(false);
    }
  };

  useEffect(() => {
    // 切项目时先清干净，避免上一个项目的文档停留一帧被误点
    setDocs([]);
    setSelectedDoc(null);
    setEditMode(false);
    setEditContent("");
    void loadDocs();
  }, [projectId]);

  const dirty = editMode && isDocumentDirty(selectedDoc, editContent);

  const confirmDiscard = (onOk: () => void) => {
    if (!dirty || !selectedDoc) {
      onOk();
      return;
    }
    Modal.confirm({
      title: "放弃未保存的修改？",
      content: `「${selectedDoc.title}」有未保存的内容，离开后这些修改会丢失。`,
      okText: "放弃修改",
      cancelText: "继续编辑",
      okButtonProps: { danger: true },
      autoFocusButton: "cancel",
      onOk,
    });
  };

  const openDoc = (doc: ProjectDocument) => {
    confirmDiscard(() => {
      setSelectedDoc(doc);
      setEditContent(doc.content);
      setEditMode(false);
    });
  };

  const handleCreateDoc = async () => {
    if (!newDocTitle.trim()) {
      message.warning("请输入文档标题");
      throw new Error("empty title");
    }
    setCreating(true);
    try {
      const doc = await invoke<ProjectDocument>("create_document", {
        projectId,
        title: newDocTitle.trim(),
        content: "",
      });
      setDocs((prev) => addDocument(prev, doc));
      setNewDocOpen(false);
      setNewDocTitle("");
      confirmDiscard(() => {
        setSelectedDoc(doc);
        setEditMode(true);
        setEditContent("");
      });
      message.success("文档已创建");
    } catch (e) {
      message.error(`创建失败：${errorText(e)}`);
      throw e; // 失败时保持弹窗与已填标题
    } finally {
      setCreating(false);
    }
  };

  const handleSaveDoc = async () => {
    if (!selectedDoc) return;
    setSaving(true);
    try {
      const updated = await invoke<ProjectDocument>("update_document", {
        docId: selectedDoc.id,
        title: undefined,
        content: editContent,
      });
      setDocs((prev) => replaceDocument(prev, updated));
      setSelectedDoc(updated);
      setEditMode(false);
      message.success("已保存");
    } catch (e) {
      message.error(`保存失败：${errorText(e)}`);
    } finally {
      setSaving(false);
    }
  };

  const cancelEdit = () => {
    confirmDiscard(() => {
      setEditMode(false);
      setEditContent(selectedDoc?.content ?? "");
    });
  };

  const handleDeleteDoc = (doc: ProjectDocument) => {
    Modal.confirm({
      title: `删除文档「${doc.title}」？`,
      content: "正文删除后无法恢复。",
      okText: "删除",
      cancelText: "取消",
      okButtonProps: { danger: true },
      autoFocusButton: "cancel",
      onOk: async () => {
        setDeletingId(doc.id);
        try {
          await invoke("delete_document", { docId: doc.id });
        } catch (e) {
          message.error(`删除失败：${errorText(e)}`);
          throw e; // 弹窗不关，用户可以重试或取消
        } finally {
          setDeletingId(null);
        }
        const next = nextSelectionAfterRemove(docs, doc.id);
        setDocs((prev) => removeDocument(prev, doc.id));
        if (selectedDoc?.id === doc.id) {
          setSelectedDoc(next);
          setEditContent(next?.content ?? "");
          setEditMode(false);
        }
        message.success("文档已删除");
      },
    });
  };

  return (
    <div style={{ display: "flex", height: "calc(100vh - 180px)", gap: 16 }}>
      {/* 文档列表 */}
      <div style={{ width: 240, flexShrink: 0 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
          <Text strong>文档</Text>
          <Button
            size="small"
            icon={<PlusOutlined />}
            aria-label="新建文档"
            disabled={!projectId}
            onClick={() => setNewDocOpen(true)}
          />
        </div>
        {!projectId ? (
          <Alert type="info" showIcon message="请先选择项目" description="文档按项目隔离，选中项目后才能查看或新建。" />
        ) : loading ? (
          <div style={{ textAlign: "center", padding: 24 }}>
            <Spin size="small" />
          </div>
        ) : loadError ? (
          <Alert
            type="error"
            showIcon
            message="文档加载失败"
            description={loadError}
            action={<Button size="small" onClick={() => void loadDocs()}>重试</Button>}
          />
        ) : (
          <List
            size="small"
            dataSource={docs}
            renderItem={(doc) => (
              <List.Item
                style={{
                  cursor: "pointer",
                  background: selectedDoc?.id === doc.id ? "#e6f4ff" : undefined,
                  padding: "8px 12px",
                  borderRadius: 6,
                }}
                onClick={() => openDoc(doc)}
                actions={[
                  <Button
                    key="del"
                    type="text"
                    size="small"
                    danger
                    loading={deletingId === doc.id}
                    aria-label={`删除文档「${doc.title}」`}
                    icon={<DeleteOutlined />}
                    onClick={(e) => {
                      e.stopPropagation();
                      handleDeleteDoc(doc);
                    }}
                  />,
                ]}
              >
                <List.Item.Meta
                  avatar={<FileTextOutlined style={{ fontSize: 16, color: "#1677ff" }} />}
                  title={<Text style={{ fontSize: 13 }} ellipsis>{doc.title}</Text>}
                  description={
                    <Text type="secondary" style={{ fontSize: 11 }}>
                      {new Date(doc.updated_at).toLocaleDateString("zh-CN")}
                    </Text>
                  }
                />
              </List.Item>
            )}
            locale={{ emptyText: <Empty description="暂无文档" image={Empty.PRESENTED_IMAGE_SIMPLE} /> }}
          />
        )}
      </div>

      {/* 文档内容 */}
      <div style={{ flex: 1, display: "flex", flexDirection: "column" }}>
        {selectedDoc ? (
          <>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
              <Space>
                <Text strong style={{ fontSize: 16 }}>{selectedDoc.title}</Text>
                {dirty && <Text type="warning" style={{ fontSize: 12 }}>有未保存的修改</Text>}
              </Space>
              <Space>
                {editMode ? (
                  <>
                    <Button onClick={cancelEdit}>取消</Button>
                    <Button type="primary" loading={saving} onClick={handleSaveDoc}>保存</Button>
                  </>
                ) : (
                  <Button icon={<EditOutlined />} onClick={() => { setEditMode(true); setEditContent(selectedDoc.content); }}>
                    编辑
                  </Button>
                )}
              </Space>
            </div>
            {editMode ? (
              <div style={{ flex: 1, minHeight: 400 }} data-color-mode="light">
                <MDEditor
                  value={editContent}
                  onChange={(val) => setEditContent(val || "")}
                  height={500}
                  preview="live"
                />
              </div>
            ) : (
              <Card style={{ flex: 1, overflow: "auto" }}>
                <div data-color-mode="light">
                  <MDEditor.Markdown source={selectedDoc.content || "暂无内容，点击编辑开始撰写"} />
                </div>
              </Card>
            )}
          </>
        ) : (
          <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center" }}>
            <Empty description={loadError ? "文档加载失败，请重试" : "选择或创建一个文档"} />
          </div>
        )}
      </div>

      <Modal
        title="新建文档"
        open={newDocOpen}
        confirmLoading={creating}
        onOk={handleCreateDoc}
        onCancel={() => setNewDocOpen(false)}
      >
        <Input
          placeholder="文档标题"
          value={newDocTitle}
          onChange={(e) => setNewDocTitle(e.target.value)}
          onPressEnter={handleCreateDoc}
        />
      </Modal>
    </div>
  );
}
