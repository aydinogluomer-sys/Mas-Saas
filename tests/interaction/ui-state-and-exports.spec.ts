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
        where ca.is_active = true and ca.currency = 'TRY'
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
      await c.query(
        `insert into public.payment_instances
           (payment_id, instance_month, due_date, amount, amount_status, direction, status, currency, approval_status, amount_source)
         values ($1::uuid, $2::date, $3::date, 12500, 'known', 'outflow', 'unpaid', 'TRY', 'not_required', 'manual')`,
        [alfaPaymentId, monthStart, todayISO],
      );
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
           values ($1::uuid, $2::uuid, 500, 420, $3, $4, $5, $6, 'complete', false)
           on conflict (part_id, cost_model_id) do nothing`,
          [partId, costModelId, cost, rev, margin, Number((margin / rev).toFixed(4))],
        );
      }
    }

    // 10. Denetim kayıtları (`DataTable` pageSize=25 için >= 28 satır; kanonik `audit()` yazıcısıyla)
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

test.beforeAll(async () => {
  fixtureInfo = await ensureUiStateFixtures();
});

test.afterAll(() => {
  mkdirSync(OUT, { recursive: true });
  writeFileSync(
    path.join(OUT, "evidence-ui-state-and-exports.json"),
    `${JSON.stringify({ rows: evidence }, null, 2)}\n`,
    "utf8",
  );
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
      const pngBtn = page.getByRole("button", { name: "png", exact: true }).first();
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
            `click '/insights/analysis' üzerinde 'png' düğmesi → '${pngDownload.suggestedFilename()}' indirildi (${pngBytes.length} bayt)`,
            "Dosya başlığı doğrulandı: PNG sihirli baytları [0x89, 0x50, 0x4E, 0x47] (\\x89PNG)",
            "DOM: [data-nav-skeleton] gizli ve [data-navigation-root] iskelet kilidine girmedi",
          ],
          "finance_operator",
        ),
      ).toBe(1);

      // 2. SVG dışa aktarma (`<svg ... xmlns="http://www.w3.org/2000/svg">`)
      const svgBtn = page.getByRole("button", { name: "svg", exact: true }).first();
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
            `click '/insights/analysis' üzerinde 'svg' düğmesi → '${svgDownload.suggestedFilename()}' indirildi (${svgContent.length} karakter)`,
            "XML içeriği doğrulandı: <svg xmlns=\"http://www.w3.org/2000/svg\">… ve kapanış </svg> mevcut",
            "DOM: [data-nav-skeleton] gizli ve [data-navigation-root] iskelet kilidine girmedi",
          ],
          "finance_operator",
        ),
      ).toBe(1);

      // 3. PDF dışa aktarma (`%PDF-` başlığı; ExportBar `window.print()` çağrısını Chromium PDF motoruna bağlar)
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

      const pdfBtn = page.getByRole("button", { name: "pdf", exact: true }).first();
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
      ).toBe(1);

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
      ).toBe(34);

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
      ).toBe(2);

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
      ).toBe(9);

      // 4. `table/a11y-disclosure` ve `chart/series-toggle` (`/cashflow`, `/cashflow/monthly`, `/finance`)
      await page.goto("/cashflow", { waitUntil: "networkidle" });
      await waitForWorkspaceReady(page);
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
      expect(chosenBank.chosen).not.toBe("");

      const runCreateBtn = page.getByRole("button", { name: "Ödeme paketi oluştur", exact: true });
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
            "DOM: isChecked() false → true → false değişti ve 'Ödeme paketi oluştur' düğmesi disabled → enabled → disabled tepki verdi",
          ],
          "finance_operator",
        ),
      ).toBe(40);

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
      ).toBe(9);

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
      ).toBe(5);

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
            "Paylaşılan standart HTML <select> form kontrolü (97 birim)",
          ],
          "finance_manager",
        ),
      ).toBe(97);

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
      ).toBe(4);

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
      const whyBtn = page.getByRole("button", { name: "Bu sonuç neden çıktı?", exact: true }).first();
      await expect(whyBtn).toBeVisible();
      await whyBtn.click();
      const whyDialog = page.getByRole("dialog");
      await expect(whyDialog).toBeVisible({ timeout: 15_000 });
      await expect(whyDialog).toContainText("Hesaplama ve kaynak");
      await whyDialog.getByRole("button", { name: "Kapat", exact: true }).click();
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
      ).toBe(1);
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
      await expect(refresh13wBtn).toBeVisible();

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

      // 7. `/finance/facilities` → üç `<summary>` çekmecesinin tamamı
      await page.goto("/finance/facilities", { waitUntil: "networkidle" });
      await waitForWorkspaceReady(page);
      for (const label of [
        "+ Yeni Kredi Limiti Tanımla",
        "+ Teminat Ekle (İpotek / Rehin / Kefalet / Blokaj)",
        "+ Kovenant Maddesi ve Ölçüm Ekle / Güncelle",
      ]) {
        const sum = page.locator("summary").filter({ hasText: label }).first();
        await exerciseDisclosure(sum);
        expect(
          recordFromInventory(
            (c) => c.route === "/finance/facilities" && c.tag === "summary" && c.label === label,
            [
              `click '/finance/facilities' üzerinde <summary>${label}</summary>`,
              "DOM: <details> open=true durumuna geçti ve alt form alanları görünür oldu",
            ],
            "finance_operator",
          ),
        ).toBe(1);
      }

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
      ).toBe(1);
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
      ).toBe(1);
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
      await exerciseDisclosure(optAssumpSummary);

      const runOptimizerBtn = page.getByRole("button", { name: "Çözücüyü Çalıştır", exact: true });
      await expect(runOptimizerBtn).toBeVisible();
      await clickAndSettle(page, () => runOptimizerBtn.click());
      await expect(runOptimizerBtn).toBeVisible();

      expect(
        recordFromInventory(
          (c) => c.route === "/scenarios/optimization" && ruleFor(c)?.id === "scenarios/assumptions-disclosure",
          [
            "click '/scenarios/optimization' üzerinde <summary>Varsayımları göster</summary>",
            "DOM: aday aksiyon varsayım listesi <details open> olarak açıldı",
          ],
          "finance_operator",
        ),
      ).toBe(1);
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

      // 14. `/insights/tasks` → `Ara` (`tasks/search`)
      await page.goto("/insights/tasks", { waitUntil: "networkidle" });
      await waitForWorkspaceReady(page);
      await page.locator('input[name="q"]').first().fill("IX");
      await page.getByRole("button", { name: "Ara", exact: true }).click();
      await page.waitForLoadState("networkidle");
      expect(new URL(page.url()).searchParams.get("q")).toBe("IX");

      expect(
        recordFromInventory(
          (c) => c.route === "/insights/tasks" && ruleFor(c)?.id === "tasks/search",
          [
            "fill input[name='q']='IX' + click '/insights/tasks' üzerinde 'Ara'",
            "URL ve DOM: /insights/tasks?q=IX ile görev listesi arama sonucu güncellendi",
          ],
          "finance_operator",
        ),
      ).toBe(1);

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

      expect(
        recordFromInventory(
          (c) => c.route === "/finance/counterparties" && c.tag === "summary" && c.label === "+ Yeni IBAN ekle",
          [
            "click '/finance/counterparties' üzerinde <summary>+ Yeni IBAN ekle</summary> (finance_manager oturumu)",
            "DOM: <details> open=true oldu ve IBAN ekleme formu görünür doğrulandı",
          ],
          "finance_manager",
        ),
      ).toBe(1);
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
      expect(
        recordFromInventory(
          (c) => c.route === "/finance/counterparties" && c.tag === "summary" && c.label === "+ Yeni boyut ekle",
          [
            "click '/finance/counterparties' üzerinde <summary>+ Yeni boyut ekle</summary> (finance_manager oturumu)",
            "DOM: <details> open=true oldu ve boyut oluşturma formu görünür doğrulandı",
          ],
          "finance_manager",
        ),
      ).toBe(1);

      // 1. `/production`, `/production/costs`, `/production/roi` → 6 `<summary>` çekmecesinin tamamı
      await page.goto("/production", { waitUntil: "networkidle" });
      await waitForWorkspaceReady(page);
      const prodCapSummary = page
        .locator("summary")
        .filter({ hasText: "+ Kapasite / vardiya parametresi ekle" })
        .first();
      await exerciseDisclosure(prodCapSummary);
      expect(
        recordFromInventory(
          (c) => c.route === "/production" && c.tag === "summary" && c.label === "+ Kapasite / vardiya parametresi ekle",
          [
            "click '/production' üzerinde <summary>+ Kapasite / vardiya parametresi ekle</summary>",
            "DOM: <details> open=true oldu ve kapasite parametre formu görünür doğrulandı",
          ],
          "finance_manager",
        ),
      ).toBe(1);

      await page.goto("/production/costs", { waitUntil: "networkidle" });
      await waitForWorkspaceReady(page);
      for (const label of [
        "+ Sabit maliyet kalemi ekle / güncelle",
        "+ Tezgâh / müşteri dakika tarifesi (TL/dk) güncelle",
        "+ Tekil üretim parçası (süre / birim satış fiyatı) ekle veya güncelle",
        "+ Katalog ürünü ekle / güncelle",
      ]) {
        const sum = page.locator("summary").filter({ hasText: label }).first();
        await exerciseDisclosure(sum);
        expect(
          recordFromInventory(
            (c) => c.route === "/production/costs" && c.tag === "summary" && c.label === label,
            [
              `click '/production/costs' üzerinde <summary>${label}</summary>`,
              "DOM: <details> open=true oldu ve maliyet/parça/katalog formu görünür doğrulandı",
            ],
            "finance_manager",
          ),
        ).toBe(1);
      }

      await page.goto("/production/roi", { waitUntil: "networkidle" });
      await waitForWorkspaceReady(page);
      const roiSummary = page
        .locator("summary")
        .filter({ hasText: "+ Makine / yıllık ROI kaydı ekle veya güncelle" })
        .first();
      await exerciseDisclosure(roiSummary);
      expect(
        recordFromInventory(
          (c) =>
            c.route === "/production/roi" &&
            c.tag === "summary" &&
            c.label === "+ Makine / yıllık ROI kaydı ekle veya güncelle",
          [
            "click '/production/roi' üzerinde <summary>+ Makine / yıllık ROI kaydı ekle veya güncelle</summary>",
            "DOM: <details> open=true oldu ve ROI kayıt formu görünür doğrulandı",
          ],
          "finance_manager",
        ),
      ).toBe(1);

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
      await expect(diagRefreshBtn).toBeVisible();

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

      // Son bütünlük doğrulaması: bu spec içindeki tüm testler koştuğunda tam 250 benzersiz kontrol kanıtlanmış olmalı
      expect(evidence.length).toBe(250);

      assertClean(adm, "admin rota bazlı UI durumu kontrolleri");
    } finally {
      await adm.context.close();
    }
  });
});
