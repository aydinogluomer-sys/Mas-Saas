"use client";

// Settlement controls for a single check row (Bulgu #1). Same shape as ArchiveForm: the
// mutation stays on the server, the row id and return path ride along as hidden inputs.
//
// Must match CHECK_SETTLEABLE_FROM in src/lib/financing/engine.ts — the set of statuses
// markCheckCleared/markCheckBounced actually accept, which in turn mirrors 0034's trigger
// allow-list. Rendering these buttons outside that set (a check already cleared, bounced,
// cancelled or unknown) would offer an action whose click always fails with a domain error.
const CHECK_SETTLEABLE_FROM = new Set([
  "planned",
  "in_portfolio",
  "endorsed_to_vendor",
  "in_bank_collection",
  "in_bank_collateral",
  "issued_to_vendor",
]);

import {
  cancelCheckAction,
  classifyUnknownCheckAction,
  markCheckBouncedAction,
  markCheckClearedAction,
} from "@/app/(dashboard)/finance/actions";

export function CheckSettleForms({ id, status, backTo }: { id: string; status: string; backTo: string }) {
  if (status === "unknown") {
    return (
      <>
        <form action={classifyUnknownCheckAction}>
          <input type="hidden" name="id" value={id} />
          <input type="hidden" name="targetStatus" value="in_portfolio" />
          <input type="hidden" name="backTo" value={backTo} />
          <button type="submit" className="button-ghost px-2 py-1 text-pos">
            portföye al
          </button>
        </form>
        <form action={classifyUnknownCheckAction}>
          <input type="hidden" name="id" value={id} />
          <input type="hidden" name="targetStatus" value="issued_to_vendor" />
          <input type="hidden" name="backTo" value={backTo} />
          <button type="submit" className="button-ghost px-2 py-1 text-warn">
            keşide (verilen)
          </button>
        </form>
        <form action={cancelCheckAction}>
          <input type="hidden" name="id" value={id} />
          <input type="hidden" name="reason" value="Bilinmeyen çek iptal edildi" />
          <button type="submit" className="button-ghost px-2 py-1 text-neg">
            iptal
          </button>
        </form>
      </>
    );
  }
  if (!CHECK_SETTLEABLE_FROM.has(status)) return null;
  return (
    <>
      <form action={markCheckClearedAction}>
        <input type="hidden" name="id" value={id} />
        <input type="hidden" name="backTo" value={backTo} />
        <button type="submit" className="button-ghost px-2 py-1 text-pos">tahsil edildi</button>
      </form>
      <form action={markCheckBouncedAction}>
        <input type="hidden" name="id" value={id} />
        <input type="hidden" name="backTo" value={backTo} />
        <button type="submit" className="button-ghost px-2 py-1 text-neg">karşılıksız</button>
      </form>
    </>
  );
}
