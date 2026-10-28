"use client";
import { useFormStatus } from "react-dom";
import { uploadWorkbookAction } from "@/app/(dashboard)/imports/actions";

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <button type="submit" disabled={pending}
      className="button-primary px-3 py-2 text-xs disabled:opacity-50">
      {pending ? "İÇE AKTARILIYOR…" : "İÇE AKTAR"}
    </button>
  );
}

export function UploadForm() {
  return (
    <form action={uploadWorkbookAction} className="flex flex-wrap items-center gap-2">
      <input type="file" name="file" required accept=".xlsx,.xls"
        className="border border-line bg-black/40 p-2 font-mono text-xs file:mr-3 file:border-0 file:bg-surface-3 file:px-2 file:py-1 file:font-mono file:text-xs file:text-tone-1" />
      <SubmitButton />
      <span className="font-mono text-[10px] text-tone-3">
        ham veri olduğu gibi korunur · bozuk dosya hata kaydıyla saklanır
      </span>
    </form>
  );
}
