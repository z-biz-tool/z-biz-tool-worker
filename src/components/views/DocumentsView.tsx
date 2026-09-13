import { useState, useEffect } from "react";
import { Card, Button, Input, List, Typography, Space, Modal, Empty, message } from "antd";
import { PlusOutlined, FileTextOutlined, DeleteOutlined, EditOutlined } from "@ant-design/icons";
import { invoke } from "@tauri-apps/api/core";
import MDEditor from "@uiw/react-md-editor";
import type { ProjectDocument } from "../../types";

const { Text } = Typography;

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

  const loadDocs = async () => {
    try {
      const result = await invoke<ProjectDocument[]>("list_documents", { projectId });
      setDocs(result);
    } catch (e) {
      console.error("load docs failed:", e);
    }
  };

  useEffect(() => {
    if (projectId) loadDocs();
  }, [projectId]);

  const handleCreateDoc = async () => {
    if (!newDocTitle.trim()) return message.warning("请输入文档标题");
    try {
      const doc = await invoke<ProjectDocument>("create_document", {
        projectId,
        title: newDocTitle,
        content: "",
      });
      setDocs([doc, ...docs]);
      setNewDocOpen(false);
      setNewDocTitle("");
      setSelectedDoc(doc);
      setEditMode(true);
      setEditContent("");
    } catch (e) {
      message.error("创建失败");
    }
  };

  const handleSaveDoc = async () => {
    if (!selectedDoc) return;
    try {
      const updated = await invoke<ProjectDocument>("update_document", {
        docId: selectedDoc.id,
        title: undefined,
        content: editContent,
      });
      setDocs(docs.map((d) => (d.id === updated.id ? updated : d)));
      setSelectedDoc(updated);
      setEditMode(false);
      message.success("已保存");
    } catch (e) {
      message.error("保存失败");
    }
  };

  const handleDeleteDoc = async (docId: string) => {
    Modal.confirm({
      title: "确定删除此文档?",
      onOk: async () => {
        try {
          await invoke("delete_document", { docId });
          setDocs(docs.filter((d) => d.id !== docId));
          if (selectedDoc?.id === docId) setSelectedDoc(null);
          message.success("已删除");
        } catch (e) {
          message.error("删除失败");
        }
      },
    });
  };

  return (
    <div style={{ display: "flex", height: "calc(100vh - 180px)", gap: 16 }}>
      {/* 文档列表 */}
      <div style={{ width: 240, flexShrink: 0 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
          <Text strong>文档</Text>
          <Button size="small" icon={<PlusOutlined />} onClick={() => setNewDocOpen(true)} />
        </div>
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
              onClick={() => {
                setSelectedDoc(doc);
                setEditContent(doc.content);
                setEditMode(false);
              }}
              actions={[
                <Button
                  key="del"
                  type="text"
                  size="small"
                  danger
                  icon={<DeleteOutlined />}
                  onClick={(e) => {
                    e.stopPropagation();
                    handleDeleteDoc(doc.id);
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
      </div>

      {/* 文档内容 */}
      <div style={{ flex: 1, display: "flex", flexDirection: "column" }}>
        {selectedDoc ? (
          <>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
              <Text strong style={{ fontSize: 16 }}>{selectedDoc.title}</Text>
              <Space>
                {editMode ? (
                  <>
                    <Button onClick={() => setEditMode(false)}>取消</Button>
                    <Button type="primary" onClick={handleSaveDoc}>保存</Button>
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
            <Empty description="选择或创建一个文档" />
          </div>
        )}
      </div>

      <Modal title="新建文档" open={newDocOpen} onOk={handleCreateDoc} onCancel={() => setNewDocOpen(false)}>
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
