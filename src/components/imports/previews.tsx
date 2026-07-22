// Presentational previews for the three extraction families.
// Pure: receive extractor output, render. Server- and test-renderable.
import { Badge, SEVERITY_TONE, type Tone } from "@/components/ui/badge";
import { Num, fmtTL } from "@/components/ui/panel";
import type {
  CheckCandidate,
  MonthlyCashflowPreview as CashflowData,
  PaymentCandidate,
  ReviewIssue,
} from "@/lib/importers/extractors";

const FLAG_TONE: Record<string, Tone> = {
  missing_due_day: "red",
  negative_amount: "red",
  unlabeled_amount: "red",
  amount_alignment: "amber",
  multiple_day_markers: "amber",
  duplicate_check: "amber",
  unparsed_row: "red",
};

function FlagBadges({ flags }: { flags: string[] }) {
  if (flags.length === 0) return <Badge tone="green">temiz</Badge>;
  return (
    <span className="flex flex-wrap gap-1">
      {flags.map((f) => (
        <Badge key={f} tone={FLAG_TONE[f] ?? "amber"}>{f}</Badge>
      ))}
    </span>
  );
}

export function IssueList({ issues }: { issues: ReviewIssue[] }) {
  if (issues.length === 0) return null;
  return (
    <ul className="mt-3 space-y-1 border-t border-line pt-2">
      {issues.map((i, k) => (
        <li key={k} className="flex items-start gap-2 text-xs text-tone-2">
          <Badge tone={SEVERITY_TONE[i.severity]}>{i.severity}</Badge>
          <span className="font-mono text-[10px] text-tone-3">
            {i.rowIndex != null ? `r${i.rowIndex}` : "—"}
          </span>
          <span>{i.message}</span>
        </li>
      ))}
    </ul>
  );
}

/* ── payment day matrix ── */
export function PaymentMatrixPreview({
  candidates,
  issues,
}: {
  candidates: PaymentCandidate[];
  issues: ReviewIssue[];
}) {
  return (
    <div>
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-line text-left font-mono text-[10px] uppercase tracking-wider text-tone-3">
            <th className="py-1 pr-2">r</th>
            <th className="py-1 pr-2">ödeme</th>
            <th className="py-1 pr-2">gün</th>
            <th className="py-1 pr-2">tutar adayı</th>
            <th className="py-1">durum</th>
          </tr>
        </thead>
        <tbody>
          {candidates.map((c) => (
            <tr key={c.rowIndex} className="border-b border-line-faint">
              <td className="py-1.5 pr-2 font-mono text-xs text-tone-3">{c.rowIndex}</td>
              <td className="py-1.5 pr-2">{c.name ?? <Badge tone="red">ETİKETSİZ</Badge>}</td>
              <td className="py-1.5 pr-2">
                <Num>{c.dueDay != null ? `${c.dueDay}. gün` : "—"}</Num>
              </td>
              <td className={`py-1.5 pr-2 ${c.amountCandidate != null && c.amountCandidate < 0 ? "text-neg" : ""}`}>
                <Num>{c.amountCandidate != null ? fmtTL(c.amountCandidate) : "—"}</Num>
              </td>
              <td className="py-1.5"><FlagBadges flags={c.flags} /></td>
            </tr>
          ))}
        </tbody>
      </table>
      <IssueList issues={issues} />
    </div>
  );
}

/* ── monthly cash-flow ── */
export function MonthlyCashflowPreviewView({ data }: { data: CashflowData }) {
  const head: Array<[string, number | null]> = [
    ["DEVİR", data.opening],
    ["GELİR", data.income],
    ["GİDER", data.expense],
    ["FARK", data.delta],
    ["KASA", data.closing],
  ];
  const groups: Array<[string, CashflowData["lines"]]> = [
    ["MÜŞTERİ GELİRLERİ", data.lines.filter((l) => l.line_type === "customer_income")],
    ["CARİ ÖDEMELER", data.lines.filter((l) => l.line_type === "vendor_payment")],
    ["BANKA/HESAP BAKİYELERİ", data.lines.filter((l) => l.line_type === "bank_balance")],
    ["YAN TAKİP (adjustment)", data.lines.filter((l) => l.line_type === "adjustment")],
  ];
  return (
    <div>
      <div className="mb-3 grid grid-cols-2 gap-2 sm:grid-cols-5">
        {head.map(([k, v]) => (
          <div key={k} className="border border-line bg-black/40 p-2">
            <div className="font-mono text-[9px] uppercase tracking-wider text-tone-3">{k}</div>
            <div className={`font-mono text-sm tabular-nums ${v != null && v < 0 ? "text-neg" : "text-tone-1"}`}>
              {v != null ? new Intl.NumberFormat("tr-TR").format(v) : "—"}
            </div>
          </div>
        ))}
      </div>
      <div className="mb-3">
        {data.identityHolds == null ? (
          <Badge tone="amber">kimlik doğrulanamadı</Badge>
        ) : data.identityHolds ? (
          <Badge tone="green">kasa = devir + gelir − gider ✓</Badge>
        ) : (
          <Badge tone="red">kimlik UYUŞMUYOR</Badge>
        )}
      </div>
      {groups.map(([title, lines]) =>
        lines.length ? (
          <div key={title} className="mb-3">
            <div className="mb-1 font-mono text-[10px] uppercase tracking-wider text-tone-3">{title}</div>
            <table className="w-full text-sm">
              <tbody>
                {lines.map((l) => (
                  <tr key={`${l.line_type}-${l.rowIndex}-${l.label}`} className="border-b border-line-faint">
                    <td className="py-1 pr-2 font-mono text-xs text-tone-3">r{l.rowIndex}</td>
                    <td className="py-1 pr-2">{l.label}</td>
                    <td className={`py-1 text-right font-mono tabular-nums ${l.amount != null && l.amount < 0 ? "text-neg" : ""}`}>
                      {l.amount != null ? new Intl.NumberFormat("tr-TR").format(l.amount) : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null,
      )}
      <IssueList issues={data.issues} />
    </div>
  );
}

/* ── checks ── */
export function ChecksPreview({
  candidates,
  issues,
}: {
  candidates: CheckCandidate[];
  issues: ReviewIssue[];
}) {
  return (
    <div>
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-line text-left font-mono text-[10px] uppercase tracking-wider text-tone-3">
            <th className="py-1 pr-2">vade</th>
            <th className="py-1 pr-2">kime</th>
            <th className="py-1 pr-2">banka</th>
            <th className="py-1 pr-2">tutar</th>
            <th className="py-1 pr-2">yön</th>
            <th className="py-1">durum</th>
          </tr>
        </thead>
        <tbody>
          {candidates.map((c) => (
            <tr key={c.rowIndex} className="border-b border-line-faint">
              <td className="py-1.5 pr-2 font-mono text-xs">{c.maturityDate ?? "—"}</td>
              <td className="py-1.5 pr-2">{c.payee ?? c.payer ?? "—"}</td>
              <td className="py-1.5 pr-2">{c.bank ?? "—"}</td>
              <td className={`py-1.5 pr-2 font-mono tabular-nums ${c.signedAmount != null && c.signedAmount < 0 ? "text-neg" : "text-pos"}`}>
                {c.signedAmount != null ? new Intl.NumberFormat("tr-TR").format(c.signedAmount) : "—"}
              </td>
              <td className="py-1.5 pr-2">
                <Badge tone={c.direction === "outflow" ? "red" : c.direction === "inflow" ? "green" : "neutral"}>
                  {c.direction}
                </Badge>
              </td>
              <td className="py-1.5"><FlagBadges flags={c.flags} /></td>
            </tr>
          ))}
        </tbody>
      </table>
      <IssueList issues={issues} />
    </div>
  );
}
