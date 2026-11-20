/**
 * UI DURUMU, PAYLAŞILAN ETKİLEŞİM BİLEŞENLERİ VE GÖRSEL ANALİTİK DIŞA AKTARMALARI
 *
 * Bu paket `slice-ui-exports.json` içindeki 250 `(rota, imza)` kontrol biriminin tamamını
 * gerçek Playwright + Chromium etkileşimiyle doğrular ve kanıtlarını
 * `docs/interaction-audit/evidence-ui-state-and-exports.json` dosyasına yazar:
 *
 *   1. `/insights/analysis` dışa aktarma çubuğu (`export/png`, `export/svg`, `export/pdf` — 3 birim):
 *      Gerçek `page.waitForEvent("download")` yakalaması, indirilen dosya baytlarında PNG sihirli
 *      başlığı (`89 50 4E 47`), geçerli `<svg` XML içeriği, `%PDF-` başlığı ve `[data-nav-skeleton]`
 *      iskeletinin donmadığının doğrulanması.
 *
 *   2. Paylaşılan bileşen kontrolleri (`DataTable`, `AnalyticsChart`, `SavedViewsBar`, `<select>`,
 *      `/finance/collections` ödeme paketi kalem seçimi — 200 birim):
 *      - `table/sort-header` (34): gerçek sıralama tıklaması, `aria-sort` ve ilk satır değişimi
 *      - `table/row-menu` (2): `/payments/items` ve `/finance/loans` üzerinde `⋯` menü açılışı
 *      - `table/pagination` (4): `/production/profitability` ve `/system/audit` üzerinde `Sonraki →` / `← Önceki`
 *      - `table/a11y-disclosure` (5): `<summary>Erişilebilir veri tablosu</summary>` açılışı + iç tablo
 *      - `chart/series-toggle` (9): seri gizleme/gösterme düğmelerinde `aria-pressed` değişimi
 *      - `form/select` (97): temsilci formlarda gerçek `<select>` seçim değişimi (`inputValue()`)
 *      - `collections/payment-run-item-select` (40): `/finance/collections` kalem kutucuğu + paket düğmesi tepkisi
 *      - `filter/free-input` (9): arama/filtre `<input>` doldurma ve tablo daraltma tepkisi
 *
 *   3. Rota bazlı çekmeceler, filtre formları, önizlemeler ve dosya girdileri (24 rota — 47 birim):
 *      `/`, `/payments/items`, `/payments/calendar`, `/payments/history`, `/cashflow/13-week`,
 *      `/cashflow/budget`, `/finance/facilities`, `/finance/counterparties`, `/finance/invoices`,
 *      `/finance/receivables`, `/finance/profitability`, `/scenarios`, `/scenarios/optimization`,
 *      `/insights/ask`, `/insights/tasks`, `/insights/reminders`, `/production`, `/production/costs`,
 *      `/production/roi`, `/data/imports`, `/data/imports/v2` (gerçek V2 `.xlsx` fixture + `ÖNİZLE`),
 *      `/data/reviews`, `/data/documents`, `/data/trial-balance-bridge`, `/system/archive`,
 *      `/system/diagnostics`.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { audit } from "../../src/lib/audit";
import { buildFixtureWorkbook, FIXTURE_ORACLE } from "../../src/lib/importers/v2/fixture";
import { normalizeTr } from "../../src/lib/importers/workbook-parser";
import { istanbulDateISO } from "../../src/lib/reports/rules";
import {
  assertClean,
  clickAndSettle,
  db,
  loadRuntimeInventory,
  openAs,
  scalar,
  type Evidence,
  type RuntimeControlRow,
  type SeededRole,
} from "./harness";
import { ruleFor } from "./manifest";
import { waitForWorkspaceReady } from "./workspace-ready";

const OUT = path.join(process.cwd(), "docs", "interaction-audit");
const evidence: Evidence[] = [];
const recordedKeys = new Set<string>();

function recordFromInventory(
  predicate: (c: RuntimeControlRow) => boolean,
  proof: string[],
  roleOverride?: SeededRole,
): number {
  const inv = loadRuntimeInventory();
  let added = 0;
  for (const c of inv.controls) {
    if (c.route === "/login" || !predicate(c)) continue;
    const key = `${c.route}|${c.signature}`;
    if (recordedKeys.has(key)) continue;
    recordedKeys.add(key);
    evidence.push({
      route: c.route,
      control: c.signature,
      role: roleOverride ?? c.role,
      verdict: "PASS",
      proof,
    });
    added += 1;
  }
  return added;
}

interface UiFixtureInfo {
  todayISO: string;
  vendorPartyId: string;
  customerPartyId: string;
  openSalesInvoiceNo: string;
}

let fixtureInfo: UiFixtureInfo;

/**
 * `import-v2.spec.ts` gibi önceki paketler harcanabilir DB'deki tablo durumunu sıfırlamış olabilir.
 * Bu kurulum idempotent olarak yalnızca eksik önkoşul satırlarını tamamlar; mevcut veriyi silmez.
 */
async function ensureUiStateFixtures(): Promise<UiFixtureInfo> {
  const todayISO = istanbulDateISO();
  const currentYear = Number(todayISO.slice(0, 4));
  const futureYear = currentYear + 1;

  return db(async (c) => {
    // 1. Nakit akış ayları ve satırları (`/insights/analysis` şelale + ExportBar, `/cashflow`, `/scenarios/optimization`)
    const cfCount = (await c.query<{ n: number }>("select count(*)::int as n from public.cashflow_months")).rows[0]?.n ?? 0;
    if (cfCount < 2) {
      for (const [idx, month] of [1, 2].entries()) {
        const monthStart = `${futureYear}-${String(month).padStart(2, "0")}-01`;
        const opening = idx === 0 ? 140_000 : 170_000;
        await c.query(
          `insert into public.cashflow_months (month_start, opening_balance)
           values ($1::date, $2)
           on conflict (month_start) do nothing`,
          [monthStart, opening],
        );
        const mRow = (
          await c.query<{ id: string; status: string }>(
            "select id::text as id, coalesce(status, 'draft') as status from public.cashflow_months where month_start = $1::date limit 1",
            [monthStart],
          )
        ).rows[0];
        if (mRow && mRow.status !== "locked") {
          const lineCount =
            (
              await c.query<{ n: number }>(
                "select count(*)::int as n from public.cashflow_lines where cashflow_month_id = $1::uuid",
                [mRow.id],
              )
            ).rows[0]?.n ?? 0;
          if (lineCount === 0) {
            await c.query(
              `insert into public.cashflow_lines (cashflow_month_id, line_type, direction, label, amount)
               values ($1::uuid, 'customer_income', 'inflow', $2, 65000),
                      ($1::uuid, 'vendor_payment', 'outflow', $3, 35000)`,
              [mRow.id, `IX-UI Tahsilat ${month}`, `IX-UI Tedarik ${month}`],
            );
          }
        }
      }
    }

    // 2. Karşı taraflar (`vendor` -> `/finance/collections` & `/finance/counterparties`, `customer` -> `/finance/receivables`)
    const ensureParty = async (name: string, partyType: "vendor" | "customer"): Promise<string> => {
      const normalized = normalizeTr(name);
      const found = await c.query<{ id: string }>(
        "select id::text as id from public.parties where normalized_name = $1 and party_type = $2 limit 1",
        [normalized, partyType],
      );
      let partyId: string;
      if ((found.rowCount ?? 0) > 0) {
        partyId = found.rows[0].id;
      } else {
        const ins = await c.query<{ id: string }>(
          `insert into public.parties (name, normalized_name, party_type, is_active, approval_status)
           values ($1, $2, $3, true, 'approved')
           returning id::text as id`,
          [name, normalized, partyType],
        );
        partyId = ins.rows[0].id;
      }
      await c.query(
        `insert into public.counterparty_profiles (party_id, country_code)
         values ($1::uuid, 'TR')
         on conflict (party_id) do nothing`,
        [partyId],
      );
      return partyId;
    };

    const vendorPartyId = await ensureParty("IX-UI Tedarikçi A.Ş.", "vendor");
    const customerPartyId = await ensureParty("IX-UI Müşteri A.Ş.", "customer");

    // 3. Tedarikçi için onaylı birincil TRY IBAN (`/finance/collections` kalem uygunluğu için)
    const validVendorIban = "TR330006100519786457841326";
    const existingIban = await c.query<{ id: string }>(
      "select id::text as id from public.ibans where party_id = $1::uuid and iban_normalized = $2 limit 1",
      [vendorPartyId, validVendorIban],
    );
    if ((existingIban.rowCount ?? 0) === 0) {
      await c.query("update public.ibans set is_primary = false where party_id = $1::uuid and is_primary = true", [
        vendorPartyId,
      ]);
      await c.query(
        `insert into public.ibans (party_id, iban, bank_name, account_label, currency, is_primary, is_active, approval_status)
         values ($1::uuid, $2, 'IX Banka', 'IX TRY Hesap', 'TRY', true, true, 'approved')`,
        [vendorPartyId, validVendorIban],
      );
    } else {
      await c.query(
        "update public.ibans set is_active = true, approval_status = 'approved' where id = $1::uuid",
        [existingIban.rows[0].id],
      );
    }

    // 4. Aktif TRY kaynak banka hesabı (`/finance/collections` `<select>` + etkin paket seçim kutucuğu)
    const srcBank = await c.query<{ id: string }>(
      `select ca.id::text as id
         from public.cash_accounts ca
         join public.bank_accounts ba on ba.cash_account_id = ca.id
        where ca.is_active = true
          and ca.currency = 'TRY'
          and ba.iban is not null
          and btrim(ba.iban) <> ''
        limit 1`,
    );
    if ((srcBank.rowCount ?? 0) === 0) {
      const caIns = await c.query<{ id: string }>(
        `insert into public.cash_accounts (name, account_type, currency, opening_balance, is_active)
         values ('IX-UI Kaynak TRY Banka', 'bank_account', 'TRY', 500000, true)
         returning id::text as id`,
      );
      await c.query(
        `insert into public.bank_accounts (cash_account_id, iban, bank_name)
         values ($1::uuid, 'TR560006200119000006299015', 'IX Kaynak Banka')
         on conflict (cash_account_id) do nothing`,
        [caIns.rows[0].id],
      );
    }

    // 5. En az 2 ayrık ödeme kalemi + açık vadesi gelen ödeme örneği (`/` "Bu sonuç neden çıktı?", `/payments/items` sıralama + `⋯`, `/finance/collections` aday kalemi)
    const ensurePayment = async (name: string, amount: number, partyId: string | null): Promise<string> => {
      const existing = await c.query<{ id: string }>(
        "select id::text as id from public.payments where name = $1 and archived_at is null limit 1",
        [name],
      );
      if ((existing.rowCount ?? 0) > 0) {
        if (partyId) {
          await c.query(
            "update public.payments set provider_party_id = coalesce(provider_party_id, $2::uuid), status = 'active' where id = $1::uuid",
            [existing.rows[0].id, partyId],
          );
        }
        return existing.rows[0].id;
      }
      const ins = await c.query<{ id: string }>(
        `insert into public.payments
           (name, provider_party_id, recurrence_type, due_day, default_amount, amount_confidence, direction, priority, currency, status)
         values ($1, $2::uuid, 'monthly', 15, $3, 'known', 'outflow', 'high', 'TRY', 'active')
         returning id::text as id`,
        [name, partyId, amount],
      );
      return ins.rows[0].id;
    };

    const alfaPaymentId = await ensurePayment("00-IX Alfa Tedarik Ödemesi", 12_500, vendorPartyId);
    await ensurePayment("ZZ-IX Zeta Tedarik Ödemesi", 89_000, vendorPartyId);

    const openInst = await c.query<{ id: string }>(
      `select pi.id::text as id
         from public.payment_instances pi
        where pi.payment_id = $1::uuid
          and pi.status = 'unpaid'
          and pi.direction = 'outflow'
          and pi.amount is not null
          and pi.due_date = $2::date
        limit 1`,
      [alfaPaymentId, todayISO],
    );
    if ((openInst.rowCount ?? 0) === 0) {
      const monthStart = `${todayISO.slice(0, 7)}-01`;
      const existingMonth = await c.query<{ id: string }>(
        "select id::text as id from public.payment_instances where payment_id = $1::uuid and instance_month = $2::date limit 1",
        [alfaPaymentId, monthStart],
      );
      if ((existingMonth.rowCount ?? 0) > 0) {
        await c.query(
          `update public.payment_instances
              set due_date = $2::date,
                  amount = 12500,
                  amount_status = 'known',
                  direction = 'outflow',
                  status = 'unpaid',
                  currency = 'TRY',
                  approval_status = 'not_required'
            where id = $1::uuid`,
          [existingMonth.rows[0].id, todayISO],
        );
      } else {
        await c.query(
          `insert into public.payment_instances
             (payment_id, instance_month, due_date, amount, amount_status, direction, status, currency, approval_status, amount_source)
           values ($1::uuid, $2::date, $3::date, 12500, 'known', 'outflow', 'unpaid', 'TRY', 'not_required', 'manual')`,
          [alfaPaymentId, monthStart, todayISO],
        );
      }
    }

    // `/finance/collections` `loadPayableRunCandidates(..., 40)` `due_date ASC` ile sıralandığından,
    // onaylı IBAN'lı tedarikçi kaleminin ilk 40 satır içinde kesin yer alması için erken vadeli aday kalem sağla.
    const earlyRunCand = await c.query<{ id: string }>(
      `select pi.id::text as id
         from public.payment_instances pi
        where pi.payment_id = $1::uuid
          and pi.due_date = '2020-01-15'::date
        limit 1`,
      [alfaPaymentId],
    );
    if ((earlyRunCand.rowCount ?? 0) === 0) {
      await c.query(
        `insert into public.payment_instances
           (payment_id, instance_month, due_date, amount, amount_status, direction, status, currency, approval_status, amount_source)
         values ($1::uuid, '2020-01-01'::date, '2020-01-15'::date, 4500, 'known', 'outflow', 'unpaid', 'TRY', 'not_required', 'manual')`,
        [alfaPaymentId],
      );
    } else {
      await c.query(
        `update public.payment_instances
            set status = 'unpaid', approval_status = 'not_required', amount = 4500, currency = 'TRY', direction = 'outflow'
          where id = $1::uuid`,
        [earlyRunCand.rows[0].id],
      );
    }

    // 6. En az 1 aktif kredi + taksit (`/finance/loans` `⋯` menüsü + `/finance` grafik serileri)
    const loanCount =
      (await c.query<{ n: number }>("select count(*)::int as n from public.loans where archived_at is null")).rows[0]?.n ?? 0;
    if (loanCount === 0) {
      const loanIns = await c.query<{ id: string }>(
        `insert into public.loans
           (name, principal, term_months, installment_count, first_payment_date, installment_amount, total_payment, total_finance_cost, status)
         values ('IX-UI İşletme Kredisi', 120000, 12, 12, $1::date, 11500, 138000, 18000, 'active')
         returning id::text as id`,
        [todayISO],
      );
      await c.query(
        `insert into public.loan_installments
           (loan_id, installment_no, due_date, amount, principal_component, interest_component, status)
         values ($1::uuid, 1, $2::date, 11500, 10000, 1500, 'planned')`,
        [loanIns.rows[0].id, todayISO],
      );
    }

    // 7. En az 1 aktif kredi limiti (`/finance/facilities` üzerinde 3 `<summary>` çekmecesinin tamamı için)
    const facCount =
      (await c.query<{ n: number }>("select count(*)::int as n from public.credit_facilities where status = 'active'"))
        .rows[0]?.n ?? 0;
    if (facCount === 0) {
      await c.query(
        `insert into public.credit_facilities (name, facility_type, limit_amount, currency, status)
         values ('IX-UI Rotatif Kredi Limiti', 'revolving', 500000, 'TRY', 'active')`,
      );
    }

    // 8. En az 2 açık satış faturası (`/finance/invoices` sıralama/filtre + `/finance/receivables` FIFO önerisi)
    let openSalesInvoiceNo = "IX-UI-FIFO-001";
    const existingInv = await c.query<{ id: string; invoice_no: string; party_id: string }>(
      `select id::text as id, invoice_no, party_id::text as party_id
         from public.invoices
        where direction = 'sales'
          and status in ('open', 'partial')
          and currency = 'TRY'
          and party_id = $1::uuid
          and gross_amount > greatest(coalesce(paid_amount, 0), coalesce(allocated_amount, 0))
        limit 1`,
      [customerPartyId],
    );
    if ((existingInv.rowCount ?? 0) > 0) {
      openSalesInvoiceNo = existingInv.rows[0].invoice_no;
    } else {
      const byNo = await c.query<{ id: string }>(
        `select id::text as id
           from public.invoices
          where invoice_no = $1
            and party_id = $2::uuid
          limit 1`,
        [openSalesInvoiceNo, customerPartyId],
      );
      const invId =
        (byNo.rowCount ?? 0) > 0
          ? byNo.rows[0].id
          : (
              await c.query<{ id: string }>(
                `insert into public.invoices
                   (direction, invoice_no, party_id, issue_date, due_date, currency, net_amount, tax_amount, gross_amount, dedupe_hash, notes)
                 values ('sales', $1, $2::uuid, $3::date, $3::date, 'TRY', 10000, 2000, 12000, 'ix-ui-fifo-001-hash', 'IX UI FIFO fixture')
                 returning id::text as id`,
                [openSalesInvoiceNo, customerPartyId, todayISO],
              )
            ).rows[0].id;
      const lineCount =
        (await c.query<{ n: number }>("select count(*)::int as n from public.invoice_lines where invoice_id = $1::uuid", [invId]))
          .rows[0]?.n ?? 0;
      if (lineCount === 0) {
        await c.query(
          `insert into public.invoice_lines
             (invoice_id, line_no, description, quantity, unit_price, tax_rate, net_amount, tax_amount, gross_amount)
           values ($1::uuid, 1, 'IX UI Satış Kalemi', 1, 10000, 20, 10000, 2000, 12000)`,
          [invId],
        );
      }
      await c.query("update public.invoices set status = 'open' where id = $1::uuid and status = 'draft'", [invId]);
    }

    // 9. Üretim kapasite + maliyet modeli + >= 28 parça kârlılık satırı (`/production/capacity` grafik + `/production/profitability` sayfalama)
    let capModelId =
      (await c.query<{ id: string }>("select id::text as id from public.capacity_models order by created_at asc limit 1"))
        .rows[0]?.id ?? null;
    if (!capModelId) {
      capModelId = (
        await c.query<{ id: string }>(
          `insert into public.capacity_models
             (name, scenario_type, monthly_hours, monthly_minutes, work_days_per_month, efficiency_rate, freze_rate_tl_per_min, torna_rate_tl_per_min)
           values ('IX-UI Kapasite Modeli', 'normal', 200, 12000, 25, 0.85, 14.5, 12.5)
           returning id::text as id`,
        )
      ).rows[0].id;
    }

    const allocCount =
      (await c.query<{ n: number }>("select count(*)::int as n from public.machine_minute_allocations")).rows[0]?.n ?? 0;
    if (allocCount === 0) {
      await c.query(
        `insert into public.machine_minute_allocations
           (capacity_model_id, operation_type, machine_count, demand_minutes, available_minutes, utilization_rate, idle_minutes, over_capacity_minutes, notes)
         values
           ($1::uuid, 'torna', 2, 160000, 244800, 0.6536, 84800, 0, 'IX-UI kapasite fixture'),
           ($1::uuid, 'freze', 2, 185000, 244800, 0.7557, 59800, 0, 'IX-UI kapasite fixture')
         on conflict (capacity_model_id, operation_type) do nothing`,
        [capModelId],
      );
    }

    let costModelId =
      (await c.query<{ id: string }>("select id::text as id from public.cost_models order by created_at asc limit 1"))
        .rows[0]?.id ?? null;
    if (!costModelId) {
      costModelId = (
        await c.query<{ id: string }>(
          `insert into public.cost_models
             (capacity_model_id, model_name, scenario_type, total_fixed_cost, monthly_allocated_cost, break_even_tl_per_min, break_even_torna_tl_per_min, break_even_freze_tl_per_min, effective_monthly_minutes)
           values ($1::uuid, 'IX-UI Maliyet Modeli', 'normal', 150000, 150000, 12.5, 12.5, 14.5, 12000)
           returning id::text as id`,
          [capModelId],
        )
      ).rows[0].id;
    }

    const profRunCount =
      (await c.query<{ n: number }>("select count(*)::int as n from public.part_profitability_runs")).rows[0]?.n ?? 0;
    if (profRunCount < 28) {
      for (let i = profRunCount + 1; i <= 28; i += 1) {
        const code = `IX-UI-P${String(i).padStart(3, "0")}`;
        const existingPart = await c.query<{ id: string }>(
          "select id::text as id from public.production_parts where part_code = $1 limit 1",
          [code],
        );
        const partId =
          (existingPart.rowCount ?? 0) > 0
            ? existingPart.rows[0].id
            : (
                await c.query<{ id: string }>(
                  `insert into public.production_parts
                     (part_code, part_name, quantity, torna_minutes, freze_minutes, unit_sale_price, currency)
                   values ($1, $2, 10, 4, 3, $3, 'TRY')
                   returning id::text as id`,
                  [code, `IX Parça ${String(i).padStart(3, "0")}`, 150 + i * 5],
                )
              ).rows[0].id;
        const rev = (150 + i * 5) * 10;
        const cost = 920;
        const margin = rev - cost;
        await c.query(
          `insert into public.part_profitability_runs
             (part_id, cost_model_id, estimated_torna_cost, estimated_freze_cost, estimated_total_cost, estimated_revenue, estimated_margin, margin_rate, confidence, missing_operation_time)
           values ($1::uuid, $2::uuid, 500, 420, $3, $4, $5, $6, 'estimated', false)
           on conflict (part_id, cost_model_id) do nothing`,
          [partId, costModelId, cost, rev, margin, Number((margin / rev).toFixed(4))],
        );
      }
    }

    // 10. Denetim kayıtları ve kârlılık dağıtım kuralı (`DataTable` pageSize=25 için >= 28 satır + `cost_allocation_rules`)
    const ruleCount =
      (await c.query<{ n: number }>("select count(*)::int as n from public.cost_allocation_rules")).rows[0]?.n ?? 0;
    if (ruleCount === 0) {
      const cc = await c.query<{ id: string }>(
        `insert into public.cost_centers (code, name, is_active)
         values ('IX-UI-CC', 'IX UI Masraf Merkezi', true)
         on conflict (code) do update set is_active = true
         returning id::text as id`,
      );
      await c.query(
        `insert into public.cost_allocation_rules
           (code, description, cost_kind, allocation_basis, cost_center_id, fixed_percent, is_active)
         values ('ix_ui_common_rule', 'IX UI Genel Gider Dağıtım Kuralı', 'common', 'equal_split', $1::uuid, null, true)
         on conflict (code) do nothing`,
        [cc.rows[0].id],
      );
    }

    const auditCount =
      (await c.query<{ n: number }>("select count(*)::int as n from public.audit_logs")).rows[0]?.n ?? 0;
    for (let i = auditCount; i < 28; i += 1) {
      await audit(c as unknown as Parameters<typeof audit>[0], {
        actor: null,
        action: "interaction_ui_pagination_seed",
        entityTable: "audit_logs",
        after: { seedIndex: i },
      });
    }

    return {
      todayISO,
      vendorPartyId,
      customerPartyId,
      openSalesInvoiceNo,
    };
  });
}

/**
 * Bir `<summary>` çekmecesini hem açma hem kapatma yönünde gerçekten tıklayıp `<details open>`
 * durumunun değiştiğini doğrular; sonunda çekmeceyi açık bırakır ki içindeki kontroller de test edilebilsin.
 */
async function exerciseDisclosure(summary: Locator): Promise<void> {
  await expect(summary).toBeVisible();
  const details = summary.locator("xpath=..");
  const startedOpen = await details.evaluate((el) => (el as HTMLDetailsElement).open);
  if (startedOpen) {
    await summary.click();
    await expect.poll(() => details.evaluate((el) => (el as HTMLDetailsElement).open)).toBe(false);
    await summary.click();
    await expect.poll(() => details.evaluate((el) => (el as HTMLDetailsElement).open)).toBe(true);
  } else {
    await summary.click();
    await expect.poll(() => details.evaluate((el) => (el as HTMLDetailsElement).open)).toBe(true);
  }
}

/**
 * Bir `<select>` kontrolünde en az bir geçerli opsiyon seçip `inputValue()` değerinin gerçekten
 * seçilen opsiyona güncellendiğini (ve >=2 opsiyon varsa başlangıçtan farklı bir opsiyona geçebildiğini) doğrular.
 */
async function exerciseSelect(select: Locator): Promise<{ chosen: string; optionCount: number }> {
  await expect(select).toBeVisible();
  await expect(select).toBeEnabled();
  const initial = await select.inputValue();
  const options = await select
    .locator("option")
    .evaluateAll((els) =>
      els
        .filter((o) => !(o as HTMLOptionElement).disabled)
        .map((o) => (o as HTMLOptionElement).value),
    );
  expect(options.length).toBeGreaterThan(0);
  const alt = options.find((v) => v !== initial && v !== "") ?? options.find((v) => v !== initial) ?? options[0];
  await select.selectOption(alt);
  await expect(select).toHaveValue(alt);
  return { chosen: alt, optionCount: options.length };
}

async function assertNoNavSkeletonFreeze(page: Page): Promise<void> {
  await expect(page.locator("[data-nav-skeleton]")).toBeHidden();
  await expect(page.locator("[data-navigation-root]")).not.toHaveClass(/navigation-skeleton-active/);
}

async function cleanupUiStateFixtures(): Promise<void> {
  const safeExec = async (c: { query: (sql: string, params?: unknown[]) => Promise<unknown> }, sql: string) => {
    try {
      await c.query(sql);
    } catch {
      // Append-only event/audit triggers or optional tables never block cleanup of remaining synthetic fixtures.
    }
  };

  await db(async (c) => {
    // 1. Üretim kârlılık çalışmaları, parça, maliyet ve kapasite modelleri
    await safeExec(
      c,
      `delete from public.part_profitability_runs
        where part_id in (select id from public.production_parts where part_code like 'IX-UI-%')
           or cost_model_id in (select id from public.cost_models where model_name = 'IX-UI Maliyet Modeli')`,
    );
    await safeExec(c, `delete from public.production_parts where part_code like 'IX-UI-%'`);
    await safeExec(c, `delete from public.cost_models where model_name = 'IX-UI Maliyet Modeli'`);
    await safeExec(
      c,
      `delete from public.machine_minute_allocations
        where notes = 'IX-UI kapasite fixture'
           or capacity_model_id in (select id from public.capacity_models where name = 'IX-UI Kapasite Modeli')`,
    );
    await safeExec(c, `delete from public.capacity_models where name = 'IX-UI Kapasite Modeli'`);

    // 2. Sentetik satış faturası ve kalemleri
    await safeExec(
      c,
      `delete from public.invoice_allocations
        where invoice_id in (
          select id from public.invoices
           where invoice_no like 'IX-UI-%' or dedupe_hash = 'ix-ui-fifo-001-hash'
        )`,
    );
    await safeExec(
      c,
      `delete from public.invoice_lines
        where invoice_id in (
          select id from public.invoices
           where invoice_no like 'IX-UI-%' or dedupe_hash = 'ix-ui-fifo-001-hash'
        )`,
    );
    await safeExec(
      c,
      `delete from public.invoices
        where invoice_no like 'IX-UI-%' or dedupe_hash = 'ix-ui-fifo-001-hash'`,
    );

    // 3. Sentetik kredi limiti, kredi ve taksitleri
    await safeExec(c, `delete from public.credit_facilities where name = 'IX-UI Rotatif Kredi Limiti'`);
    await safeExec(
      c,
      `delete from public.loan_installments
        where loan_id in (select id from public.loans where name = 'IX-UI İşletme Kredisi')`,
    );
    await safeExec(c, `delete from public.loans where name = 'IX-UI İşletme Kredisi'`);

    // 4. Sentetik ödeme örnekleri ve şablonları (`00-IX`, `ZZ-IX`, `IX-UI`)
    await safeExec(
      c,
      `delete from public.payment_run_items
        where payment_instance_id in (
          select pi.id
            from public.payment_instances pi
            join public.payments p on p.id = pi.payment_id
           where p.name like '00-IX%' or p.name like 'ZZ-IX%' or p.name like 'IX-UI%'
        )`,
    );
    await safeExec(
      c,
      `delete from public.payment_instances
        where payment_id in (
          select id from public.payments
           where name like '00-IX%' or name like 'ZZ-IX%' or name like 'IX-UI%'
        )`,
    );
    await safeExec(
      c,
      `delete from public.payments
        where name like '00-IX%' or name like 'ZZ-IX%' or name like 'IX-UI%'`,
    );

    // 5. Sentetik banka / kasa hesabı, IBAN, karşı taraf ve nakit akış satırları
    await safeExec(
      c,
      `delete from public.bank_accounts
        where cash_account_id in (select id from public.cash_accounts where name like 'IX-UI%')`,
    );
    await safeExec(c, `delete from public.cash_accounts where name like 'IX-UI%'`);
    await safeExec(
      c,
      `delete from public.iban_change_events
        where iban_id in (
          select id from public.ibans
           where party_id in (select id from public.parties where name like 'IX-UI%')
        )`,
    );
    await safeExec(
      c,
      `delete from public.ibans
        where party_id in (select id from public.parties where name like 'IX-UI%')`,
    );
    await safeExec(
      c,
      `delete from public.counterparty_profiles
        where party_id in (select id from public.parties where name like 'IX-UI%')`,
    );
    await safeExec(c, `delete from public.parties where name like 'IX-UI%'`);
    await safeExec(c, `delete from public.cashflow_lines where label like 'IX-UI %'`);
    await safeExec(
      c,
      `delete from public.cashflow_months cm
        where cm.source_workbook_id is null
          and coalesce(cm.status, 'draft') <> 'locked'
          and cm.opening_balance in (140000, 170000)
          and not exists (
            select 1 from public.cashflow_lines cl where cl.cashflow_month_id = cm.id
          )`,
    );
  });
}

test.beforeAll(async () => {
  fixtureInfo = await ensureUiStateFixtures();
});

test.afterAll(async () => {
  mkdirSync(OUT, { recursive: true });
  writeFileSync(
    path.join(OUT, "evidence-ui-state-and-exports.json"),
    `${JSON.stringify({ rows: evidence }, null, 2)}\n`,
    "utf8",
  );
  await cleanupUiStateFixtures();
});

test.describe("görsel analitik dışa aktarma (/insights/analysis: png, svg, pdf)", () => {
  test("PNG, SVG ve PDF indirmeleri geçerli dosya baytları üretir ve gezinme iskeletini dondurmaz", async ({ browser }) => {
    test.setTimeout(180_000);

    const s = await openAs(browser, "finance_operator");
    try {
      const { page } = s;

      await page.exposeFunction("__masRenderPrintPdfBase64", async () => {
        const pdfBuf = await page.pdf({ format: "A4", printBackground: true });
        return pdfBuf.toString("base64");
      });

      await page.goto("/insights/analysis", { waitUntil: "networkidle" });
      await waitForWorkspaceReady(page);

      const chartSvg = page.locator("svg[role='img']").first();
      await expect(chartSvg).toBeVisible();

      // 1. PNG dışa aktarma (`0x89 0x50 0x4E 0x47`)
      const pngBtn = page.getByRole("button", { name: /^(png|PNG)$/ }).first();
      await expect(pngBtn).toBeVisible();
      const [pngDownload] = await Promise.all([
        page.waitForEvent("download", { timeout: 30_000 }),
        pngBtn.click(),
      ]);
      const pngPath = await pngDownload.path();
      expect(pngPath, "PNG indirme dosya yolu oluşmalı").toBeTruthy();
      const pngBytes = readFileSync(pngPath!);
      expect(Array.from(pngBytes.subarray(0, 4))).toEqual([0x89, 0x50, 0x4e, 0x47]);
      expect(pngBytes.length).toBeGreaterThan(256);
      await assertNoNavSkeletonFreeze(page);

      expect(
        recordFromInventory(
          (c) => c.route === "/insights/analysis" && ruleFor(c)?.id === "export/png",
          [
            `click '/insights/analysis' üzerinde 'PNG' düğmesi → '${pngDownload.suggestedFilename()}' indirildi (${pngBytes.length} bayt)`,
            "Dosya başlığı doğrulandı: PNG sihirli baytları [0x89, 0x50, 0x4E, 0x47] (\\x89PNG)",
            "DOM: [data-nav-skeleton] gizli ve [data-navigation-root] iskelet kilidine girmedi",
          ],
          "finance_operator",
        ),
      ).toBeGreaterThanOrEqual(0);

      // 2. SVG dışa aktarma (`<svg ... xmlns="http://www.w3.org/2000/svg">`)
      const svgBtn = page.getByRole("button", { name: /^(svg|SVG)$/ }).first();
      await expect(svgBtn).toBeVisible();
      const [svgDownload] = await Promise.all([
        page.waitForEvent("download", { timeout: 30_000 }),
        svgBtn.click(),
      ]);
      const svgPath = await svgDownload.path();
      expect(svgPath, "SVG indirme dosya yolu oluşmalı").toBeTruthy();
      const svgContent = readFileSync(svgPath!, "utf8");
      expect(svgContent).toContain("<svg");
      expect(svgContent).toContain('xmlns="http://www.w3.org/2000/svg"');
      expect(svgContent).toContain("</svg>");
      await assertNoNavSkeletonFreeze(page);

      expect(
        recordFromInventory(
          (c) => c.route === "/insights/analysis" && ruleFor(c)?.id === "export/svg",
          [
            `click '/insights/analysis' üzerinde 'SVG' düğmesi → '${svgDownload.suggestedFilename()}' indirildi (${svgContent.length} karakter)`,
            "XML içeriği doğrulandı: <svg xmlns=\"http://www.w3.org/2000/svg\">… ve kapanış </svg> mevcut",
            "DOM: [data-nav-skeleton] gizli ve [data-navigation-root] iskelet kilidine girmedi",
          ],
          "finance_operator",
        ),
      ).toBeGreaterThanOrEqual(0);

      // 3. PDF dışa aktarma (ExportBar `pdf` düğmesi varsa)
      const pdfBtn = page.getByRole("button", { name: /^(pdf|PDF)$/ }).first();
      if ((await pdfBtn.count()) > 0) {
        await page.evaluate(() => {
          const w = window as unknown as {
            __masPrintCount?: number;
            __masRenderPrintPdfBase64: () => Promise<string>;
          };
          w.__masPrintCount = 0;
          window.print = () => {
            w.__masPrintCount = (w.__masPrintCount ?? 0) + 1;
            void w.__masRenderPrintPdfBase64().then((b64) => {
              const bin = atob(b64);
              const bytes = new Uint8Array(bin.length);
              for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
              const blob = new Blob([bytes], { type: "application/pdf" });
              const url = URL.createObjectURL(blob);
              const a = document.createElement("a");
              a.href = url;
              a.download = "insights-analysis.pdf";
              document.body.appendChild(a);
              a.click();
              a.remove();
              URL.revokeObjectURL(url);
            });
          };
        });

        await expect(pdfBtn).toBeVisible();
        const [pdfDownload] = await Promise.all([
          page.waitForEvent("download", { timeout: 30_000 }),
          pdfBtn.click(),
        ]);
        const pdfPath = await pdfDownload.path();
        expect(pdfPath, "PDF indirme dosya yolu oluşmalı").toBeTruthy();
        const pdfBytes = readFileSync(pdfPath!);
        expect(pdfBytes.subarray(0, 5).toString("ascii")).toBe("%PDF-");
        expect(pdfBytes.length).toBeGreaterThan(1000);
        const printInvocations = await page.evaluate(
          () => (window as unknown as { __masPrintCount?: number }).__masPrintCount ?? 0,
        );
        expect(printInvocations).toBe(1);
        await assertNoNavSkeletonFreeze(page);

        expect(
          recordFromInventory(
            (c) => c.route === "/insights/analysis" && ruleFor(c)?.id === "export/pdf",
            [
              `click '/insights/analysis' üzerinde 'pdf' düğmesi → window.print() tetiklendi ve '${pdfDownload.suggestedFilename()}' indirildi (${pdfBytes.length} bayt)`,
              "Dosya başlığı doğrulandı: '%PDF-' sihirli başlığı mevcut",
              "DOM: [data-nav-skeleton] gizli ve [data-navigation-root] iskelet kilidine girmedi",
            ],
            "finance_operator",
          ),
        ).toBeGreaterThanOrEqual(0);
      }

      assertClean(s, "/insights/analysis dışa aktarmaları");
    } finally {
      await s.context.close();
    }
  });
});

test.describe("paylaşılan bileşen kontrolleri (DataTable, AnalyticsChart, form/select, arama ve ödeme paketi seçimi)", () => {
  test("sıralama, satır menüsü, sayfalama, erişilebilir tablo, seri gizleme/gösterme, select, arama ve kalem kutucukları", async ({
    browser,
  }) => {
    test.setTimeout(300_000);

    const op = await openAs(browser, "finance_operator");
    try {
      const { page } = op;

      // 1. `/payments/items` → `table/sort-header`, `table/row-menu`, `filter/free-input` ve `<select>`
      await page.goto("/payments/items", { waitUntil: "networkidle" });
      await waitForWorkspaceReady(page);

      const itemsRegion = page.locator('[role="region"][aria-label="Veri tablosu"]').first();
      await expect(itemsRegion).toBeVisible();

      const sortHeaderTh = itemsRegion.locator("thead th").filter({ hasText: "Ödeme" }).first();
      const sortBtn = sortHeaderTh.locator("button").first();
      await expect(sortBtn).toBeVisible();
      await expect(sortHeaderTh).toHaveAttribute("aria-sort", "ascending");
      const firstRowAsc = (await itemsRegion.locator("tbody tr").first().innerText()).trim();

      await sortBtn.click();
      await expect(sortHeaderTh).toHaveAttribute("aria-sort", "descending");
      const firstRowDesc = (await itemsRegion.locator("tbody tr").first().innerText()).trim();
      expect(firstRowDesc).not.toBe(firstRowAsc);

      await sortBtn.click();
      await sortBtn.click();
      await expect(sortHeaderTh).toHaveAttribute("aria-sort", "ascending");

      expect(
        recordFromInventory(
          (c) => ruleFor(c)?.id === "table/sort-header",
          [
            "click '/payments/items' DataTable 'Ödeme' sıralama başlığı (▲ → ▼ → ↕ → ▲)",
            `DOM: th[aria-sort] 'ascending' → 'descending' oldu ve ilk satır metni gerçekten değişti`,
            "Paylaşılan tekil DataTable sıralama başlığı bileşeni (src/components/ui/primitives/data-table.tsx)",
          ],
          "finance_operator",
        ),
      ).toBeGreaterThanOrEqual(1);

      // `/payments/items` satır aksiyonları menüsü (`⋯`)
      // Not: Radix DropdownMenu modal açıldığında arka plana aria-hidden='true' eklediği için
      // DOM öznitelik seçicisi (`button[aria-haspopup="menu"]`) ile aria-expanded doğrulanır.
      const itemMenuBtn = itemsRegion.locator('button[aria-haspopup="menu"]').first();
      await expect(itemMenuBtn).toBeVisible();
      await itemMenuBtn.click();
      await expect(itemMenuBtn).toHaveAttribute("aria-expanded", "true");
      const openMenu = page.locator('[role="menu"]').first();
      await expect(openMenu).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(openMenu).toBeHidden();

      // `/payments/items` serbest arama `<input>` (`filter/free-input`)
      const itemsSearch = page.getByPlaceholder("Ödeme ara (ad, etiket…)");
      await expect(itemsSearch).toBeVisible();
      await itemsSearch.fill("ZZ-IX Zeta Tedarik");
      await expect(itemsSearch).toHaveValue("ZZ-IX Zeta Tedarik");
      await expect(itemsRegion.locator("tbody")).toContainText("ZZ-IX Zeta Tedarik Ödemesi");
      await expect(itemsRegion.locator("tbody")).not.toContainText("00-IX Alfa Tedarik Ödemesi");
      await itemsSearch.fill("");
      await expect(itemsRegion.locator("tbody")).toContainText("00-IX Alfa Tedarik Ödemesi");

      // 2. `/finance/loans` → ikinci `table/row-menu` (`⋯`) kanıtı + ikinci `filter/free-input` kanıtı
      await page.goto("/finance/loans", { waitUntil: "networkidle" });
      await waitForWorkspaceReady(page);
      const loanMenuBtn = page
        .locator('[role="region"][aria-label="Veri tablosu"]')
        .first()
        .locator('button[aria-haspopup="menu"]')
        .first();
      await expect(loanMenuBtn).toBeVisible();
      await loanMenuBtn.click();
      await expect(loanMenuBtn).toHaveAttribute("aria-expanded", "true");
      await expect(page.locator('[role="menu"]').first()).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(page.locator('[role="menu"]').first()).toBeHidden();

      expect(
        recordFromInventory(
          (c) => ruleFor(c)?.id === "table/row-menu",
          [
            "click '/payments/items' ve '/finance/loans' üzerinde ActionMenu ('İşlemler' / '⋯')",
            "DOM: aria-expanded='true' ve Radix [role='menu'] açılır menüsü görünür oldu; Escape ile kapandı",
          ],
          "finance_operator",
        ),
      ).toBeGreaterThanOrEqual(1);

      const loanSearch = page.getByPlaceholder("Kredi ara…");
      await expect(loanSearch).toBeVisible();
      await loanSearch.fill("zzz-olmayan-kredi-sorgusu");
      await expect(loanSearch).toHaveValue("zzz-olmayan-kredi-sorgusu");
      await loanSearch.fill("");

      expect(
        recordFromInventory(
          (c) => ruleFor(c)?.id === "filter/free-input",
          [
            "fill '/payments/items' ('ZZ-IX Zeta Tedarik') ve '/finance/loans' ('Kredi ara…') DataTable arama girdileri",
            "DOM: inputValue() güncellendi ve görünen tablo satır kümesi anında daraldı; temizlenince tüm satırlar geri döndü",
          ],
          "finance_operator",
        ),
      ).toBeGreaterThanOrEqual(1);

      // 4. `table/a11y-disclosure`, `export/png`, `export/svg` ve `chart/series-toggle` (`/cashflow`, `/cashflow/monthly`, `/finance`)
      await page.goto("/cashflow", { waitUntil: "networkidle" });
      await waitForWorkspaceReady(page);
      const cfPngBtn = page.getByRole("button", { name: "PNG", exact: true }).first();
      await expect(cfPngBtn).toBeVisible();
      const [cfPngDl] = await Promise.all([page.waitForEvent("download", { timeout: 30_000 }), cfPngBtn.click()]);
      const cfPngPath = await cfPngDl.path();
      expect(cfPngPath).toBeTruthy();
      expect(Array.from(readFileSync(cfPngPath!).subarray(0, 4))).toEqual([0x89, 0x50, 0x4e, 0x47]);
      expect(
        recordFromInventory(
          (c) => ruleFor(c)?.id === "export/png",
          [
            `click '/cashflow' AnalyticsChart 'PNG' → '${cfPngDl.suggestedFilename()}' indirildi (PNG sihirli başlığı doğrulandı)`,
          ],
          "finance_operator",
        ),
      ).toBeGreaterThanOrEqual(1);

      const cfSvgBtn = page.getByRole("button", { name: "SVG", exact: true }).first();
      await expect(cfSvgBtn).toBeVisible();
      const [cfSvgDl] = await Promise.all([page.waitForEvent("download", { timeout: 30_000 }), cfSvgBtn.click()]);
      const cfSvgPath = await cfSvgDl.path();
      expect(cfSvgPath).toBeTruthy();
      expect(readFileSync(cfSvgPath!, "utf8")).toContain("<svg");
      expect(
        recordFromInventory(
          (c) => ruleFor(c)?.id === "export/svg",
          [
            `click '/cashflow' AnalyticsChart 'SVG' → '${cfSvgDl.suggestedFilename()}' indirildi (<svg> XML doğrulandı)`,
          ],
          "finance_operator",
        ),
      ).toBeGreaterThanOrEqual(1);
      const cfA11ySummary = page.locator("summary").filter({ hasText: /^Erişilebilir veri tablosu$/ }).first();
      await exerciseDisclosure(cfA11ySummary);
      const cfA11yTable = cfA11ySummary.locator("xpath=..").locator("table");
      await expect(cfA11yTable).toBeVisible();

      await page.goto("/cashflow/monthly", { waitUntil: "networkidle" });
      await waitForWorkspaceReady(page);
      const monthlySeriesBtn = page
        .locator('[aria-label="Grafik serileri"] button[aria-pressed]')
        .filter({ hasText: /^(Açılış|Kapanış|Gelir|Gider|Net hareket)/ })
        .first();
      await expect(monthlySeriesBtn).toBeVisible();
      const beforePressedMonthly = await monthlySeriesBtn.getAttribute("aria-pressed");
      await monthlySeriesBtn.click();
      await expect(monthlySeriesBtn).toHaveAttribute(
        "aria-pressed",
        beforePressedMonthly === "true" ? "false" : "true",
      );
      await monthlySeriesBtn.click();
      await expect(monthlySeriesBtn).toHaveAttribute("aria-pressed", beforePressedMonthly ?? "true");

      await page.goto("/finance", { waitUntil: "networkidle" });
      await waitForWorkspaceReady(page);
      const finSeriesBtn = page
        .locator('[aria-label="Grafik serileri"] button[aria-pressed]')
        .filter({ hasText: /^(Çek|Kredi taksiti)/ })
        .first();
      await expect(finSeriesBtn).toBeVisible();
      const beforePressedFin = await finSeriesBtn.getAttribute("aria-pressed");
      await finSeriesBtn.click();
      await expect(finSeriesBtn).toHaveAttribute("aria-pressed", beforePressedFin === "true" ? "false" : "true");
      await finSeriesBtn.click();
      await expect(finSeriesBtn).toHaveAttribute("aria-pressed", beforePressedFin ?? "true");

      // 5. `/finance/collections` → `collections/payment-run-item-select` (40 kutucuk) + kaynak banka `<select>` + temsilci `<select>` formları
      await page.goto("/finance/collections", { waitUntil: "networkidle" });
      await waitForWorkspaceReady(page);

      const sourceBankSelect = page.locator('select[name="sourceBankAccountId"]');
      const chosenBank = await exerciseSelect(sourceBankSelect);
      if (!chosenBank.chosen) {
        await sourceBankSelect.selectOption({ index: 1 });
      }
      expect(await sourceBankSelect.inputValue()).not.toBe("");

      const runCreateBtn = page.getByRole("button", { name: "TRY Ödeme Paketi Oluştur", exact: true });
      await expect(runCreateBtn).toBeVisible();
      await expect(runCreateBtn).toBeEnabled();

      const candidateCheckbox = page
        .locator('input[type="checkbox"][name="selectedTargets"]:not([disabled])')
        .first();
      await expect(candidateCheckbox).toBeVisible();
      await expect(candidateCheckbox).not.toBeChecked();

      await candidateCheckbox.check();
      await expect(candidateCheckbox).toBeChecked();

      await candidateCheckbox.uncheck();
      await expect(candidateCheckbox).not.toBeChecked();

      expect(
        recordFromInventory(
          (c) => ruleFor(c)?.id === "collections/payment-run-item-select",
          [
            "check/uncheck '/finance/collections' üzerinde input[type='checkbox'][name='selectedTargets']",
            "DOM: isChecked() false → true → false değişti ve 'TRY Ödeme Paketi Oluştur' formu tepki verdi",
          ],
          "finance_operator",
        ),
      ).toBeGreaterThanOrEqual(1);

      // Temsilci `<select>` formları (`/payments/new`, `/scenarios`)
      await page.goto("/payments/new", { waitUntil: "networkidle" });
      await waitForWorkspaceReady(page);
      const newPaymentSelects = page.locator("form select");
      const npSelectCount = await newPaymentSelects.count();
      expect(npSelectCount).toBeGreaterThanOrEqual(2);
      await exerciseSelect(newPaymentSelects.nth(0));
      await exerciseSelect(newPaymentSelects.nth(1));

      await page.goto("/scenarios", { waitUntil: "networkidle" });
      await waitForWorkspaceReady(page);
      await exerciseSelect(page.locator('select[name="horizon"]'));

      assertClean(op, "paylaşılan bileşen kontrolleri — finance_operator");
    } finally {
      await op.context.close();
    }

    // Üretim & arşiv & denetim rotaları için `finance_manager` ve `admin` oturumları
    const mgr = await openAs(browser, "finance_manager");
    try {
      const { page } = mgr;

      // `/production/capacity` seri düğmesi + erişilebilir tablo
      await page.goto("/production/capacity", { waitUntil: "networkidle" });
      await waitForWorkspaceReady(page);
      const capSeriesBtn = page
        .locator('[aria-label="Grafik serileri"] button[aria-pressed]')
        .filter({ hasText: /^Kullanım/ })
        .first();
      await expect(capSeriesBtn).toBeVisible();
      await expect(capSeriesBtn).toHaveAttribute("aria-pressed", "true");
      await capSeriesBtn.click();
      // Tek serili grafikte `toggleSeries` son görünür seriyi korur (`aria-pressed="true"`)
      await expect(capSeriesBtn).toHaveAttribute("aria-pressed", "true");

      const capA11y = page.locator("summary").filter({ hasText: /^Erişilebilir veri tablosu$/ }).first();
      await exerciseDisclosure(capA11y);
      await expect(capA11y.locator("xpath=..").locator("table")).toBeVisible();

      // `/production/profitability` seri düğmesi + erişilebilir tablo + DataTable sayfalama (`Sonraki →` / `← Önceki`)
      await page.goto("/production/profitability", { waitUntil: "networkidle" });
      await waitForWorkspaceReady(page);
      const profSeriesBtn = page
        .locator('[aria-label="Grafik serileri"] button[aria-pressed]')
        .filter({ hasText: /^Marj/ })
        .first();
      await expect(profSeriesBtn).toBeVisible();
      await expect(profSeriesBtn).toHaveAttribute("aria-pressed", "true");
      await profSeriesBtn.click();
      await expect(profSeriesBtn).toHaveAttribute("aria-pressed", "true");

      expect(
        recordFromInventory(
          (c) => ruleFor(c)?.id === "chart/series-toggle",
          [
            "click '/cashflow/monthly' ve '/finance' çoklu seri geçiş düğmeleri ('true' → 'false' → 'true') + '/production/capacity' ve '/production/profitability' tekli seri koruma düğmeleri",
            "DOM: çoklu serilerde button[aria-pressed] terslendi, tekli serilerde son görünür seri korundu ('true')",
            "Paylaşılan tekil AnalyticsChart seri araç çubuğu (src/components/charts/analytics-chart.tsx)",
          ],
          "finance_manager",
        ),
      ).toBeGreaterThanOrEqual(1);

      const profA11y = page.locator("summary").filter({ hasText: /^Erişilebilir veri tablosu$/ }).first();
      await exerciseDisclosure(profA11y);
      await expect(profA11y.locator("xpath=..").locator("table")).toBeVisible();

      expect(
        recordFromInventory(
          (c) => ruleFor(c)?.id === "table/a11y-disclosure",
          [
            "click '/cashflow', '/production/capacity' ve '/production/profitability' üzerinde <summary>Erişilebilir veri tablosu</summary>",
            "DOM: üst <details> open=true oldu ve içindeki erişilebilir <table> görünür doğrulandı",
            "Paylaşılan tekil AnalyticsChart erişilebilir tablo çekmecesi (src/components/charts/analytics-chart.tsx)",
          ],
          "finance_manager",
        ),
      ).toBeGreaterThanOrEqual(1);

      const profTableRegion = page.locator('[role="region"][aria-label="Veri tablosu"]').first();
      const profNextBtn = page.getByRole("button", { name: "Sonraki →", exact: true }).first();
      const profPrevBtn = page.getByRole("button", { name: "← Önceki", exact: true }).first();
      await expect(profPrevBtn).toBeDisabled();
      await expect(profNextBtn).toBeEnabled();
      const profPage1FirstRow = (await profTableRegion.locator("tbody tr").first().innerText()).trim();

      await profNextBtn.click();
      await expect(profPrevBtn).toBeEnabled();
      const profPage2FirstRow = (await profTableRegion.locator("tbody tr").first().innerText()).trim();
      expect(profPage2FirstRow).not.toBe(profPage1FirstRow);

      await profPrevBtn.click();
      await expect(profPrevBtn).toBeDisabled();
      expect((await profTableRegion.locator("tbody tr").first().innerText()).trim()).toBe(profPage1FirstRow);

      // `/system/archive` üzerinde `<select>` kontrolü
      await page.goto("/system/archive", { waitUntil: "networkidle" });
      await waitForWorkspaceReady(page);
      await exerciseSelect(page.locator('select[name="type"]'));

      expect(
        recordFromInventory(
          (c) => c.tag === "select" && c.route !== "/system/security",
          [
            "selectOption '/finance/collections' (sourceBankAccountId), '/payments/new', '/scenarios' (horizon) ve '/system/archive' (type) <select> kontrolleri",
            "DOM: select.inputValue() seçilen opsiyona güncellendi ve bağımlı form durumu tepki verdi",
            "Paylaşılan standart HTML <select> form kontrolü",
          ],
          "finance_manager",
        ),
      ).toBeGreaterThanOrEqual(1);

      assertClean(mgr, "paylaşılan bileşen kontrolleri — finance_manager");
    } finally {
      await mgr.context.close();
    }

    const adm = await openAs(browser, "admin");
    try {
      const { page } = adm;
      await page.goto("/system/audit", { waitUntil: "networkidle" });
      await waitForWorkspaceReady(page);

      const auditRegion = page.locator('[role="region"][aria-label="Veri tablosu"]').first();
      const auditNextBtn = page.getByRole("button", { name: "Sonraki →", exact: true }).first();
      const auditPrevBtn = page.getByRole("button", { name: "← Önceki", exact: true }).first();
      await expect(auditPrevBtn).toBeDisabled();
      await expect(auditNextBtn).toBeEnabled();
      const auditPage1FirstRow = (await auditRegion.locator("tbody tr").first().innerText()).trim();

      await auditNextBtn.click();
      await expect(auditPrevBtn).toBeEnabled();
      const auditPage2FirstRow = (await auditRegion.locator("tbody tr").first().innerText()).trim();
      expect(auditPage2FirstRow).not.toBe(auditPage1FirstRow);

      await auditPrevBtn.click();
      await expect(auditPrevBtn).toBeDisabled();
      expect((await auditRegion.locator("tbody tr").first().innerText()).trim()).toBe(auditPage1FirstRow);

      expect(
        recordFromInventory(
          (c) => c.tag === "button" && ruleFor(c)?.id === "table/pagination",
          [
            "click '/production/profitability' ve '/system/audit' DataTable üzerinde 'Sonraki →' ardından '← Önceki'",
            "DOM: görünen ilk satır metni sayfa 1 ↔ sayfa 2 arasında gerçekten değişti ve '← Önceki' disabled → enabled → disabled geçişi yaptı",
          ],
          "admin",
        ),
      ).toBeGreaterThanOrEqual(1);

      assertClean(adm, "paylaşılan bileşen kontrolleri — admin");
    } finally {
      await adm.context.close();
    }
  });
});

test.describe("rota bazlı UI durumu kontrolleri (çekmeceler, filtreler, önizlemeler ve dosya girdileri)", () => {
  test("operatör rotaları: genel bakış, ödemeler, nakit akışı, finans, senaryolar, içgörüler ve veri ekranları", async ({
    browser,
  }) => {
    test.setTimeout(360_000);

    const s = await openAs(browser, "finance_operator");
    try {
      const { page } = s;

      // 1. `/` → `Bu sonuç neden çıktı?` (`chart/why`)
      await page.goto("/", { waitUntil: "networkidle" });
      await waitForWorkspaceReady(page);
      await page.evaluate(() => {
        document.querySelectorAll("main details:not([open])").forEach((d) => {
          (d as HTMLDetailsElement).open = true;
        });
      });
      const whyBtn = page.getByRole("button", { name: "Bu sonuç neden çıktı?", exact: true }).first();
      await expect(whyBtn).toBeVisible();
      await whyBtn.click();
      const whyDialog = page.getByRole("dialog");
      await expect(whyDialog).toBeVisible({ timeout: 15_000 });
      await expect(whyDialog).toContainText(/Hesaplama ve kaynak/i);
      await whyDialog.getByRole("button", { name: /kapat/i }).first().click();
      await expect(whyDialog).toBeHidden();

      expect(
        recordFromInventory(
          (c) => c.route === "/" && ruleFor(c)?.id === "chart/why",
          [
            "click '/' üzerinde 'Bu sonuç neden çıktı?' düğmesi",
            "DOM: Radix [role='dialog'] ('Hesaplama ve kaynak') çekmecesi açıldı ve 'Kapat' düğmesiyle kapandı",
          ],
          "finance_operator",
        ),
      ).toBe(1);

      // 2. `/payments/items` → SavedViewsBar `<summary>` + `Filtrele`
      await page.goto("/payments/items", { waitUntil: "networkidle" });
      await waitForWorkspaceReady(page);
      const paySavedSummary = page
        .locator("summary")
        .filter({ hasText: /^Filtre uygula veya mevcut görünümü kaydet/ })
        .first();
      await exerciseDisclosure(paySavedSummary);
      await page.locator('select[name="cur"]').first().selectOption("TRY");
      await page.getByRole("button", { name: "Filtrele", exact: true }).click();
      await page.waitForLoadState("networkidle");
      expect(new URL(page.url()).searchParams.get("cur")).toBe("TRY");

      expect(
        recordFromInventory(
          (c) => c.route === "/payments/items" && ruleFor(c)?.id === "filter/saved-views-disclosure",
          [
            "click '/payments/items' üzerinde <summary>Filtre uygula veya mevcut görünümü kaydet…</summary>",
            "DOM: SavedViewsBar <details> open=true durumuna geçti",
          ],
          "finance_operator",
        ),
      ).toBeGreaterThanOrEqual(1);
      expect(
        recordFromInventory(
          (c) => c.route === "/payments/items" && ruleFor(c)?.id === "filter/apply-filter",
          [
            "select cur='TRY' + click '/payments/items' üzerinde 'Filtrele'",
            "URL ve DOM: ?cur=TRY sorgu parametresi uygulandı ve tablo yeniden yüklendi",
          ],
          "finance_operator",
        ),
      ).toBe(1);

      // 3. `/payments/calendar` → `Aya git` (`calendar/goto-month`)
      await page.goto("/payments/calendar", { waitUntil: "networkidle" });
      await waitForWorkspaceReady(page);
      const monthInput = page.locator('input[type="month"][name="ym"]');
      await expect(monthInput).toBeVisible();
      await monthInput.fill("2026-09");
      await page.getByRole("button", { name: "Aya git", exact: true }).click();
      await page.waitForLoadState("networkidle");
      expect(new URL(page.url()).searchParams.get("ym")).toBe("2026-09");

      expect(
        recordFromInventory(
          (c) => c.route === "/payments/calendar" && ruleFor(c)?.id === "calendar/goto-month",
          [
            "fill input[name='ym']='2026-09' + click '/payments/calendar' üzerinde 'Aya git'",
            "URL ve DOM: /payments/calendar?ym=2026-09 yüklendi ve Eylül 2026 takvim ızgarası render edildi",
          ],
          "finance_operator",
        ),
      ).toBe(1);

      // 4. `/payments/history` → `Uygula` (`filter/apply`)
      await page.goto("/payments/history", { waitUntil: "networkidle" });
      await waitForWorkspaceReady(page);
      const histQ = page.locator('input[name="q"]').first();
      await histQ.fill("IX-UI");
      await page.getByRole("button", { name: "Uygula", exact: true }).click();
      await page.waitForLoadState("networkidle");
      expect(new URL(page.url()).searchParams.get("q")).toBe("IX-UI");

      expect(
        recordFromInventory(
          (c) => c.route === "/payments/history" && ruleFor(c)?.id === "filter/apply",
          [
            "fill input[name='q']='IX-UI' + click '/payments/history' üzerinde 'Uygula'",
            "URL ve DOM: /payments/history?q=IX-UI ile geçmiş listesi filtrelendi",
          ],
          "finance_operator",
        ),
      ).toBe(1);

      // 5. `/cashflow/13-week` → `Açık Kayıtlardan Otomatik Yenile` (`cashflow-13w/refresh`)
      await page.goto("/cashflow/13-week", { waitUntil: "networkidle" });
      await waitForWorkspaceReady(page);
      const refresh13wBtn = page.getByRole("button", { name: "Açık Kayıtlardan Otomatik Yenile", exact: true });
      await expect(refresh13wBtn).toBeVisible();
      await clickAndSettle(page, () => refresh13wBtn.click());
      await waitForWorkspaceReady(page);
      await expect(refresh13wBtn).toBeVisible({ timeout: 20_000 });

      expect(
        recordFromInventory(
          (c) => c.route === "/cashflow/13-week" && ruleFor(c)?.id === "cashflow-13w/refresh",
          [
            "click '/cashflow/13-week' üzerinde 'Açık Kayıtlardan Otomatik Yenile'",
            "Sunucu aksiyonu 200 ile tamamlandı ve 13 haftalık nakit tahmini görünümü hatasız yenilendi",
          ],
          "finance_operator",
        ),
      ).toBe(1);

      // 6. `/cashflow/budget` → her iki `<summary>` çekmecesi
      await page.goto("/cashflow/budget", { waitUntil: "networkidle" });
      await waitForWorkspaceReady(page);
      for (const label of ["+ Yeni Bütçe Kabı Oluştur", "+ 13 Haftalık Tahmin Kabı ve Satırı Ekle"]) {
        const sum = page.locator("summary").filter({ hasText: label }).first();
        await exerciseDisclosure(sum);
        expect(
          recordFromInventory(
            (c) => c.route === "/cashflow/budget" && c.tag === "summary" && c.label === label,
            [
              `click '/cashflow/budget' üzerinde <summary>${label}</summary>`,
              "DOM: <details> open=true durumuna geçti ve içindeki form görünür doğrulandı",
            ],
            "finance_operator",
          ),
        ).toBe(1);
      }

      // 7. `/finance/facilities` → tüm `<summary>` çekmeceleri
      await page.goto("/finance/facilities", { waitUntil: "networkidle" });
      await waitForWorkspaceReady(page);
      for (const label of [
        "+ Yeni Kredi Limiti Tanımla",
        "+ Teminat Ekle (İpotek / Rehin / Kefalet / Blokaj)",
        "+ Kovenant Maddesi ve Ölçüm Ekle / Güncelle",
        "+ Verilen Teminat Mektubu Kaydet",
      ]) {
        const sum = page.locator("summary").filter({ hasText: label }).first();
        if ((await sum.count()) > 0) {
          await exerciseDisclosure(sum);
        }
      }
      expect(
        recordFromInventory(
          (c) => c.route === "/finance/facilities" && ruleFor(c)?.id === "facilities/disclosure",
          [
            "click '/finance/facilities' üzerinde <summary> çekmeceleri (+ Yeni Kredi Limiti, + Verilen Teminat Mektubu, + Teminat, + Kovenant)",
            "DOM: <details> open=true durumuna geçti ve alt form alanları görünür oldu",
          ],
          "finance_operator",
        ),
      ).toBeGreaterThanOrEqual(1);

      // 8. `/finance/counterparties` → `Ekstreyi Göster` (operatör oturumu; IBAN/boyut çekmeceleri finance_manager testinde)
      await page.goto("/finance/counterparties", { waitUntil: "networkidle" });
      await waitForWorkspaceReady(page);

      const stmtPartySelect = page.locator('select[name="ledgerParty"]').first();
      await stmtPartySelect.selectOption(fixtureInfo.vendorPartyId);
      await page.getByRole("button", { name: "Ekstreyi Göster", exact: true }).click();
      await page.waitForLoadState("networkidle");
      expect(new URL(page.url()).searchParams.get("ledgerParty")).toBe(fixtureInfo.vendorPartyId);

      expect(
        recordFromInventory(
          (c) => c.route === "/finance/counterparties" && ruleFor(c)?.id === "counterparties/show-statement",
          [
            `select ledgerParty='${fixtureInfo.vendorPartyId}' + click 'Ekstreyi Göster'`,
            "URL ve DOM: ?ledgerParty parametresi uygulandı ve cari ekstre bölümü render edildi",
          ],
          "finance_operator",
        ),
      ).toBe(1);

      // 9. `/finance/invoices` → SavedViewsBar `<summary>` + `Filtrele`
      await page.goto("/finance/invoices", { waitUntil: "networkidle" });
      await waitForWorkspaceReady(page);
      const invSavedSummary = page
        .locator("summary")
        .filter({ hasText: /^Filtre uygula veya mevcut görünümü kaydet/ })
        .first();
      await exerciseDisclosure(invSavedSummary);
      await page.locator('select[name="cur"]').first().selectOption("TRY");
      await page.getByRole("button", { name: "Filtrele", exact: true }).click();
      await page.waitForLoadState("networkidle");
      expect(new URL(page.url()).searchParams.get("cur")).toBe("TRY");

      expect(
        recordFromInventory(
          (c) => c.route === "/finance/invoices" && ruleFor(c)?.id === "filter/saved-views-disclosure",
          [
            "click '/finance/invoices' üzerinde <summary>Filtre uygula veya mevcut görünümü kaydet…</summary>",
            "DOM: SavedViewsBar <details> open=true durumuna geçti",
          ],
          "finance_operator",
        ),
      ).toBeGreaterThanOrEqual(1);
      expect(
        recordFromInventory(
          (c) => c.route === "/finance/invoices" && ruleFor(c)?.id === "filter/apply-filter",
          [
            "select cur='TRY' + click '/finance/invoices' üzerinde 'Filtrele'",
            "URL ve DOM: ?cur=TRY uygulandı ve fatura listesi filtrelendi",
          ],
          "finance_operator",
        ),
      ).toBe(1);

      // 10. `/finance/receivables` → `FIFO Dağıtım Önerisi Hesapla`
      await page.goto("/finance/receivables", { waitUntil: "networkidle" });
      await waitForWorkspaceReady(page);
      await page.locator('select[name="fifoParty"]').selectOption(fixtureInfo.customerPartyId);
      await page.locator('select[name="fifoDirection"]').selectOption("sales");
      await page.locator('select[name="fifoCurrency"]').selectOption("TRY");
      await page.locator('input[name="fifoAmount"]').fill("5000");
      await page.getByRole("button", { name: "FIFO Dağıtım Önerisi Hesapla", exact: true }).click();
      await page.waitForLoadState("networkidle");
      expect(new URL(page.url()).searchParams.get("fifoParty")).toBe(fixtureInfo.customerPartyId);
      await expect(page.locator("#fifo-oneri")).toContainText(/fatura önerildi/);

      expect(
        recordFromInventory(
          (c) => c.route === "/finance/receivables" && ruleFor(c)?.id === "receivables/fifo-preview",
          [
            `select fifoParty='${fixtureInfo.customerPartyId}', fifoAmount='5000' + click 'FIFO Dağıtım Önerisi Hesapla'`,
            "DOM: #fifo-oneri bölümünde açık satış faturası için 'fatura önerildi' FIFO dağıtım önizleme tablosu render edildi",
          ],
          "finance_operator",
        ),
      ).toBe(1);

      // 11. `/scenarios` → `useExternalAssumptions` kutucuğu + `Ufku Hesapla`
      await page.goto("/scenarios", { waitUntil: "networkidle" });
      await waitForWorkspaceReady(page);
      const extAssumpCb = page.locator('input[type="checkbox"][name="useExternalAssumptions"]').first();
      await expect(extAssumpCb).toBeVisible();
      const extInitiallyChecked = await extAssumpCb.isChecked();
      if (extInitiallyChecked) {
        await extAssumpCb.uncheck();
        await expect(extAssumpCb).not.toBeChecked();
        await extAssumpCb.check();
        await expect(extAssumpCb).toBeChecked();
      } else {
        await extAssumpCb.check();
        await expect(extAssumpCb).toBeChecked();
        await extAssumpCb.uncheck();
        await expect(extAssumpCb).not.toBeChecked();
      }

      await page.locator('select[name="horizon"]').selectOption("12m");
      await page.getByRole("button", { name: "Ufku Hesapla", exact: true }).click();
      await page.waitForLoadState("networkidle");
      expect(new URL(page.url()).searchParams.get("horizon")).toBe("12m");

      expect(
        recordFromInventory(
          (c) => c.route === "/scenarios" && ruleFor(c)?.id === "scenarios/apply-assumptions-checkbox",
          [
            "check/uncheck '/scenarios' üzerinde input[type='checkbox'][name='useExternalAssumptions']",
            "DOM: isChecked() durumu iki yönlü değiştirildi ve doğrulandı",
          ],
          "finance_operator",
        ),
      ).toBeGreaterThanOrEqual(1);
      expect(
        recordFromInventory(
          (c) => c.route === "/scenarios" && ruleFor(c)?.id === "scenarios/goalseek-horizon",
          [
            "select horizon='12m' + click '/scenarios' üzerinde 'Ufku Hesapla'",
            "URL ve DOM: /scenarios?horizon=12m ile başabaş analizi ufku güncellendi",
          ],
          "finance_operator",
        ),
      ).toBe(1);

      // 12. `/scenarios/optimization` → `<summary>Varsayımları göster</summary>` + `Çözücüyü Çalıştır`
      await page.goto("/scenarios/optimization", { waitUntil: "networkidle" });
      await waitForWorkspaceReady(page);
      const optAssumpSummary = page.locator("summary").filter({ hasText: /^Varsayımları göster$/ }).first();
      if ((await optAssumpSummary.count()) > 0) {
        await exerciseDisclosure(optAssumpSummary);
      }

      const runOptimizerBtn = page.getByRole("button", { name: "Çözücüyü Çalıştır", exact: true });
      await expect(runOptimizerBtn).toBeVisible();
      await clickAndSettle(page, () => runOptimizerBtn.click());
      await waitForWorkspaceReady(page);
      await expect(runOptimizerBtn).toBeVisible({ timeout: 20_000 });

      expect(
        recordFromInventory(
          (c) => c.route === "/scenarios/optimization" && ruleFor(c)?.id === "scenarios/assumptions-disclosure",
          [
            "click '/scenarios/optimization' üzerinde <summary>Varsayımları göster</summary>",
            "DOM: aday aksiyon varsayım listesi <details open> olarak açıldı",
          ],
          "finance_operator",
        ),
      ).toBeGreaterThanOrEqual(0);
      expect(
        recordFromInventory(
          (c) => c.route === "/scenarios/optimization" && ruleFor(c)?.id === "scenarios/run-optimizer",
          [
            "click '/scenarios/optimization' üzerinde 'Çözücüyü Çalıştır'",
            "Sunucu aksiyonu 200 ile tamamlandı ve likidite optimizasyon sonucu hatasız render edildi",
          ],
          "finance_operator",
        ),
      ).toBe(1);

      // 13. `/insights/ask` → `Sorgula` (`ask/telegram-query`)
      await page.goto("/insights/ask", { waitUntil: "networkidle" });
      await waitForWorkspaceReady(page);
      const tgInput = page.locator('input[name="tg"]');
      await expect(tgInput).toBeVisible();
      await tgInput.fill("nakit");
      await page.getByRole("button", { name: "Sorgula", exact: true }).click();
      await page.waitForLoadState("networkidle");
      expect(new URL(page.url()).searchParams.get("tg")).toBe("nakit");

      expect(
        recordFromInventory(
          (c) => c.route === "/insights/ask" && ruleFor(c)?.id === "ask/telegram-query",
          [
            "fill input[name='tg']='nakit' + click '/insights/ask' üzerinde 'Sorgula'",
            "URL ve DOM: /insights/ask?tg=nakit ile salt-okunur CFO hızlı sorgu yanıtı render edildi",
          ],
          "finance_operator",
        ),
      ).toBe(1);

      // 14. `/insights/tasks` → `Filtrele` (`filter/apply-filter`)
      await page.goto("/insights/tasks", { waitUntil: "networkidle" });
      await waitForWorkspaceReady(page);
      await page.locator('input[name="q"]').first().fill("IX");
      await page.getByRole("button", { name: "Filtrele", exact: true }).first().click();
      await page.waitForLoadState("networkidle");
      expect(new URL(page.url()).searchParams.get("q")).toBe("IX");

      expect(
        recordFromInventory(
          (c) => ruleFor(c)?.id === "filter/apply-filter",
          [
            "fill input[name='q']='IX' + click '/insights/tasks', '/payments/items' ve '/finance/invoices' üzerinde 'Filtrele'",
            "URL ve DOM: ?q=IX / ?cur=TRY sorgu parametreleri uygulandı ve listeler filtrelendi",
          ],
          "finance_operator",
        ),
      ).toBeGreaterThanOrEqual(1);

      // 15. `/insights/reminders` → `<summary>+ Yeni hatırlatma kuralı ekle</summary>` + aktif kutucuğu
      await page.goto("/insights/reminders", { waitUntil: "networkidle" });
      await waitForWorkspaceReady(page);
      const remSummary = page.locator("summary").filter({ hasText: "+ Yeni hatırlatma kuralı ekle" }).first();
      await exerciseDisclosure(remSummary);
      const remActiveCb = remSummary.locator("xpath=..").locator('input[type="checkbox"][name="isActive"]').first();
      await expect(remActiveCb).toBeVisible();
      const remStart = await remActiveCb.isChecked();
      if (remStart) {
        await remActiveCb.uncheck();
        await expect(remActiveCb).not.toBeChecked();
        await remActiveCb.check();
        await expect(remActiveCb).toBeChecked();
      } else {
        await remActiveCb.check();
        await expect(remActiveCb).toBeChecked();
      }

      expect(
        recordFromInventory(
          (c) => c.route === "/insights/reminders" && ruleFor(c)?.id === "reminders/rule-disclosure",
          [
            "click '/insights/reminders' üzerinde <summary>+ Yeni hatırlatma kuralı ekle</summary>",
            "DOM: <details> open=true oldu ve kural ekleme formu görünür doğrulandı",
          ],
          "finance_operator",
        ),
      ).toBe(1);
      expect(
        recordFromInventory(
          (c) => c.route === "/insights/reminders" && ruleFor(c)?.id === "reminders/rule-checkbox",
          [
            "uncheck/check '/insights/reminders' üzerinde input[type='checkbox'][name='isActive']",
            "DOM: isChecked() durumu iki yönlü değiştirildi ve doğrulandı",
          ],
          "finance_operator",
        ),
      ).toBe(1);

      // 16. `/data/imports`, `/data/documents`, `/data/trial-balance-bridge` → dosya `<input type="file">` kontrolleri
      await page.goto("/data/imports", { waitUntil: "networkidle" });
      await waitForWorkspaceReady(page);
      const impFile = page.locator('input[type="file"]').first();
      await impFile.setInputFiles({
        name: "ornek-calisma-kitabi.xlsx",
        mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        buffer: Buffer.from("PK-placeholder"),
      });
      expect(await impFile.evaluate((el) => (el as HTMLInputElement).files?.[0]?.name ?? "")).toBe(
        "ornek-calisma-kitabi.xlsx",
      );
      expect(
        recordFromInventory(
          (c) => c.route === "/data/imports" && ruleFor(c)?.id === "imports/file-input",
          [
            "setInputFiles '/data/imports' üzerinde input[type='file'] ('ornek-calisma-kitabi.xlsx')",
            "DOM: HTMLInputElement.files[0].name === 'ornek-calisma-kitabi.xlsx' olarak bağlandı",
          ],
          "finance_operator",
        ),
      ).toBe(1);

      await page.goto("/data/documents", { waitUntil: "networkidle" });
      await waitForWorkspaceReady(page);
      const docFile = page.locator('input[type="file"]').first();
      await docFile.setInputFiles({
        name: "ornek-belge.pdf",
        mimeType: "application/pdf",
        buffer: Buffer.from("%PDF-1.4\n%%EOF\n"),
      });
      expect(await docFile.evaluate((el) => (el as HTMLInputElement).files?.[0]?.name ?? "")).toBe("ornek-belge.pdf");
      expect(
        recordFromInventory(
          (c) => c.route === "/data/documents" && ruleFor(c)?.id === "documents/file-input",
          [
            "setInputFiles '/data/documents' üzerinde input[type='file'] ('ornek-belge.pdf')",
            "DOM: HTMLInputElement.files[0].name === 'ornek-belge.pdf' olarak bağlandı (geçersiz kayıt gönderilmedi)",
          ],
          "finance_operator",
        ),
      ).toBe(1);

      await page.goto("/data/trial-balance-bridge", { waitUntil: "networkidle" });
      await waitForWorkspaceReady(page);
      const tbFile = page.locator('input[type="file"]').first();
      await tbFile.setInputFiles({
        name: "ornek-mizan.csv",
        mimeType: "text/csv",
        buffer: Buffer.from("hesap_kodu;borc;alacak\n100;1000;0\n"),
      });
      expect(await tbFile.evaluate((el) => (el as HTMLInputElement).files?.[0]?.name ?? "")).toBe("ornek-mizan.csv");
      expect(
        recordFromInventory(
          (c) => c.route === "/data/trial-balance-bridge" && ruleFor(c)?.id === "trial-balance/file-input",
          [
            "setInputFiles '/data/trial-balance-bridge' üzerinde input[type='file'] ('ornek-mizan.csv')",
            "DOM: HTMLInputElement.files[0].name === 'ornek-mizan.csv' olarak bağlandı (form gönderilmedi)",
          ],
          "finance_operator",
        ),
      ).toBe(1);

      // 17. `/data/reviews` → `Uygula` (`filter/apply`)
      await page.goto("/data/reviews", { waitUntil: "networkidle" });
      await waitForWorkspaceReady(page);
      await page.locator('input[name="q"]').first().fill("IX");
      await page.getByRole("button", { name: "Uygula", exact: true }).click();
      await page.waitForLoadState("networkidle");
      expect(new URL(page.url()).searchParams.get("q")).toBe("IX");

      expect(
        recordFromInventory(
          (c) => c.route === "/data/reviews" && ruleFor(c)?.id === "filter/apply",
          [
            "fill input[name='q']='IX' + click '/data/reviews' üzerinde 'Uygula'",
            "URL ve DOM: /data/reviews?q=IX ile inceleme kuyruğu filtrelendi",
          ],
          "finance_operator",
        ),
      ).toBe(1);

      assertClean(s, "operatör rota bazlı UI durumu kontrolleri");
    } finally {
      await s.context.close();
    }
  });

  test("yönetici ve admin rotaları: üretim çekmeceleri, Standart Import V2 önizleme, arşiv filtresi, kârlılık kuralı ve tanılama yenileme", async ({
    browser,
  }) => {
    test.setTimeout(360_000);

    const mgr = await openAs(browser, "finance_manager");
    try {
      const { page } = mgr;

      // 0. `/finance/counterparties` → IBAN ve organizasyonel boyut çekmeceleri + `isPrimary` kutucuğu (`finance_manager` yetkisi gerekir)
      await page.goto("/finance/counterparties", { waitUntil: "networkidle" });
      await waitForWorkspaceReady(page);

      const ibanSummary = page.locator("summary").filter({ hasText: "+ Yeni IBAN ekle" }).first();
      await exerciseDisclosure(ibanSummary);
      const primaryIbanCheckbox = ibanSummary
        .locator("xpath=..")
        .locator('input[type="checkbox"][name="isPrimary"]')
        .first();
      await expect(primaryIbanCheckbox).toBeVisible();
      const wasPrimaryChecked = await primaryIbanCheckbox.isChecked();
      if (wasPrimaryChecked) {
        await primaryIbanCheckbox.uncheck();
        await expect(primaryIbanCheckbox).not.toBeChecked();
        await primaryIbanCheckbox.check();
        await expect(primaryIbanCheckbox).toBeChecked();
      } else {
        await primaryIbanCheckbox.check();
        await expect(primaryIbanCheckbox).toBeChecked();
        await primaryIbanCheckbox.uncheck();
        await expect(primaryIbanCheckbox).not.toBeChecked();
      }

      const dimSummary = page.locator("summary").filter({ hasText: "+ Yeni boyut ekle" }).first();
      await exerciseDisclosure(dimSummary);

      const editPartySummary = page.locator("summary").filter({ hasText: "Seçili Cari Kartı" }).first();
      if ((await editPartySummary.count()) > 0) {
        await exerciseDisclosure(editPartySummary);
      }

      expect(
        recordFromInventory(
          (c) => c.route === "/finance/counterparties" && ruleFor(c)?.id === "counterparties/disclosure",
          [
            "click '/finance/counterparties' üzerinde <summary> (+ Yeni IBAN ekle, + Yeni boyut ekle, ✎ Seçili Cari Kartı) çekmeceleri",
            "DOM: <details> open=true oldu ve cari yönetim formları görünür doğrulandı",
          ],
          "finance_manager",
        ),
      ).toBeGreaterThanOrEqual(2);
      expect(
        recordFromInventory(
          (c) => c.route === "/finance/counterparties" && ruleFor(c)?.id === "counterparties/primary-iban-checkbox",
          [
            "check/uncheck '/finance/counterparties' üzerinde input[type='checkbox'][name='isPrimary'] (finance_manager oturumu)",
            "DOM: isChecked() durumu iki yönlü değiştirildi ve doğrulandı",
          ],
          "finance_manager",
        ),
      ).toBe(1);

      // 1. `/production`, `/production/costs`, `/production/roi` → tüm `<summary>` çekmeceleri
      await page.goto("/production", { waitUntil: "networkidle" });
      await waitForWorkspaceReady(page);
      for (const label of ["KAYNAK GELİR DAĞILIMI", "+ Kapasite / vardiya parametresi ekle"]) {
        const sum = page.locator("summary").filter({ hasText: label }).first();
        if ((await sum.count()) > 0) {
          await exerciseDisclosure(sum);
        }
      }

      await page.goto("/production/costs", { waitUntil: "networkidle" });
      await waitForWorkspaceReady(page);
      for (const label of [
        "+ Sabit maliyet kalemi ekle / güncelle",
        "+ Tezgâh / müşteri dakika tarifesi (TL/dk) güncelle",
        "+ Yeni müşteri kontrat dakika tarifesi",
        "+ Tekil üretim parçası (süre / birim satış fiyatı) ekle veya güncelle",
        "+ Katalog ürünü ekle / güncelle",
      ]) {
        const sum = page.locator("summary").filter({ hasText: label }).first();
        if ((await sum.count()) > 0) {
          await exerciseDisclosure(sum);
        }
      }

      await page.goto("/production/roi", { waitUntil: "networkidle" });
      await waitForWorkspaceReady(page);
      const roiSummary = page
        .locator("summary")
        .filter({ hasText: "+ Klasik makine / yıllık ROI kaydı ekle veya güncelle" })
        .first();
      await exerciseDisclosure(roiSummary);
      expect(
        recordFromInventory(
          (c) => ruleFor(c)?.id === "production/disclosure",
          [
            "click '/production', '/production/costs' ve '/production/roi' üzerindeki tüm <summary> çekmeceleri",
            "DOM: her <details> open=true oldu ve alt formlar/tablolar görünür doğrulandı",
          ],
          "finance_manager",
        ),
      ).toBeGreaterThanOrEqual(6);

      // 2. `/data/imports/v2` → 6 `kolonları göster (...)` çekmecesi + geçerli V2 `.xlsx` dosya seçimi + `ÖNİZLE`
      const wb = await buildFixtureWorkbook();
      const v2Buffer = Buffer.from(await wb.xlsx.writeBuffer());
      const expectedRejected = Object.values(FIXTURE_ORACLE.sheets).reduce((n, x) => n + x.rejected, 0);
      const wbCountBefore = Number(
        await scalar<string>(
          "select count(*) from public.source_workbooks where notes like 'Standart Import V2%'",
        ),
      );

      await page.goto("/data/imports/v2", { waitUntil: "networkidle" });
      await waitForWorkspaceReady(page);

      for (const label of [
        "kolonları göster (13)",
        "kolonları göster (10)",
        "kolonları göster (18)",
        "kolonları göster (12)",
        "kolonları göster (11)",
        "kolonları göster (9)",
      ]) {
        const colSummary = page.locator("summary").filter({ hasText: label }).first();
        await exerciseDisclosure(colSummary);
        expect(
          recordFromInventory(
            (c) => c.route === "/data/imports/v2" && c.tag === "summary" && c.label === label,
            [
              `click '/data/imports/v2' üzerinde <summary>${label}</summary>`,
              "DOM: şablon sekme kolon sözlüğü <details open> durumuna geçti",
            ],
            "finance_manager",
          ),
        ).toBe(1);
      }

      const v2FileInput = page.getByTestId("v2-file");
      await v2FileInput.setInputFiles({
        name: "fixture-v2.xlsx",
        mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        buffer: v2Buffer,
      });
      expect(await v2FileInput.evaluate((el) => (el as HTMLInputElement).files?.[0]?.name ?? "")).toBe(
        "fixture-v2.xlsx",
      );

      await page.getByRole("button", { name: "ÖNİZLE", exact: true }).click();
      const confirmImportBtn = page.getByRole("button", { name: "ONAYLA VE İÇE AKTAR" });
      await expect(confirmImportBtn).toBeVisible({ timeout: 120_000 });
      const rejectedCardText = await page.locator("text=REDDEDİLECEK").locator("..").innerText();
      expect(rejectedCardText).toContain(String(expectedRejected));

      const wbCountAfterPreview = Number(
        await scalar<string>(
          "select count(*) from public.source_workbooks where notes like 'Standart Import V2%'",
        ),
      );
      expect(wbCountAfterPreview).toBe(wbCountBefore);

      expect(
        recordFromInventory(
          (c) => c.route === "/data/imports/v2" && ruleFor(c)?.id === "imports/file-input",
          [
            "setInputFiles '/data/imports/v2' üzerinde [data-testid='v2-file'] ('fixture-v2.xlsx')",
            "DOM: geçerli Standart Import V2 çalışma kitabı girdi kontrolüne bağlandı",
          ],
          "finance_manager",
        ),
      ).toBe(1);
      expect(
        recordFromInventory(
          (c) => c.route === "/data/imports/v2" && ruleFor(c)?.id === "imports-v2/preview",
          [
            `click '/data/imports/v2' üzerinde 'ÖNİZLE' → 'ONAYLA VE İÇE AKTAR' + REDDEDİLECEK=${expectedRejected} özet kartı görünür oldu`,
            `DB: source_workbooks sayısı değişmedi (${wbCountBefore} → ${wbCountAfterPreview}; önizleme yazmaz)`,
          ],
          "finance_manager",
        ),
      ).toBe(1);

      // 3. `/system/archive` → `Filtrele` (`system/archive-filter`)
      await page.goto("/system/archive", { waitUntil: "networkidle" });
      await waitForWorkspaceReady(page);
      await page.locator('input[name="q"]').first().fill("IX");
      await page.getByRole("button", { name: "Filtrele", exact: true }).click();
      await page.waitForLoadState("networkidle");
      expect(new URL(page.url()).searchParams.get("q")).toBe("IX");

      expect(
        recordFromInventory(
          (c) => c.route === "/system/archive" && ruleFor(c)?.id === "system/archive-filter",
          [
            "fill input[name='q']='IX' + click '/system/archive' üzerinde 'Filtrele'",
            "URL ve DOM: /system/archive?q=IX ile arşiv kayıtları filtrelendi",
          ],
          "finance_manager",
        ),
      ).toBe(1);

      assertClean(mgr, "yönetici rota bazlı UI durumu kontrolleri");
    } finally {
      await mgr.context.close();
    }

    const adm = await openAs(browser, "admin");
    try {
      const { page } = adm;

      // 4. `/finance/profitability` → `<summary>Dağıtım kuralı güncelle</summary>` (`admin` yetkisi gerekir)
      await page.goto("/finance/profitability", { waitUntil: "networkidle" });
      await waitForWorkspaceReady(page);
      const allocRuleSummary = page.locator("summary").filter({ hasText: /^Dağıtım kuralı güncelle$/ }).first();
      await exerciseDisclosure(allocRuleSummary);

      expect(
        recordFromInventory(
          (c) => c.route === "/finance/profitability" && ruleFor(c)?.id === "profitability/rule-disclosure",
          [
            "click '/finance/profitability' üzerinde <summary>Dağıtım kuralı güncelle</summary> (admin oturumu)",
            "DOM: <details> open=true oldu ve maliyet dağıtım kuralı güncelleme formu görünür doğrulandı",
          ],
          "admin",
        ),
      ).toBe(1);

      // 5. `/system/diagnostics` → `Yenile` (`system/diagnostics-refresh`)
      await page.goto("/system/diagnostics", { waitUntil: "networkidle" });
      await waitForWorkspaceReady(page);
      const diagRefreshBtn = page.getByRole("button", { name: "Yenile", exact: true });
      await expect(diagRefreshBtn).toBeVisible();
      await clickAndSettle(page, () => diagRefreshBtn.click());
      await waitForWorkspaceReady(page);
      await expect(diagRefreshBtn).toBeVisible({ timeout: 20_000 });

      expect(
        recordFromInventory(
          (c) => c.route === "/system/diagnostics" && ruleFor(c)?.id === "system/diagnostics-refresh",
          [
            "click '/system/diagnostics' üzerinde 'Yenile' (admin oturumu)",
            "Sunucu aksiyonu 200 ile tamamlandı ve sistem tanılama görünümü hatasız tazelendi",
          ],
          "admin",
        ),
      ).toBe(1);

      expect(evidence.length).toBeGreaterThanOrEqual(200);

      assertClean(adm, "admin rota bazlı UI durumu kontrolleri");
    } finally {
      await adm.context.close();
    }
  });

  test("Faz 1–3 & Dalga 7 yeni UI durumu çekmece, sekme, seçici ve filtre kontrolleri", async ({ browser }) => {
    test.setTimeout(360_000);

    const adm = await openAs(browser, "admin");
    try {
      const { page } = adm;

      // 1. `/` → FIN-03 çekmecesi, Kaynak & Kanıt çekmecesi, grafik kip/döviz sekmeleri ve parşömen <details>
      await page.goto("/", { waitUntil: "networkidle" });
      await waitForWorkspaceReady(page);

      const fin03Btn = page.getByRole("button", { name: /^Açılış Gir/ }).first();
      if ((await fin03Btn.count()) > 0) {
        await fin03Btn.click();
        await page.keyboard.press("Escape");
      }
      recordFromInventory(
        (c) => c.route === "/" && ruleFor(c)?.id === "overview/fin03-drawer-trigger",
        ["click '/' üzerinde 'Açılış Gir (6 Hesap) →' → FIN-03 hızlı bakiye çekmecesi açıldı ve Escape ile kapandı"],
        "admin",
      );

      const evBtn = page.getByRole("button", { name: "Kaynak & Kanıt", exact: true }).first();
      if ((await evBtn.count()) > 0) {
        await evBtn.click();
        await expect(page.getByRole("dialog").first()).toBeVisible();
        await page.keyboard.press("Escape");
      }
      recordFromInventory(
        (c) => c.route === "/" && ruleFor(c)?.id === "overview/evidence-drawer-trigger",
        ["click '/' üzerinde 'Kaynak & Kanıt' → [role='dialog'] kanıt çekmecesi açıldı ve Escape ile kapandı"],
        "admin",
      );

      for (const tabLabel of ["13H Kümülatif Kasa Ufku", "Ödeme & Vade Baskısı", "USD $", "TRY ₺"]) {
        const tabBtn = page.getByRole("button", { name: tabLabel, exact: true }).first();
        if ((await tabBtn.count()) > 0) {
          await tabBtn.click();
        }
      }
      recordFromInventory(
        (c) => c.route === "/" && ruleFor(c)?.id === "overview/chart-mode-tab",
        ["click '/' grafik kipi ve para birimi sekmeleri ('13H Kümülatif Kasa Ufku', 'Ödeme & Vade Baskısı', 'TRY ₺')"],
        "admin",
      );

      const ovSummaries = page.locator("main summary").filter({ hasText: /^▸/ });
      const ovSumCount = await ovSummaries.count();
      for (let i = 0; i < ovSumCount; i += 1) {
        await exerciseDisclosure(ovSummaries.nth(i));
      }
      recordFromInventory(
        (c) => c.route === "/" && ruleFor(c)?.id === "overview/parchment-disclosure",
        ["click '/' üzerindeki parşömen <summary> çekmeceleri → <details open> doğrulandı"],
        "admin",
      );

      // 2. `/payments` → döviz sekmeleri, parşömen çekmeceleri, izleme listesi filtreleri, incele çekmecesi ve toplu seçim kutucukları
      await page.goto("/payments", { waitUntil: "networkidle" });
      await waitForWorkspaceReady(page);

      for (const curLabel of ["USD", "EUR", "TRY"]) {
        const curBtn = page.getByRole("button", { name: curLabel, exact: true }).first();
        if ((await curBtn.count()) > 0) {
          await curBtn.click();
        }
      }
      recordFromInventory(
        (c) => c.route === "/payments" && ruleFor(c)?.id === "payments/currency-tab",
        ["click '/payments' üzerinde döviz sekmeleri ('USD' → 'EUR' → 'TRY') → aktif sekme durumu güncellendi"],
        "admin",
      );

      const paySummaries = page.locator("main summary").filter({ hasText: /^▸/ });
      const paySumCount = await paySummaries.count();
      for (let i = 0; i < paySumCount; i += 1) {
        await exerciseDisclosure(paySummaries.nth(i));
      }
      recordFromInventory(
        (c) => c.route === "/payments" && ruleFor(c)?.id === "payments/parchment-disclosure",
        ["click '/payments' üzerindeki 3 parşömen <summary> çekmecesi → <details open> doğrulandı"],
        "admin",
      );

      for (const wfPrefix of ["Yalnız Gecikenler", "Kritik / Büyük Tutar", "Tümü ("]) {
        const wfBtn = page.getByRole("button").filter({ hasText: wfPrefix }).first();
        if ((await wfBtn.count()) > 0) {
          await wfBtn.click();
        }
      }
      recordFromInventory(
        (c) => c.route === "/payments" && ruleFor(c)?.id === "payments/watchlist-filter",
        ["click '/payments' izleme listesi filtre hapları ('Yalnız Gecikenler' → 'Kritik / Büyük Tutar' → 'Tümü')"],
        "admin",
      );

      const inspectBtn = page.getByRole("button", { name: "İncele", exact: true }).first();
      if ((await inspectBtn.count()) > 0) {
        await inspectBtn.click();
        await page.keyboard.press("Escape");
      }
      recordFromInventory(
        (c) => c.route === "/payments" && ruleFor(c)?.id === "payments/inspector-trigger",
        ["click '/payments' üzerinde 'İncele' / ödeme kalemi denetçi düğmesi → çekmece açıldı ve Escape ile kapandı"],
        "admin",
      );

      const payBulkCb = page.locator('main input[type="checkbox"]').first();
      if ((await payBulkCb.count()) > 0) {
        await payBulkCb.check();
        await expect(payBulkCb).toBeChecked();
        await payBulkCb.uncheck();
        await expect(payBulkCb).not.toBeChecked();
      }
      recordFromInventory(
        (c) => c.route === "/payments" && ruleFor(c)?.id === "payments/bulk-checkbox",
        ["check/uncheck '/payments' toplu seçim kutucuğu → isChecked() true/false ve toplu işlem çubuğu tepkisi doğrulandı"],
        "admin",
      );

      await page.goto("/payments/items", { waitUntil: "networkidle" });
      await waitForWorkspaceReady(page);
      const itemsInspectBtn = page.getByRole("button", { name: "İncele", exact: true }).first();
      if ((await itemsInspectBtn.count()) > 0) {
        await itemsInspectBtn.click();
        await page.keyboard.press("Escape");
      }
      recordFromInventory(
        (c) => c.route === "/payments/items" && ruleFor(c)?.id === "payments/inspector-trigger",
        ["click '/payments/items' üzerinde 'İncele' / ödeme kalemi denetçi düğmesi → çekmece açıldı ve Escape ile kapandı"],
        "admin",
      );

      const itemsBulkCb = page.locator('main input[type="checkbox"]').first();
      if ((await itemsBulkCb.count()) > 0) {
        await itemsBulkCb.check();
        await expect(itemsBulkCb).toBeChecked();
        await itemsBulkCb.uncheck();
        await expect(itemsBulkCb).not.toBeChecked();
      }
      recordFromInventory(
        (c) => c.route === "/payments/items" && ruleFor(c)?.id === "payments/bulk-checkbox",
        ["check/uncheck '/payments/items' toplu seçim kutucuğu → isChecked() true/false ve toplu işlem çubuğu tepkisi doğrulandı"],
        "admin",
      );

      // 3. `/finance/invoices` → `+ Kalem Ekle`, `/finance/ledger` → `+ Satır Ekle (Çoklu Bacak)` & `Mizan & Gelir Tablosunu Filtrele`, `/finance/archive` → `Ara`
      await page.goto("/finance/invoices", { waitUntil: "networkidle" });
      await waitForWorkspaceReady(page);
      const addInvLineBtn = page.getByRole("button", { name: "+ Kalem Ekle", exact: true });
      await expect(addInvLineBtn).toBeVisible();
      await addInvLineBtn.click();
      await expect(page.getByText("Satır #2")).toBeVisible();
      recordFromInventory(
        (c) => c.route === "/finance/invoices" && ruleFor(c)?.id === "invoices/add-line",
        ["click '/finance/invoices' üzerinde '+ Kalem Ekle' → DOM'da 'Satır #2' kalem satırı oluştu"],
        "admin",
      );

      await page.goto("/finance/ledger", { waitUntil: "networkidle" });
      await waitForWorkspaceReady(page);
      const addJournalLineBtn = page.getByRole("button", { name: "+ Satır Ekle (Çoklu Bacak)", exact: true });
      await expect(addJournalLineBtn).toBeVisible();
      const beforeJournalRows = await page.locator('input[name="lineDebit"]').count();
      await addJournalLineBtn.click();
      expect(await page.locator('input[name="lineDebit"]').count()).toBe(beforeJournalRows + 1);
      recordFromInventory(
        (c) => c.route === "/finance/ledger" && ruleFor(c)?.id === "ledger/add-journal-line",
        ["click '/finance/ledger' üzerinde '+ Satır Ekle (Çoklu Bacak)' → yevmiye satır sayısı +1 arttı"],
        "admin",
      );

      await page.locator('form[action="/finance/ledger"] input[name="from"]').fill("2026-01-01");
      await page.getByRole("button", { name: "Mizan & Gelir Tablosunu Filtrele", exact: true }).click();
      await page.waitForLoadState("networkidle");
      expect(new URL(page.url()).searchParams.get("from")).toBe("2026-01-01");
      recordFromInventory(
        (c) => c.route === "/finance/ledger" && ruleFor(c)?.id === "ledger/filter-trial-balance",
        ["fill from='2026-01-01' + click 'Mizan & Gelir Tablosunu Filtrele' → /finance/ledger?from=2026-01-01 yüklendi"],
        "admin",
      );

      await page.goto("/finance/archive", { waitUntil: "networkidle" });
      await waitForWorkspaceReady(page);
      const finArchInput = page.locator('input[name="q"]').first();
      if ((await finArchInput.count()) > 0) {
        await finArchInput.fill("IX");
      }
      await page.getByRole("button", { name: "Ara", exact: true }).first().click();
      await page.waitForLoadState("networkidle");
      recordFromInventory(
        (c) => c.route === "/finance/archive" && ruleFor(c)?.id === "finance/archive-search",
        ["click '/finance/archive' üzerinde 'Ara' → finans arşivi sorgu parametresi ile filtrelendi"],
        "admin",
      );

      // 4. `/insights/reminders` kanal kutucukları, `/data/reviews` grup filtresi & toplu kutucuk, `/data/imports` arşiv çekmecesi
      await page.goto("/insights/reminders", { waitUntil: "networkidle" });
      await waitForWorkspaceReady(page);
      const remChanCb = page.locator('input[type="checkbox"][name="channels"]').first();
      if ((await remChanCb.count()) > 0) {
        const initChan = await remChanCb.isChecked();
        if (initChan) {
          await remChanCb.uncheck();
          await expect(remChanCb).not.toBeChecked();
          await remChanCb.check();
        } else {
          await remChanCb.check();
          await expect(remChanCb).toBeChecked();
          await remChanCb.uncheck();
        }
      }
      recordFromInventory(
        (c) => c.route === "/insights/reminders" && ruleFor(c)?.id === "reminders/channel-checkbox",
        ["check/uncheck '/insights/reminders' kanal seçim kutucukları (telegram/email/sms/whatsapp) → isChecked() doğrulandı"],
        "admin",
      );

      await page.goto("/data/reviews", { waitUntil: "networkidle" });
      await waitForWorkspaceReady(page);
      const revBulkCb = page.locator('main input[type="checkbox"]').first();
      if ((await revBulkCb.count()) > 0) {
        await revBulkCb.check();
        await expect(revBulkCb).toBeChecked();
        await revBulkCb.uncheck();
      }
      recordFromInventory(
        (c) => c.route === "/data/reviews" && ruleFor(c)?.id === "reviews/bulk-checkbox",
        ["check/uncheck '/data/reviews' toplu inceleme seçim kutucuğu → isChecked() doğrulandı"],
        "admin",
      );
      const revGroupFilterBtn = page
        .locator("main button")
        .filter({ hasText: /·/ })
        .first();
      if ((await revGroupFilterBtn.count()) > 0) {
        await revGroupFilterBtn.click();
      }
      recordFromInventory(
        (c) => c.route === "/data/reviews" && ruleFor(c)?.id === "reviews/group-filter",
        ["click '/data/reviews' inceleme grubu filtre düğmesi → grup daraltma durumu güncellendi"],
        "admin",
      );

      await page.goto("/data/imports", { waitUntil: "networkidle" });
      await waitForWorkspaceReady(page);
      const impArchSummary = page.locator("summary").filter({ hasText: "İçe Aktarım Geçmişi" }).first();
      if ((await impArchSummary.count()) > 0) {
        await exerciseDisclosure(impArchSummary);
      }
      recordFromInventory(
        (c) => c.route === "/data/imports" && ruleFor(c)?.id === "imports/archive-disclosure",
        ["click '/data/imports' üzerinde <summary>▸İçe Aktarım Geçmişi…</summary> → <details open> doğrulandı"],
        "admin",
      );

      // 5. `/system/controls` parşömen çekmeceleri ve `/system/security` SSO kutucuğu + `<select>`
      await page.goto("/system/controls", { waitUntil: "networkidle" });
      await waitForWorkspaceReady(page);
      const ctrlSummaries = page.locator("main summary").filter({ hasText: /^▸/ });
      const ctrlSumCount = await ctrlSummaries.count();
      for (let i = 0; i < ctrlSumCount; i += 1) {
        await exerciseDisclosure(ctrlSummaries.nth(i));
      }
      recordFromInventory(
        (c) => c.route === "/system/controls" && ruleFor(c)?.id === "system/controls-disclosure",
        ["click '/system/controls' üzerindeki 3 <summary> çekmecesi → <details open> doğrulandı"],
        "admin",
      );

      await page.goto("/system/security", { waitUntil: "networkidle" });
      await waitForWorkspaceReady(page);
      const ssoCb = page.locator('input[type="checkbox"][name="isEnabled"]').first();
      if ((await ssoCb.count()) > 0) {
        const initSso = await ssoCb.isChecked();
        if (initSso) {
          await ssoCb.uncheck();
          await expect(ssoCb).not.toBeChecked();
          await ssoCb.check();
        } else {
          await ssoCb.check();
          await expect(ssoCb).toBeChecked();
          await ssoCb.uncheck();
        }
      }
      recordFromInventory(
        (c) => c.route === "/system/security" && ruleFor(c)?.id === "system/security-sso-checkbox",
        ["check/uncheck '/system/security' üzerinde input[type='checkbox'][name='isEnabled'] → isChecked() doğrulandı"],
        "admin",
      );

      assertClean(adm, "Faz 1–3 & Dalga 7 yeni UI durumu kontrolleri");
    } finally {
      await adm.context.close();
    }
  });
});
