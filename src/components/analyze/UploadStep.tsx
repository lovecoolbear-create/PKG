"use client";

import { useCallback, useState } from "react";
import { Upload, FileText, Image, X, Loader2 } from "lucide-react";
import type { UploadedFileMeta } from "@/types";
import { cn } from "@/lib/utils";

interface UploadStepProps {
  files: UploadedFileMeta[];
  onFilesChange: (files: UploadedFileMeta[]) => void;
  feedback: string[];
  productType: string;
}

export function UploadStep({ files, onFilesChange, feedback, productType }: UploadStepProps) {
  const [uploading, setUploading] = useState(false);
  const [dragOver, setDragOver] = useState(false);

  const handleUpload = useCallback(
    async (fileList: FileList, category: "design" | "photo") => {
      setUploading(true);
      const newFiles: UploadedFileMeta[] = [];
      const newFeedback: string[] = [];

      for (const file of Array.from(fileList)) {
        const formData = new FormData();
        formData.append("file", file);
        formData.append("category", category);
        formData.append("productType", productType);

        try {
          const res = await fetch("/api/upload", {
            method: "POST",
            body: formData,
          });
          const data = await res.json();
          if (res.ok) {
            newFiles.push(data.file);
            newFeedback.push(data.feedback);
          }
        } catch {
          // skip failed uploads
        }
      }

      onFilesChange([...files, ...newFiles]);
      setUploading(false);
    },
    [files, onFilesChange]
  );

  const removeFile = (id: string) => {
    onFilesChange(files.filter((f) => f.id !== id));
  };

  const onDrop = useCallback(
    (e: React.DragEvent, category: "design" | "photo") => {
      e.preventDefault();
      setDragOver(false);
      if (e.dataTransfer.files.length > 0) {
        handleUpload(e.dataTransfer.files, category);
      }
    },
    [handleUpload]
  );

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-bold text-brand-900">上传设计图纸与产品照片</h2>
        <p className="mt-1 text-sm text-brand-600">
          支持 PDF、JPG、PNG 格式，单文件最大 10MB。上传后可帮助系统更准确识别产品特征。
        </p>
      </div>

      {/* Design upload */}
      <DropZone
        label="设计图纸"
        description={
          productType === "flat_print"
            ? "PDF 设计稿、排版文件、成品样图等"
            : "盒型展开图、刀线图、设计稿等"
        }
        icon={<FileText className="h-8 w-8 text-brand-400" />}
        category="design"
        dragOver={dragOver}
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => onDrop(e, "design")}
        onFileSelect={(fl) => handleUpload(fl, "design")}
        uploading={uploading}
      />

      {/* Photo upload */}
      <DropZone
        label="产品照片"
        description="成品参考图、材质效果照片等"
        icon={<Image className="h-8 w-8 text-brand-400" />}
        category="photo"
        dragOver={false}
        onDragOver={(e) => e.preventDefault()}
        onDragLeave={() => {}}
        onDrop={(e) => onDrop(e, "photo")}
        onFileSelect={(fl) => handleUpload(fl, "photo")}
        uploading={uploading}
      />

      {/* Uploaded files list */}
      {files.length > 0 && (
        <div className="space-y-2">
          <h3 className="text-sm font-medium text-brand-700">已上传文件</h3>
          {files.map((file) => (
            <div
              key={file.id}
              className="flex items-center justify-between rounded-lg border border-brand-200 bg-white px-4 py-3"
            >
              <div className="flex items-center gap-3">
                {file.category === "design" ? (
                  <FileText className="h-5 w-5 text-brand-500" />
                ) : (
                  <Image className="h-5 w-5 text-brand-500" />
                )}
                <div>
                  <p className="text-sm font-medium text-brand-800">{file.name}</p>
                  <p className="text-xs text-brand-400">
                    {(file.size / 1024).toFixed(0)} KB ·{" "}
                    {file.category === "design" ? "设计图纸" : "产品照片"}
                  </p>
                </div>
              </div>
              <button
                onClick={() => removeFile(file.id)}
                className="rounded p-1 text-brand-400 hover:bg-brand-100 hover:text-brand-600"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Feedback */}
      {feedback.length > 0 && (
        <div className="rounded-lg border border-green-200 bg-green-50 p-4">
          <p className="text-sm font-medium text-green-800">识别反馈</p>
          <ul className="mt-2 space-y-1">
            {feedback.map((f, i) => (
              <li key={i} className="text-sm text-green-700">
                • {f}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function DropZone({
  label,
  description,
  icon,
  dragOver,
  onDragOver,
  onDragLeave,
  onDrop,
  onFileSelect,
  uploading,
}: {
  label: string;
  description: string;
  icon: React.ReactNode;
  category: string;
  dragOver: boolean;
  onDragOver: (e: React.DragEvent) => void;
  onDragLeave: () => void;
  onDrop: (e: React.DragEvent) => void;
  onFileSelect: (files: FileList) => void;
  uploading: boolean;
}) {
  return (
    <div
      className={cn(
        "relative rounded-xl border-2 border-dashed p-8 text-center transition-colors",
        dragOver
          ? "border-brand-500 bg-brand-50"
          : "border-brand-300 bg-white hover:border-brand-400"
      )}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <div className="mx-auto flex flex-col items-center">
        {uploading ? (
          <Loader2 className="h-8 w-8 animate-spin text-brand-500" />
        ) : (
          icon
        )}
        <p className="mt-3 text-sm font-medium text-brand-800">{label}</p>
        <p className="mt-1 text-xs text-brand-500">{description}</p>
        <label className="btn-secondary mt-4 cursor-pointer">
          <Upload className="mr-2 h-4 w-4" />
          选择文件
          <input
            type="file"
            className="hidden"
            accept=".pdf,.jpg,.jpeg,.png,.webp"
            multiple
            onChange={(e) => e.target.files && onFileSelect(e.target.files)}
          />
        </label>
        <p className="mt-2 text-xs text-brand-400">或拖拽文件到此处</p>
      </div>
    </div>
  );
}
