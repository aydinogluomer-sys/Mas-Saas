import { getPool } from "@/lib/db";
import { loadExternalAssumptionCenter } from "@/lib/external-assumptions/engine";
import { sourceLabel } from "@/lib/external-assumptions/rules";
import { Badge, type Tone } from "@/components/ui/badge";
import { Panel } from "@/components/ui/panel";
import { EmptyState, KeyStat, PageHeader } from "@/components/ui/shell";
import { createExternalAssumptionAction, setExternalAssumptionReviewStatusAction } from "./actions";
import { archiveRecordAction } from "@/app/(dashboard)/system/archive/actions";
import { requireRouteAccess } from "@/lib/authz/route-guard";

export const dynamic = "force-dynamic";

const STATUS_TONE: Record<string, Tone> = {
  pending_review: "amber",
  approved: "green",
  rejected: "neutral",
};
const STATUS_LABEL: Record<string, string> = {
  pending_review: "incelemede",
  approved: "onaylı",
  rejected: "reddedildi",
};
const TYPE_LABEL: Record<string, string> = {
  interest_rate: "faiz",
  fx_rate: "kur",
  inflation_rate: "enflasyon",
  personnel_cost: "personel",
  energy_cost: "enerji",
  loan_rate: "kredi",
  other: "diğer",
};
const SOURCE_KIND_LABEL: Record<string, string> = {
  manual: "manuel",
  imported: "içe aktarılan",
  internet: "internet",
};
const ASSUMPTION_ERROR_TEXT: Record<string, string> = {
  "internet-source-url-required": "İnternet kaynaklı varsayımlarda kaynak URL zorunludur.",
  "assumption-fields-required":
    "Zorunlu varsayım alanları (başlık, değer, birim, kaynak adı ve kaynak tarihi) eksiksiz doldurulmalıdır.",
  "assumption-review-invalid": "İnceleme durumu güncellenemedi: geçersiz kayıt kimliği veya inceleme durumu.",
};
const ASSUMPTION_RESULT_TEXT: Record<string, string> = {
  created: "Dış varsayım kaydedildi.",
  reviewed: "İnceleme durumu güncellendi.",
};

export default async function AssumptionsPage({
  searchParams,
}: {
  searchParams?: Promise<{ error?: string; result?: string }>;
}) {
  const denied = await requireRouteAccess("/data/assumptions");
  if (denied) return denied;
  const sp = (await searchParams) ?? {};
  const errorText =
    sp.error && Object.prototype.hasOwnProperty.call(ASSUMPTION_ERROR_TEXT, sp.error)
      ? ASSUMPTION_ERROR_TEXT[sp.error]
      : null;
  const resultText =
    sp.result && Object.prototype.hasOwnProperty.call(ASSUMPTION_RESULT_TEXT, sp.result)
      ? ASSUMPTION_RESULT_TEXT[sp.result]
      : null;
  const data = await loadExternalAssumptionCenter(getPool());
  const approvedCount = data.counts.filter((r) => r.review_status === "approved").reduce((sum, r) => sum + r.n, 0);

  return (
    <>
      <PageHeader
        title="Dış Varsayımlar"
        subtitle="Faiz / kur / enflasyon / personel / enerji / kredi oranları"
        meta={<Badge tone={data.internetPendingCount > 0 ? "amber" : "green"} dot>{data.internetPendingCount} internet incelemesi</Badge>}
      />

      {errorText && (
        <p
          role="alert"
          className="border p-2.5 text-xs"
          style={{
            background: "var(--surface-2)",
            borderColor: "var(--neg)",
            borderRadius: "var(--radius)",
            color: "var(--neg)",
          }}
        >
          {errorText}
        </p>
      )}
      {resultText && (
        <p
          role="status"
          className="border p-2.5 text-xs"
          style={{
            background: "var(--surface-2)",
            borderColor: "var(--pos)",
            borderRadius: "var(--radius)",
            color: "var(--pos)",
          }}
        >
          {resultText}
        </p>
      )}

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <KeyStat label="Bekleyen inceleme" value={data.pendingCount} tone={data.pendingCount > 0 ? "warn" : "pos"} />
        <KeyStat label="İnternet incelemesi" value={data.internetPendingCount} tone={data.internetPendingCount > 0 ? "warn" : "pos"} />
        <KeyStat label="Onaylı varsayım" value={approvedCount} tone={approvedCount > 0 ? "info" : "neutral"} />
        <KeyStat label="Son onaylı tip" value={data.latestApproved.length} tone={data.latestApproved.length > 0 ? "info" : "neutral"} />
      </div>

      <Panel title="YENİ VARSAYIM">
        <form action={createExternalAssumptionAction} className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <Field label="Başlık" name="label" type="text" placeholder="ör. TCMB politika faizi" full />
          <Select label="Tip" name="assumptionType" options={[
            ["interest_rate", "faiz"],
            ["fx_rate", "kur"],
            ["inflation_rate", "enflasyon"],
            ["personnel_cost", "personel"],
            ["energy_cost", "enerji"],
            ["loan_rate", "kredi"],
            ["other", "diğer"],
          ]} />
          <Field label="Değer" name="valueNumeric" />
          <Field label="Birim" name="unit" type="text" placeholder="yüzde / TRY / TRY/kWh" />
          <Field label="Para birimi" name="currency" type="text" placeholder="TRY" />
          <Select label="Kaynak türü" name="sourceKind" options={[
            ["manual", "manuel"],
            ["imported", "içe aktarılan"],
            ["internet", "internet"],
          ]} />
          <Field label="Kaynak adı" name="sourceName" type="text" placeholder="TCMB / manuel tahmin / fatura" />
          <Field label="Kaynak tarihi" name="sourceDate" type="date" />
          <Field label="Kaynak URL" name="sourceUrl" type="url" placeholder="https://..." full />
          <Field label="Dönem başlangıç" name="periodStart" type="date" />
          <Field label="Dönem bitiş" name="periodEnd" type="date" />
          <label className="block sm:col-span-3">
            <span className="font-mono text-[10px] uppercase tracking-wider text-tone-3">Not</span>
            <textarea
              name="notes"
              rows={3}
              className="mt-1 w-full border px-2 py-1.5 text-sm outline-none"
              style={{ background: "var(--surface-2)", borderColor: "var(--line)", borderRadius: "var(--radius)", color: "var(--text-1)" }}
            />
          </label>
          <div className="sm:col-span-3">
            <button type="submit" className="border px-3 py-2 font-mono text-[10px] uppercase tracking-wider" style={{ borderColor: "var(--accent)", color: "var(--accent)", borderRadius: "var(--radius)" }}>
              kaydet
            </button>
            <span className="ml-2 text-[11px]" style={{ color: "var(--text-4)" }}>internet kaynaklı kayıtlar onay bekler</span>
          </div>
        </form>
      </Panel>

      <Panel title={`SON ONAYLI VARSAYIMLAR — ${data.latestApproved.length}`}>
        {data.latestApproved.length === 0 ? (
          <EmptyState>
            Onaylı varsayım yok. Yukarıdan faiz, kur veya maliyet varsayımı ekleyin; onaylananlar
            senaryo motoruna karar girdisi olarak akar.
          </EmptyState>
        ) : (
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {data.latestApproved.map((a) => (
              <div key={a.id} className="border p-2.5" style={{ borderColor: "var(--line)", borderRadius: "var(--radius)", background: "var(--surface-2)" }}>
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="font-mono text-[10px] uppercase tracking-wider" style={{ color: "var(--text-3)" }}>{TYPE_LABEL[a.assumption_type] ?? a.assumption_type}</div>
                    <div className="mt-0.5 text-sm" style={{ color: "var(--text-1)" }}>{a.label}</div>
                  </div>
                  <Badge tone="green">onaylı</Badge>
                </div>
                <div className="mt-1 font-mono text-sm tabular-nums" style={{ color: "var(--accent)" }}>{a.value_numeric} {a.unit}</div>
                <div className="mt-1 font-mono text-[10px]" style={{ color: "var(--text-4)" }}>{sourceLabel(a.source_name, a.source_date)}</div>
              </div>
            ))}
          </div>
        )}
      </Panel>

      <Panel title={`TÜM KAYITLAR — ${data.assumptions.length}`}>
        {data.assumptions.length === 0 ? (
          <EmptyState>
            Dış varsayım kaydı yok. İlk kaydınız incelemeye düşer; onay/ret denetim iziyle saklanır.
          </EmptyState>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-line text-left font-mono text-[10px] uppercase tracking-wider text-tone-3">
                  <th className="py-1 pr-2">tip</th>
                  <th className="py-1 pr-2">başlık</th>
                  <th className="py-1 pr-2 text-right">değer</th>
                  <th className="py-1 pr-2">kaynak</th>
                  <th className="py-1 pr-2">inceleme</th>
                  <th className="py-1">işlem</th>
                </tr>
              </thead>
              <tbody>
                {data.assumptions.map((a) => (
                  <tr key={a.id} className="border-b border-line-faint align-top">
                    <td className="py-1.5 pr-2 font-mono text-xs">{TYPE_LABEL[a.assumption_type] ?? a.assumption_type}</td>
                    <td className="py-1.5 pr-2">
                      <div>{a.label}</div>
                      {a.notes && <div className="mt-0.5 text-[11px]" style={{ color: "var(--text-4)" }}>{a.notes}</div>}
                    </td>
                    <td className="py-1.5 pr-2 text-right font-mono tabular-nums">{a.value_numeric} {a.unit}</td>
                    <td className="py-1.5 pr-2 text-xs">
                      <div>{a.source_name} / {a.source_date}</div>
                      <div className="font-mono text-[10px]" style={{ color: "var(--text-4)" }}>{SOURCE_KIND_LABEL[a.source_kind] ?? a.source_kind}{a.source_url ? " / URL" : ""}</div>
                    </td>
                    <td className="py-1.5 pr-2"><Badge tone={STATUS_TONE[a.review_status] ?? "neutral"}>{STATUS_LABEL[a.review_status] ?? a.review_status}</Badge></td>
                    <td className="py-1.5">
                      <div className="flex gap-1">
                        {(["approved", "rejected"] as const).map((s) => (
                          <form key={s} action={setExternalAssumptionReviewStatusAction}>
                            <input type="hidden" name="id" value={a.id} />
                            <input type="hidden" name="reviewStatus" value={s} />
                            <button type="submit" className="border px-1.5 py-0.5 font-mono text-[9px] uppercase" style={{ borderColor: "var(--line-faint)", color: "var(--text-3)" }}>
                              {s === "approved" ? "onay" : "ret"}
                            </button>
                          </form>
                        ))}
                        <form action={archiveRecordAction}><input type="hidden" name="entity" value="external_assumptions"/><input type="hidden" name="id" value={a.id}/><input type="hidden" name="backTo" value="/data/assumptions"/><input type="hidden" name="reason" value="Varsayım listesinden arşivlendi"/><button className="border px-1.5 py-0.5 font-mono text-[9px] uppercase" style={{borderColor:"var(--line-faint)",color:"var(--text-3)"}}>arşiv</button></form>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </>
  );
}

function Field({ label, name, type = "number", placeholder, full }: {
  label: string;
  name: string;
  type?: string;
  placeholder?: string;
  full?: boolean;
}) {
  const isRequired =
    name === "label" ||
    name === "valueNumeric" ||
    name === "unit" ||
    name === "sourceName" ||
    name === "sourceDate";
  return (
    <label className={`block ${full ? "sm:col-span-3" : ""}`}>
      <span className="font-mono text-[10px] uppercase tracking-wider text-tone-3">{label}</span>
      <input
        required={isRequired}
        aria-required={isRequired || undefined}
        name={name}
        type={type}
        step={type === "number" ? "any" : undefined}
        placeholder={placeholder}
        className="mt-1 w-full border px-2 py-1.5 text-sm outline-none"
        style={{ background: "var(--surface-2)", borderColor: "var(--line)", borderRadius: "var(--radius)", color: "var(--text-1)" }}
      />
    </label>
  );
}

function Select({ label, name, options }: { label: string; name: string; options: Array<[string, string]> }) {
  return (
    <label className="block">
      <span className="font-mono text-[10px] uppercase tracking-wider text-tone-3">{label}</span>
      <select
        name={name}
        className="mt-1 w-full border px-2 py-1.5 text-sm outline-none"
        style={{ background: "var(--surface-2)", borderColor: "var(--line)", borderRadius: "var(--radius)", color: "var(--text-1)" }}
      >
        {options.map(([value, optLabel]) => <option key={value} value={value}>{optLabel}</option>)}
      </select>
    </label>
  );
}
