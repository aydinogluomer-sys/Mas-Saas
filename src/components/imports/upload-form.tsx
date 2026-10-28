"use client";

import { useState, useRef } from "react";
import { useFormStatus } from "react-dom";
import { uploadWorkbookAction } from "@/app/(dashboard)/imports/actions";

function SubmitButton({ hasFile }: { hasFile: boolean }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending || !hasFile}
      className="button-primary px-5 py-2.5 text-xs font-semibold disabled:opacity-40"
    >
      {pending ? (
        <span className="flex items-center gap-2">
          <svg className="h-3.5 w-3.5 animate-spin" viewBox="0 0 24 24" fill="none">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
          </svg>
          İçe Aktarılıyor…
        </span>
      ) : (
        <span className="flex items-center gap-1.5">
          <svg className="h-4 w-4 stroke-current stroke-2 fill-none" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5m-13.5-9L12 3m0 0l4.5 4.5M12 3v13.5" />
          </svg>
          İçe Aktarımı Başlat
        </span>
      )}
    </button>
  );
}

export function UploadForm() {
  const [file, setFile] = useState<File | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    const droppedFile = e.dataTransfer.files?.[0];
    if (droppedFile && (droppedFile.name.endsWith(".xlsx") || droppedFile.name.endsWith(".xls"))) {
      setFile(droppedFile);
      if (fileInputRef.current) {
        const dataTransfer = new DataTransfer();
        dataTransfer.items.add(droppedFile);
        fileInputRef.current.files = dataTransfer.files;
      }
    }
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const selected = e.target.files?.[0] || null;
    setFile(selected);
  };

  const formatSize = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  return (
    <form action={uploadWorkbookAction} className="space-y-4">
      <input
        ref={fileInputRef}
        type="file"
        name="file"
        required
        accept=".xlsx,.xls"
        className="sr-only"
        onChange={handleFileChange}
      />

      <div
        onClick={() => fileInputRef.current?.click()}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        className={`group relative flex flex-col items-center justify-center rounded-xl border-2 border-dashed p-6 text-center cursor-pointer transition-all duration-200 ${
          isDragging
            ? "border-sky-400 bg-sky-500/10 shadow-lg shadow-sky-500/10"
            : file
            ? "border-emerald-500/40 bg-emerald-500/5 hover:border-emerald-500/60"
            : "border-line bg-surface-2/40 hover:border-line-strong hover:bg-surface-2/70"
        }`}
      >
        {file ? (
          <div className="flex flex-col items-center gap-2">
            <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-emerald-500/15 text-emerald-400 border border-emerald-500/30">
              <svg className="h-6 w-6 stroke-current stroke-1.5 fill-none" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m2.25 0H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" />
              </svg>
            </div>
            <div className="text-center">
              <p className="font-sans text-sm font-semibold text-tone-1">{file.name}</p>
              <p className="font-sans text-xs text-tone-3 mt-0.5">{formatSize(file.size)}</p>
            </div>
            <span className="font-sans text-[11px] text-sky-400 hover:underline mt-1">
              Farklı dosya seçmek için tıklayın
            </span>
          </div>
        ) : (
          <div className="flex flex-col items-center gap-2">
            <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-sky-500/10 text-sky-400 border border-sky-500/20 group-hover:scale-105 transition-transform">
              <svg className="h-6 w-6 stroke-current stroke-1.5 fill-none" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 16.5V9.75m0 0l3 3m-3-3l-3 3M6.75 19.5a4.5 4.5 0 01-1.41-8.775 5.25 5.25 0 0110.233-2.33 3 3 0 013.758 3.848A3.752 3.752 0 0118 19.5H6.75z" />
              </svg>
            </div>
            <div>
              <p className="font-sans text-sm font-medium text-tone-1">
                Excel dosyasını buraya sürükleyin veya <span className="text-sky-400 font-semibold underline decoration-sky-400/40">dosya seçin</span>
              </p>
              <p className="font-sans text-xs text-tone-4 mt-1">
                Desteklenen formatlar: .xlsx, .xls · Maksimum 50 MB
              </p>
            </div>
          </div>
        )}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
        <span className="font-sans text-xs text-tone-3 flex items-center gap-1.5">
          <svg className="h-3.5 w-3.5 text-emerald-400 shrink-0 fill-none stroke-current stroke-2" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75L11.25 15 15 9.75m-3-7.036A11.959 11.959 0 013.598 6 11.99 11.99 0 003 9.749c0 5.592 3.824 10.29 9 11.623 5.176-1.332 9-6.03 9-11.622 0-1.31-.21-2.571-.598-3.751h-.152c-3.196 0-6.1-1.248-8.25-3.285z" />
          </svg>
          Ham veri olduğu gibi korunur · Tüm sekmeler ve hücreler değişmez biçimde arşivlenir
        </span>
        <SubmitButton hasFile={!!file} />
      </div>
    </form>
  );
}
