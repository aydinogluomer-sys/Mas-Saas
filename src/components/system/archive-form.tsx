"use client";

// Shared archive control used by the data tables. Keeps the mutation on the server
// (archiveRecordAction) and the flash toast riding along in backTo (?flash=archived),
// so the instant-navigation and financial-safety contracts are preserved in one place.
import { archiveRecordAction } from "@/app/(dashboard)/system/archive/actions";
import { DropdownMenuItem } from "@/components/ui/primitives/dropdown-menu";

export function ArchiveForm({
  entity,
  id,
  backTo,
  reason,
  asMenuItem = false,
  label = "Arşivle",
}: {
  entity: string;
  id: string;
  backTo: string;
  reason: string;
  asMenuItem?: boolean;
  label?: string;
}) {
  return (
    <form action={archiveRecordAction}>
      <input type="hidden" name="entity" value={entity} />
      <input type="hidden" name="id" value={id} />
      <input type="hidden" name="backTo" value={backTo} />
      <input type="hidden" name="reason" value={reason} />
      {asMenuItem ? (
        <DropdownMenuItem asChild>
          <button type="submit" className="w-full text-left text-neg">{label}</button>
        </DropdownMenuItem>
      ) : (
        <button type="submit" className="button-ghost px-2 py-1">{label}</button>
      )}
    </form>
  );
}
