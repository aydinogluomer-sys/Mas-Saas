import { notFound } from "next/navigation";
import Link from "@/components/ui/app-link";
import { Badge } from "@/components/ui/badge";
import { Panel } from "@/components/ui/panel";
import { requireRouteAccess } from "@/lib/authz/route-guard";
import { getPool } from "@/lib/db";
import { documentsForEntity } from "@/lib/documents/engine";
import { moneyOrNull } from "@/lib/money";
import { resolveEffectiveRecurrence } from "@/lib/radar/engine";
import { PaymentForm, type PaymentFormValues } from "@/components/radar/payment-form";
import { updatePaymentAction } from "../../actions";

export const dynamic = "force-dynamic";

const DOC_TYPE_TR: Record<string, string> = {
  contract: "sözleşme",
  invoice_scan: "fatura taraması",
  bank_statement: "banka ekstresi",
  receipt: "dekont / makbuz",
  tax_document: "vergi belgesi",
  insurance: "sigorta",
  correspondence: "yazışma",
  report: "rapor",
  other: "diğer",
};

export default async function EditPaymentPage({
  params, searchParams,
}: {
  params: Promise<{ paymentId: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const denied = await requireRouteAccess("/payments/[paymentId]/edit");
  if (denied) return denied;
  const { paymentId } = await params;
  const sp = await searchParams;
  const pool = getPool();
  const [r, attachedDocs] = await Promise.all([
    pool.query(
      `select p.id, p.name, p.recurrence_type, p.source_notes, p.due_day,
              to_char(p.due_date,'YYYY-MM-DD') as due_date,
              p.default_amount, coalesce(p.currency, 'TRY') as currency,
              p.amount_confidence, p.direction, p.priority, p.flexibility_class, p.status,
              p.category_id, p.provider_party_id, p.owner_party_id, p.cash_account_id,
              p.cost_center_id, p.project_id, p.department_id, p.description,
              to_jsonb(p)->>'iban' as iban,
              coalesce(to_jsonb(p)->>'tdhp_expense_code', '770') as tdhp_expense_code,
              to_jsonb(p)->>'auto_match_vkn' as auto_match_vkn
       from public.payments p where p.id=$1`,
      [paymentId],
    ),
    documentsForEntity(pool, "payments", paymentId),
  ]);
  if (r.rowCount === 0) notFound();
  const row = r.rows[0];
  const v = {
    ...row,
    recurrence_type: resolveEffectiveRecurrence(row.recurrence_type, row.source_notes),
    default_amount: moneyOrNull(row.default_amount),
  } as PaymentFormValues;
  return (
    <div className="space-y-4">
      <PaymentForm action={updatePaymentAction} values={v} error={sp.error} title={`DÜZENLE — ${v.name}`} />

      <Panel
        title={`BAĞLI KANIT BELGELERİ — ${attachedDocs.length}`}
        subtitle="Bu ödeme şablonuna bağlı sözleşme, dekont ve destekleyici kanıt dokümanları"
        right={
          <Link
            href="/data/documents"
            className="rounded border px-2.5 py-1 text-xs font-medium hover:underline"
            style={{
              background: "var(--surface-2)",
              borderColor: "var(--line)",
              color: "var(--text-1)",
            }}
          >
            Belge Merkezini Aç →
          </Link>
        }
      >
        {attachedDocs.length === 0 ? (
          <p className="py-1 text-xs" style={{ color: "var(--text-2)" }}>
            Bu ödemeye henüz bağlı kanıt belgesi bulunmuyor. Belge Merkezinden (`payments` / `{paymentId}`) yeni kanıt bağlayabilirsiniz.
          </p>
        ) : (
          <div className="divide-y text-xs" style={{ borderColor: "var(--line)" }}>
            {attachedDocs.map((doc) => (
              <div
                key={doc.id}
                className="flex flex-wrap items-center justify-between gap-2 py-2"
                style={{ color: "var(--text-1)" }}
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{doc.title}</span>
                  <Badge tone="blue">{DOC_TYPE_TR[doc.docType] ?? doc.docType}</Badge>
                  <Badge tone={doc.status === "active" ? "green" : "neutral"}>
                    {doc.currentVersion ? `v${doc.currentVersion}` : "taslak"} · {doc.status}
                  </Badge>
                  {doc.originalFilename ? (
                    <span className="font-mono text-[11px]" style={{ color: "var(--text-2)" }}>
                      {doc.originalFilename}
                    </span>
                  ) : null}
                </div>
                <div className="flex items-center gap-2">
                  {doc.uploadedAt ? (
                    <span className="font-mono text-[11px]" style={{ color: "var(--text-2)" }}>
                      {doc.uploadedAt}
                    </span>
                  ) : null}
                  {doc.currentVersion ? (
                    <a
                      href={`/api/documents/${doc.id}/download`}
                      download
                      data-no-nav-skeleton="true"
                      className="rounded border px-2 py-0.5 font-mono text-[11px] hover:underline"
                      style={{
                        background: "var(--surface-2)",
                        borderColor: "var(--line)",
                        color: "var(--text-1)",
                      }}
                    >
                      İndir
                    </a>
                  ) : null}
                </div>
              </div>
            ))}
          </div>
        )}
      </Panel>
    </div>
  );
}
