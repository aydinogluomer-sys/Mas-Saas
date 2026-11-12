/**
 * ETKİLEŞİM KAPISI — Finans & Nakit Akışı (35 Mutasyon Kontrolü)
 *
 * `slice-mutations-finance.json` / `runtime-inventory.json` içindeki 17 rotaya yayılmış 35 finans
 * ve nakit akışı mutasyon kontrolünü GERÇEK Chromium tıklaması + bağımsız PostgreSQL (owner)
 * before/after doğrulaması + hardReload kalıcılık kontrolü ile uçtan uca kanıtlar.
 *
 * Çıktı: `docs/interaction-audit/evidence-mutations-finance.json` (`{ rows: Evidence[] }`).
 */

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Client } from "pg";
import { expect, test, type Locator, type Page } from "@playwright/test";
import {
  assertClean,
  db,
  hardReload,
  loadRuntimeInventory,
  openAs,
  scalar,
  signatureFromDom,
  type Evidence,
  type RoleSession,
  type SeededRole,
} from "./harness";
import { waitForWorkspaceReady } from "./workspace-ready";

const OUT_DIR = path.join(process.cwd(), "docs", "interaction-audit");
const OUT_FILE = path.join(OUT_DIR, "evidence-mutations-finance.json");
const evidence: Evidence[] = [];

test.describe.configure({ timeout: 120_000 });

test.afterAll(() => {
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(OUT_FILE, `${JSON.stringify({ rows: evidence }, null, 2)}\n`, "utf8");
});

/* ── Tarih, Dönem Kilidi & TR IBAN Yardımcıları ───────────────────────────────────────────── */

function istanbulTodayIso(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Istanbul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function addDaysIso(isoDate: string, days: number): string {
  const ms = Date.parse(`${isoDate}T00:00:00Z`) + days * 86_400_000;
  return new Date(ms).toISOString().slice(0, 10);
}

function addMonthsIso(isoDate: string, months: number): string {
  const [y, m, d] = isoDate.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1 + months, Math.min(d, 28)));
  return dt.toISOString().slice(0, 10);
}

let uidSeq = 1;
function uniqueSuffix(): string {
  const n = uidSeq++;
  return `${Date.now().toString(36).slice(-5)}${String(n).padStart(2, "0")}`.toUpperCase();
}

function mod97Digits(digits: string): number {
  let rem = 0;
  for (let i = 0; i < digits.length; i++) {
    rem = (rem * 10 + (digits.charCodeAt(i) - 48)) % 97;
  }
  return rem;
}

/**
 * ISO 7064 MOD-97-10 uyumlu, benzersiz 26 haneli geçerli TR IBAN üretir.
 * Üretilen IBAN bizzat kendi içinde mod-97 === 1 kontrolünden geçirilir.
 */
function generateValidTrIban(seedNumeric?: number): string {
  const numericSeed = seedNumeric ?? Date.now() * 100 + uidSeq++;
  const account16 = String(Math.abs(Math.trunc(numericSeed)) % 10_000_000_000_000_000).padStart(
    16,
    "0",
  );
  const bankCode5 = "00062";
  const reserve1 = "0";
  const bban = `${bankCode5}${reserve1}${account16}`; // 22 rakam
  // 'T' = 29, 'R' = 27, '00' yer tutucu
  const rem = mod97Digits(`${bban}292700`);
  const checkDigits = String(98 - rem).padStart(2, "0");
  const iban = `TR${checkDigits}${bban}`;
  if (iban.length !== 26 || mod97Digits(`${bban}2927${checkDigits}`) !== 1) {
    throw new Error(`Üretilen IBAN MOD-97 doğrulamasından geçemedi: ${iban}`);
  }
  return iban;
}

/**
 * `0100_hard_period_lock_enforcement.sql` içindeki `closed_period_lock_guard` trigger'ı kilitli
 * (`status = 'locked'`) aylara düşen fatura, çek, kredi taksiti, ödeme kalemi ve banka hareketi
 * yazımlarını reddeder. `enforce_cashflow_month_lock_transition` ise owner (`postgres`) bağlantısına
 * en az 10 karakterlik `reopen_reason` ile `'reviewed'` durumuna geçiş izni verir.
 */
async function unlockMonthsForDates(client: Client, dates: string[]): Promise<void> {
  for (const d of dates) {
    await client.query(
      `update public.cashflow_months
          set status = 'reviewed',
              reopen_reason = 'IX-FIXTURE finance mutations verification'
        where month_start = date_trunc('month', $1::date)::date
          and status = 'locked'`,
      [d],
    );
  }
}

/**
 * Envanterden tam `(route, label)` veya önek eşleşmesiyle kontrol imzasını çözer;
 * bulunamazsa canlı DOM üzerinden `signatureFromDom` ile üretir.
 */
async function resolveFinanceSignature(
  route: string,
  label: string,
  page: Page,
  options?: { prefixMatch?: boolean },
): Promise<string> {
  const inv = loadRuntimeInventory();
  const hit = inv.controls.find(
    (c) =>
      c.route === route &&
      (options?.prefixMatch ? c.label.startsWith(label) : c.label === label),
  );
  if (hit) return hit.signature;
  return signatureFromDom(page, label);
}

/** Kontrol kapalı bir `<details>` içindeyse önce `<summary>` üzerinden açar. */
async function openEnclosingDetailsIfClosed(target: Locator): Promise<void> {
  if ((await target.count()) === 0) {
    // Kapalı `<details>` içindeki düğmeler ARIA ağacından gizlendiği için (`getByRole` 0 döner)
    // sayfadaki kapalı `<details>` çekmecelerini `<summary>` tıklamasıyla açarız.
    const closedSummaries = target.page().locator("details:not([open]) > summary");
    const count = await closedSummaries.count();
    for (let i = 0; i < count; i += 1) {
      await closedSummaries.first().scrollIntoViewIfNeeded().catch(() => {});
      await closedSummaries.first().click();
    }
    return;
  }
  const details = target.locator("xpath=ancestor::details[1]");
  if ((await details.count()) === 0) return;
  const isOpen = await details.evaluate((el) => (el as HTMLDetailsElement).open);
  if (!isOpen) {
    const summary = details.locator("summary").first();
    await summary.scrollIntoViewIfNeeded();
    await summary.click();
    await expect
      .poll(async () => details.evaluate((el) => (el as HTMLDetailsElement).open), {
        timeout: 5_000,
      })
      .toBe(true);
  }
}

async function gotoReady(page: Page, route: string): Promise<void> {
  await page.goto(route, { waitUntil: "domcontentloaded" });
  await waitForWorkspaceReady(page);
}

interface VerifyMutationParams<TState> {
  id: string;
  session: RoleSession;
  route: string;
  role: SeededRole;
  signature: string;
  labelForProof: string;
  button: Locator;
  readState: () => Promise<TState>;
  isCommitted: (before: TState, current: TState) => boolean;
  describeState: (state: TState) => string;
  extraAfterAssert?: (before: TState, after: TState) => Promise<void>;
  extraProof?: string[];
}

/**
 * Ortak mutasyon doğrulama zinciri:
 * 1) Bağımsız PostgreSQL BEFORE okuması
 * 2) Gerçek UI tıklaması + POST & networkidle beklemesi + hata ekranı kontrolü
 * 3) Bağımsız PostgreSQL AFTER okuması (sınırlı poll)
 * 4) Sayfa `hardReload` + PostgreSQL kalıcılık okuması
 * 5) `assertClean` (sıfır console.error / pageerror / HTTP 5xx) + `evidence` kaydı
 */
async function executeAndVerifyMutation<TState>(params: VerifyMutationParams<TState>): Promise<void> {
  const {
    id,
    session,
    route,
    role,
    signature,
    labelForProof,
    button,
    readState,
    isCommitted,
    describeState,
    extraAfterAssert,
    extraProof = [],
  } = params;
  const { page } = session;

  await button.scrollIntoViewIfNeeded();
  await expect(button, `${id}: '${labelForProof}' düğmesi görünür olmalı`).toBeVisible({
    timeout: 20_000,
  });
  await expect(button, `${id}: '${labelForProof}' düğmesi etkin (enabled) olmalı`).toBeEnabled({
    timeout: 15_000,
  });

  const before = await readState();

  const postDone = page
    .waitForResponse((r) => r.request().method() === "POST", { timeout: 45_000 })
    .catch(() => null);
  await button.click();
  await postDone;
  await page.waitForLoadState("networkidle", { timeout: 45_000 }).catch(() => {});
  await waitForWorkspaceReady(page);

  const bodyAfterClick = await page.locator("body").innerText();
  expect(
    /Application error|Internal Server Error/i.test(bodyAfterClick),
    `${id}: aksiyon uygulama hata ekranı üretti (url=${page.url()})`,
  ).toBe(false);

  await expect
    .poll(
      async () => {
        const cur = await readState();
        return isCommitted(before, cur);
      },
      {
        message: `${id}: beklenen DB etkisi gerçekleşmedi (before=${describeState(before)}, url=${page.url()})`,
        timeout: 30_000,
        intervals: [250, 500, 1000, 1500, 2000],
      },
    )
    .toBe(true);

  const after = await readState();
  if (extraAfterAssert) {
    await extraAfterAssert(before, after);
  }

  await hardReload(page);
  await waitForWorkspaceReady(page);

  const bodyAfterReload = await page.locator("body").innerText();
  expect(
    /Application error|Internal Server Error/i.test(bodyAfterReload),
    `${id}: reload sonrası hata ekranı oluştu`,
  ).toBe(false);

  const afterReload = await readState();
  expect(
    isCommitted(before, afterReload),
    `${id}: reload sonrası DB etkisi korunmalı (before=${describeState(before)}, reload=${describeState(afterReload)})`,
  ).toBe(true);

  assertClean(session, id);

  evidence.push({
    route,
    control: signature,
    role,
    verdict: "PASS",
    proof: [
      `before DB: ${describeState(before)}`,
      `click: gerçek '${labelForProof}' düğmesi (${route})`,
      `after DB: ${describeState(after)}`,
      ...extraProof,
      `reload sonrası DB: ${describeState(afterReload)} — kalıcı`,
    ],
  });
}

/* ── Ortak Fixture Kurucular ──────────────────────────────────────────────────────────────── */

async function ensureActiveParty(
  partyType: "customer" | "vendor" | "bank" = "customer",
  prefix = "IX-FIN-PARTY",
): Promise<{ id: string; name: string }> {
  const suffix = uniqueSuffix();
  const name = `${prefix}-${partyType.toUpperCase()}-${suffix}`;
  const norm = name.toLowerCase();
  return db(async (c) => {
    const ins = await c.query<{ id: string }>(
      `insert into public.parties (name, normalized_name, party_type, is_active, approval_status)
       values ($1, $2, $3, true, 'approved')
       returning id::text as id`,
      [name, norm, partyType],
    );
    return { id: ins.rows[0].id, name };
  });
}

/* ═════════════════════════════════════════════════════════════════════════════════════════════
 * 35 FİNANS & NAKİT AKIŞI MUTASYON TESTİ
 * ═════════════════════════════════════════════════════════════════════════════════════════════ */

test("[01/35] /payments/items — Görünümü Kaydet (filter/save-view)", async ({ browser }) => {
  const route = "/payments/items";
  const role: SeededRole = "finance_operator";
  const viewName = `IX-PAY-VIEW-${uniqueSuffix()}`;

  const session = await openAs(browser, role);
  try {
    await gotoReady(session.page, route);
    const signature = await resolveFinanceSignature(route, "Görünümü Kaydet", session.page);

    const saveBtn = session.page.getByRole("button", { name: "Görünümü Kaydet", exact: true }).first();
    await openEnclosingDetailsIfClosed(saveBtn);

    const saveForm = session.page
      .locator("form")
      .filter({ has: session.page.getByRole("button", { name: "Görünümü Kaydet", exact: true }) })
      .first();
    await saveForm.locator('input[name="name"]').fill(viewName);

    await executeAndVerifyMutation({
      id: "payments-items-save-view",
      session,
      route,
      role,
      signature,
      labelForProof: "Görünümü Kaydet",
      button: saveForm.getByRole("button", { name: "Görünümü Kaydet", exact: true }),
      readState: async () =>
        Number(
          await scalar<string>(
            `select count(*)::int from public.saved_views where module_key = 'payments' and name = $1`,
            [viewName],
          ),
        ),
      isCommitted: (before, cur) => before === 0 && cur === 1,
      describeState: (n) => `saved_views[payments, "${viewName}"]=${n}`,
    });
  } finally {
    await session.context.close();
  }
});

test("[02/35] /payments/missing — iptal (payments/cancel)", async ({ browser }) => {
  const route = "/payments/missing";
  const role: SeededRole = "finance_operator";
  const today = istanbulTodayIso();
  const suffix = uniqueSuffix();

  const instanceId = await db(async (c) => {
    await unlockMonthsForDates(c, [today]);
    const payRes = await c.query<{ id: string }>(
      `insert into public.payments (name, recurrence_type, due_day, amount_confidence, direction, priority, status)
       values ($1, 'monthly', 12, 'unknown', 'outflow', 'normal', 'active')
       returning id::text as id`,
      [`IX-MISSING-CANCEL-${suffix}`],
    );
    const dueDate = `${today.slice(0, 7)}-12`;
    const monthStart = `${today.slice(0, 7)}-01`;
    const instRes = await c.query<{ id: string }>(
      `insert into public.payment_instances
         (payment_id, instance_month, due_date, amount, amount_status, direction, status, amount_source)
       values ($1::uuid, $2::date, $3::date, null, 'missing', 'outflow', 'unpaid', 'legacy_unknown')
       returning id::text as id`,
      [payRes.rows[0].id, monthStart, dueDate],
    );
    return instRes.rows[0].id;
  });

  const session = await openAs(browser, role);
  try {
    await gotoReady(session.page, route);
    const signature = await resolveFinanceSignature(route, "iptal", session.page);

    const cancelForm = session.page
      .locator("form")
      .filter({
        has: session.page.locator(`input[name="id"][value="${instanceId}"]`),
        hasText: "iptal",
      })
      .filter({ has: session.page.getByRole("button", { name: "iptal", exact: true }) })
      .first();

    const reasonInput = cancelForm.locator('input[name="reason"]');
    if ((await reasonInput.count()) > 0) {
      await reasonInput.fill(`IX eksik ödeme iptal ${suffix}`);
    }

    await executeAndVerifyMutation({
      id: "payments-missing-cancel",
      session,
      route,
      role,
      signature,
      labelForProof: "iptal",
      button: cancelForm.getByRole("button", { name: "iptal", exact: true }),
      readState: async () =>
        await scalar<string>(`select status from public.payment_instances where id = $1::uuid`, [
          instanceId,
        ]),
      isCommitted: (before, cur) => before === "unpaid" && cur === "cancelled",
      describeState: (st) => `payment_instances[${instanceId}].status=${st ?? "null"}`,
    });
  } finally {
    await session.context.close();
  }
});

test("[03/35] /finance/bank — Kaydet (bank/save-account)", async ({ browser }) => {
  const route = "/finance/bank";
  const role: SeededRole = "finance_manager";
  const today = istanbulTodayIso();
  const suffix = uniqueSuffix();
  const targetOpening = "3456.78";

  const cashAccountId = await db(async (c) => {
    await unlockMonthsForDates(c, [today]);
    const ins = await c.query<{ id: string }>(
      `insert into public.cash_accounts (name, account_type, currency, opening_balance, opening_balance_date, is_active)
       values ($1, 'cash', 'TRY', 1200.00, $2::date, true)
       returning id::text as id`,
      [`IX Banka Kasa ${suffix}`, today],
    );
    return ins.rows[0].id;
  });

  const session = await openAs(browser, role);
  try {
    await gotoReady(session.page, route);
    const signature = await resolveFinanceSignature(route, "Kaydet", session.page);

    const editForm = session.page
      .locator("form")
      .filter({
        has: session.page.locator(`input[name="cashAccountId"][value="${cashAccountId}"]`),
      })
      .filter({ has: session.page.getByRole("button", { name: "Kaydet", exact: true }) })
      .first();

    await editForm.locator('input[name="openingBalance"]').fill(targetOpening);
    await editForm.locator('input[name="openingBalanceDate"]').fill(today);

    await executeAndVerifyMutation({
      id: "finance-bank-save-account",
      session,
      route,
      role,
      signature,
      labelForProof: "Kaydet",
      button: editForm.getByRole("button", { name: "Kaydet", exact: true }),
      readState: async () =>
        await scalar<string>(
          `select (opening_balance::numeric(14,2))::text || '|' || (opening_journal_entry_id is not null)::text
             from public.cash_accounts
            where id = $1::uuid`,
          [cashAccountId],
        ),
      isCommitted: (_before, cur) => cur === `${targetOpening}|true`,
      describeState: (s) => `cash_accounts[${cashAccountId}]=${s ?? "null"}`,
      extraProof: ["500.99 açılış fişi (opening_journal_entry_id) oluşturuldu"],
    });
  } finally {
    await session.context.close();
  }
});

test("[04/35] /finance/bank — İçe aktar (bank/import)", async ({ browser }) => {
  const route = "/finance/bank";
  const role: SeededRole = "finance_manager";
  const today = istanbulTodayIso();
  const suffix = uniqueSuffix();
  const validIban = generateValidTrIban();
  const refNo = `IX-CSV-REF-${suffix}`;

  const bankAccountId = await db(async (c) => {
    await unlockMonthsForDates(c, [today]);
    const ca = await c.query<{ id: string }>(
      `insert into public.cash_accounts (name, account_type, currency, opening_balance, opening_balance_date, is_active)
       values ($1, 'bank_account', 'TRY', 50000.00, $2::date, true)
       returning id::text as id`,
      [`IX Ekstre Banka ${suffix}`, today],
    );
    const id = ca.rows[0].id;
    await c.query(
      `insert into public.bank_accounts (cash_account_id, iban, bank_name, branch_code)
       values ($1::uuid, $2, 'IX Garanti BBVA', '0412')`,
      [id, validIban],
    );
    return id;
  });

  const csvContent = [
    "Tarih,Açıklama,Tutar,Referans",
    `${today},IX Ekstre Tahsilat ${suffix},14250.50,${refNo}`,
  ].join("\n");

  const session = await openAs(browser, role);
  try {
    await gotoReady(session.page, route);
    const signature = await resolveFinanceSignature(route, "İçe aktar", session.page);

    const importForm = session.page
      .locator("form")
      .filter({ has: session.page.getByRole("button", { name: "İçe aktar", exact: true }) })
      .first();

    await importForm.locator('select[name="bankAccountId"]').selectOption(bankAccountId);
    await importForm.locator('input[type="file"][name="statement"]').setInputFiles({
      name: `ix-statement-${suffix}.csv`,
      mimeType: "text/csv",
      buffer: Buffer.from(csvContent, "utf8"),
    });

    await executeAndVerifyMutation({
      id: "finance-bank-import",
      session,
      route,
      role,
      signature,
      labelForProof: "İçe aktar",
      button: importForm.getByRole("button", { name: "İçe aktar", exact: true }),
      readState: async () =>
        Number(
          await scalar<string>(
            `select count(*)::int from public.bank_transactions where bank_account_id = $1::uuid and reference_no = $2`,
            [bankAccountId, refNo],
          ),
        ),
      isCommitted: (before, cur) => before === 0 && cur === 1,
      describeState: (n) => `bank_transactions[ref=${refNo}]=${n}`,
    });
  } finally {
    await session.context.close();
  }
});

test("[05/35] /finance/bank — Eşleştiriciyi çalıştır (±90 gün) (bank/match)", async ({ browser }) => {
  const route = "/finance/bank";
  const role: SeededRole = "finance_manager";
  const today = istanbulTodayIso();
  const suffix = uniqueSuffix();
  const validIban = generateValidTrIban();
  const matchAmount = 19480.25;

  const { bankTxId, invoiceId } = await db(async (c) => {
    await unlockMonthsForDates(c, [today]);
    const partyRes = await c.query<{ id: string }>(
      `insert into public.parties (name, normalized_name, party_type, is_active, approval_status)
       values ($1, $2, 'customer', true, 'approved')
       returning id::text as id`,
      [`IX Match Musteri ${suffix}`, `ix match musteri ${suffix.toLowerCase()}`],
    );
    const partyId = partyRes.rows[0].id;
    const invoiceNo = `IX-MATCH-INV-${suffix}`;
    const invRes = await c.query<{ id: string }>(
      `insert into public.invoices
         (direction, invoice_no, party_id, issue_date, due_date, currency,
          net_amount, tax_amount, gross_amount, payable_amount, paid_amount, allocated_amount, status, approval_status)
       values ('sales', $1, $2::uuid, $3::date, $3::date, 'TRY',
               16233.54, 3246.71, $4::numeric, $4::numeric, 0, 0, 'open', 'not_required')
       returning id::text as id`,
      [invoiceNo, partyId, today, matchAmount],
    );
    const caRes = await c.query<{ id: string }>(
      `insert into public.cash_accounts (name, account_type, currency, opening_balance, opening_balance_date, is_active)
       values ($1, 'bank_account', 'TRY', 25000.00, $2::date, true)
       returning id::text as id`,
      [`IX Match Banka ${suffix}`, today],
    );
    const bankAccId = caRes.rows[0].id;
    await c.query(
      `insert into public.bank_accounts (cash_account_id, iban, bank_name)
       values ($1::uuid, $2, 'IX Akbank')`,
      [bankAccId, validIban],
    );
    const txRes = await c.query<{ id: string }>(
      `insert into public.bank_transactions
         (bank_account_id, txn_date, description, counterparty_name_raw, amount, currency, status, dedupe_hash)
       values ($1::uuid, $2::date, $3, $4, $5::numeric, 'TRY', 'unmatched', $6)
       returning id::text as id`,
      [
        bankAccId,
        today,
        `Fatura tahsilatı ${invoiceNo} IX Match Musteri ${suffix}`,
        `IX Match Musteri ${suffix}`,
        matchAmount,
        `ix-match-dedupe-${suffix}`,
      ],
    );
    return { bankTxId: txRes.rows[0].id, invoiceId: invRes.rows[0].id };
  });

  const session = await openAs(browser, role);
  try {
    await gotoReady(session.page, route);
    const signature = await resolveFinanceSignature(
      route,
      "Eşleştiriciyi çalıştır (±90 gün)",
      session.page,
    );

    const matchBtn = session.page
      .getByRole("button", { name: "Eşleştiriciyi çalıştır (±90 gün)", exact: true })
      .first();

    await executeAndVerifyMutation({
      id: "finance-bank-matcher",
      session,
      route,
      role,
      signature,
      labelForProof: "Eşleştiriciyi çalıştır (±90 gün)",
      button: matchBtn,
      readState: async () => {
        const status = await scalar<string>(
          `select status from public.bank_transactions where id = $1::uuid`,
          [bankTxId],
        );
        const candCount = Number(
          await scalar<string>(
            `select count(*)::int from public.bank_transaction_match_candidates
              where bank_transaction_id = $1::uuid and target_table = 'invoices' and target_id = $2::uuid`,
            [bankTxId, invoiceId],
          ),
        );
        return `${status ?? "null"}|cands=${candCount}`;
      },
      isCommitted: (before, cur) =>
        before.startsWith("unmatched|") && cur.startsWith("suggested|") && !cur.endsWith("=0"),
      describeState: (s) => `bank_tx[${bankTxId}]=${s}`,
    });
  } finally {
    await session.context.close();
  }
});

test("[06/35] /finance/bank — Profili kaydet (bank/save-profile)", async ({ browser }) => {
  const route = "/finance/bank";
  const role: SeededRole = "finance_manager";
  const today = istanbulTodayIso();
  const suffix = uniqueSuffix();
  const validIban = generateValidTrIban();

  const cashAccountId = await db(async (c) => {
    await unlockMonthsForDates(c, [today]);
    const ins = await c.query<{ id: string }>(
      `insert into public.cash_accounts (name, account_type, currency, opening_balance, opening_balance_date, is_active)
       values ($1, 'bank_account', 'TRY', 10000.00, $2::date, true)
       returning id::text as id`,
      [`IX Profil Hesabi ${suffix}`, today],
    );
    return ins.rows[0].id;
  });

  const session = await openAs(browser, role);
  try {
    await gotoReady(session.page, route);
    const signature = await resolveFinanceSignature(route, "Profili kaydet", session.page);

    const profileForm = session.page
      .locator("form")
      .filter({ has: session.page.getByRole("button", { name: "Profili kaydet", exact: true }) })
      .first();

    await profileForm.locator('select[name="cashAccountId"]').selectOption(cashAccountId);
    await profileForm.locator('input[name="iban"]').fill(validIban);
    await profileForm.locator('input[name="bankName"]').fill("IX Yapı Kredi");
    await profileForm.locator('input[name="branchCode"]').fill("0854");
    await profileForm.locator('input[name="overdraftLimit"]').fill("15000");

    await executeAndVerifyMutation({
      id: "finance-bank-save-profile",
      session,
      route,
      role,
      signature,
      labelForProof: "Profili kaydet",
      button: profileForm.getByRole("button", { name: "Profili kaydet", exact: true }),
      readState: async () =>
        await scalar<string>(
          `select iban_normalized from public.bank_accounts where cash_account_id = $1::uuid`,
          [cashAccountId],
        ),
      isCommitted: (before, cur) => before === null && cur === validIban,
      describeState: (s) => `bank_accounts[${cashAccountId}].iban_normalized=${s ?? "null"}`,
    });
  } finally {
    await session.context.close();
  }
});

test("[07/35] /finance/checks — Arşivle (payments/archive)", async ({ browser }) => {
  const route = "/finance/checks";
  const role: SeededRole = "finance_manager";
  const earlyMaturity = "2020-02-15";
  const suffix = uniqueSuffix();
  const serialNo = `IX-ARCH-CHK-${suffix}`;

  const checkId = await db(async (c) => {
    await unlockMonthsForDates(c, [earlyMaturity, istanbulTodayIso()]);
    const ins = await c.query<{ id: string }>(
      `insert into public.checks
         (direction, instrument_type, amount, signed_amount, currency, maturity_date, status, serial_no, counterparty_label)
       values ('inflow', 'check', 8400.00, 8400.00, 'TRY', $1::date, 'planned', $2, 'IX Arşiv Çek Müşterisi')
       returning id::text as id`,
      [earlyMaturity, serialNo],
    );
    return ins.rows[0].id;
  });

  const session = await openAs(browser, role);
  try {
    await gotoReady(session.page, route);
    const signature = await resolveFinanceSignature(route, "Arşivle", session.page);

    const searchBox = session.page.getByPlaceholder(
      "Çek/senet ara (karşı taraf, banka, seri, bordro…)",
    );
    if ((await searchBox.count()) > 0) {
      await searchBox.fill(serialNo);
    }

    const archiveForm = session.page
      .locator("form")
      .filter({
        has: session.page.locator(`input[name="id"][value="${checkId}"]`),
      })
      .filter({ has: session.page.getByRole("button", { name: "Arşivle", exact: true }) })
      .first();

    await executeAndVerifyMutation({
      id: "finance-checks-archive",
      session,
      route,
      role,
      signature,
      labelForProof: "Arşivle",
      button: archiveForm.getByRole("button", { name: "Arşivle", exact: true }),
      readState: async () =>
        await scalar<string>(
          `select (archived_at is not null)::text from public.checks where id = $1::uuid`,
          [checkId],
        ),
      isCommitted: (before, cur) => before === "false" && cur === "true",
      describeState: (s) => `checks[${checkId}].is_archived=${s ?? "null"}`,
    });
  } finally {
    await session.context.close();
  }
});

test("[08/35] /finance/checks — Bordroyu uygula (checks/bordro-execute)", async ({ browser }) => {
  const route = "/finance/checks";
  const role: SeededRole = "finance_operator";
  const today = istanbulTodayIso();
  const earlyMaturity = "2020-02-18";
  const suffix = uniqueSuffix();
  const serialNo = `IX-BORDRO-CHK-${suffix}`;

  const checkId = await db(async (c) => {
    await unlockMonthsForDates(c, [today, earlyMaturity]);
    const ins = await c.query<{ id: string }>(
      `insert into public.checks
         (direction, instrument_type, amount, signed_amount, currency, maturity_date, status, serial_no, counterparty_label)
       values ('inflow', 'check', 11250.00, 11250.00, 'TRY', $1::date, 'in_portfolio', $2, 'IX Bordro Müşteri')
       returning id::text as id`,
      [earlyMaturity, serialNo],
    );
    return ins.rows[0].id;
  });

  const session = await openAs(browser, role);
  try {
    await gotoReady(session.page, route);
    const signature = await resolveFinanceSignature(route, "Bordroyu uygula", session.page);

    const bordroForm = session.page
      .locator("form")
      .filter({ has: session.page.getByRole("button", { name: "Bordroyu uygula", exact: true }) })
      .first();

    await bordroForm.locator('select[name="operation"]').selectOption("mark_cleared");
    await bordroForm.locator('input[name="bordroDate"]').fill(today);
    await bordroForm.locator('input[name="notes"]').fill(`IX Bordro Tahsil ${suffix}`);

    const checkBox = bordroForm.locator(
      `input[type="checkbox"][name="checkIds"][value="${checkId}"]`,
    );
    await checkBox.scrollIntoViewIfNeeded();
    await checkBox.check();

    await executeAndVerifyMutation({
      id: "finance-checks-bordro-execute",
      session,
      route,
      role,
      signature,
      labelForProof: "Bordroyu uygula",
      button: bordroForm.getByRole("button", { name: "Bordroyu uygula", exact: true }),
      readState: async () =>
        await scalar<string>(
          `select status || '|bordro=' || (last_bordro_id is not null)::text
             from public.checks
            where id = $1::uuid`,
          [checkId],
        ),
      isCommitted: (before, cur) =>
        before === "in_portfolio|bordro=false" && cur === "cleared|bordro=true",
      describeState: (s) => `checks[${checkId}]=${s ?? "null"}`,
      extraProof: ["check_bordros satırı oluşturuldu ve checks.last_bordro_id bağlandı"],
    });
  } finally {
    await session.context.close();
  }
});

test("[09/35] /finance/checks/new — Çeki kaydet (checks/create)", async ({ browser }) => {
  const route = "/finance/checks/new";
  const role: SeededRole = "finance_operator";
  const today = istanbulTodayIso();
  const maturityDate = addDaysIso(today, 20);
  const suffix = uniqueSuffix();
  const serialNo = `IX-NEW-CHK-${suffix}`;

  await db(async (c) => {
    await unlockMonthsForDates(c, [today, maturityDate]);
  });

  const session = await openAs(browser, role);
  try {
    await gotoReady(session.page, route);
    const signature = await resolveFinanceSignature(route, "Çeki kaydet", session.page);

    const form = session.page
      .locator("form")
      .filter({ has: session.page.getByRole("button", { name: "Çeki kaydet", exact: true }) })
      .first();

    await form.locator('select[name="instrumentType"]').selectOption("check");
    await form.locator('select[name="direction"]').selectOption("inflow");
    await form.locator('input[name="maturityDate"]').fill(maturityDate);
    await form.locator('input[name="amount"]').fill("16800.50");
    await form.locator('select[name="currency"]').selectOption("TRY");
    await form.locator('input[name="serial"]').fill(serialNo);
    await form.locator('input[name="counterparty"]').fill(`IX Yeni Çek Cari ${suffix}`);

    await executeAndVerifyMutation({
      id: "finance-checks-new-create",
      session,
      route,
      role,
      signature,
      labelForProof: "Çeki kaydet",
      button: form.getByRole("button", { name: "Çeki kaydet", exact: true }),
      readState: async () =>
        Number(
          await scalar<string>(`select count(*)::int from public.checks where serial_no = $1`, [
            serialNo,
          ]),
        ),
      isCommitted: (before, cur) => before === 0 && cur === 1,
      describeState: (n) => `checks[serial_no=${serialNo}]=${n}`,
    });
  } finally {
    await session.context.close();
  }
});

test("[10/35] /finance/loans/new — Krediyi ve planı oluştur (loans/create)", async ({ browser }) => {
  const route = "/finance/loans/new";
  const role: SeededRole = "finance_operator";
  const today = istanbulTodayIso();
  const suffix = uniqueSuffix();
  const loanName = `IX-LOAN-${suffix}`;

  await db(async (c) => {
    await unlockMonthsForDates(c, [
      today,
      addMonthsIso(today, 1),
      addMonthsIso(today, 2),
      addMonthsIso(today, 3),
    ]);
  });

  const session = await openAs(browser, role);
  try {
    await gotoReady(session.page, route);
    const signature = await resolveFinanceSignature(
      route,
      "Krediyi ve planı oluştur",
      session.page,
    );

    const form = session.page
      .locator("form")
      .filter({
        has: session.page.getByRole("button", { name: "Krediyi ve planı oluştur", exact: true }),
      })
      .first();

    await form.locator('input[name="name"]').fill(loanName);
    await form.locator('input[name="principal"]').fill("90000");
    await form.locator('input[name="installmentCount"]').fill("3");
    await form.locator('input[name="installmentAmount"]').fill("31500");
    await form.locator('input[name="firstPaymentDate"]').fill(today);

    await executeAndVerifyMutation({
      id: "finance-loans-new-create",
      session,
      route,
      role,
      signature,
      labelForProof: "Krediyi ve planı oluştur",
      button: form.getByRole("button", { name: "Krediyi ve planı oluştur", exact: true }),
      readState: async () => {
        const loansCount = Number(
          await scalar<string>(`select count(*)::int from public.loans where name = $1`, [
            loanName,
          ]),
        );
        const instCount = Number(
          await scalar<string>(
            `select count(*)::int
               from public.loan_installments li
               join public.loans l on l.id = li.loan_id
              where l.name = $1`,
            [loanName],
          ),
        );
        return `${loansCount}|${instCount}`;
      },
      isCommitted: (before, cur) => before === "0|0" && cur === "1|3",
      describeState: (s) => `loans|installments[${loanName}]=${s}`,
    });
  } finally {
    await session.context.close();
  }
});

test("[11/35] /finance/collections — Ödeme paketi oluştur (collections/payment-run-create)", async ({
  browser,
}) => {
  const route = "/finance/collections";
  const role: SeededRole = "finance_operator";
  const today = istanbulTodayIso();
  const earlyDueDate = "2020-01-15";
  const suffix = uniqueSuffix();
  const sourceIban = generateValidTrIban();
  const vendorIban = generateValidTrIban();
  const runNotes = `IX-PAYRUN-${suffix}`;

  const { sourceBankId, invoiceId } = await db(async (c) => {
    await unlockMonthsForDates(c, [today, earlyDueDate, "2020-01-10"]);

    const caRes = await c.query<{ id: string }>(
      `insert into public.cash_accounts (name, account_type, currency, opening_balance, opening_balance_date, is_active)
       values ($1, 'bank_account', 'TRY', 500000.00, $2::date, true)
       returning id::text as id`,
      [`IX Kaynak Banka ${suffix}`, today],
    );
    const srcId = caRes.rows[0].id;
    await c.query(
      `insert into public.bank_accounts (cash_account_id, iban, bank_name, branch_code)
       values ($1::uuid, $2, 'IX İş Bankası', '1042')`,
      [srcId, sourceIban],
    );

    const vendorRes = await c.query<{ id: string }>(
      `insert into public.parties (name, normalized_name, party_type, is_active, approval_status)
       values ($1, $2, 'vendor', true, 'approved')
       returning id::text as id`,
      [`IX Tedarikçi ${suffix}`, `ix tedarikci ${suffix.toLowerCase()}`],
    );
    const vendorId = vendorRes.rows[0].id;

    await c.query(
      `insert into public.ibans
         (party_id, iban, bank_name, currency, is_primary, is_active, approval_status)
       values ($1::uuid, $2, 'IX Halkbank', 'TRY', true, true, 'approved')`,
      [vendorId, vendorIban],
    );

    const invRes = await c.query<{ id: string }>(
      `insert into public.invoices
         (direction, invoice_no, party_id, issue_date, due_date, currency,
          net_amount, tax_amount, gross_amount, payable_amount, paid_amount, allocated_amount, status, approval_status)
       values ('purchase', $1, $2::uuid, '2020-01-10'::date, $3::date, 'TRY',
               4000.00, 800.00, 4800.00, 4800.00, 0, 0, 'open', 'not_required')
       returning id::text as id`,
      [`IX-PRUN-INV-${suffix}`, vendorId, earlyDueDate],
    );

    return { sourceBankId: srcId, invoiceId: invRes.rows[0].id };
  });

  const session = await openAs(browser, role);
  try {
    await gotoReady(session.page, route);
    const signature = await resolveFinanceSignature(
      route,
      "Ödeme paketi oluştur",
      session.page,
    );

    const runForm = session.page
      .locator("form")
      .filter({ has: session.page.getByRole("button", { name: "Ödeme paketi oluştur", exact: true }) })
      .first();

    await runForm.locator('select[name="sourceBankAccountId"]').selectOption(sourceBankId);
    await runForm.locator('input[name="plannedExecutionDate"]').fill(today);
    await runForm.locator('input[name="notes"]').fill(runNotes);

    const targetCheckbox = runForm.locator(
      `input[type="checkbox"][name="selectedTargets"][value="invoice:${invoiceId}"]`,
    );
    await targetCheckbox.scrollIntoViewIfNeeded();
    await expect(targetCheckbox).toBeEnabled();
    await targetCheckbox.check();

    await executeAndVerifyMutation({
      id: "finance-collections-payment-run-create",
      session,
      route,
      role,
      signature,
      labelForProof: "Ödeme paketi oluştur",
      button: runForm.getByRole("button", { name: "Ödeme paketi oluştur", exact: true }),
      readState: async () =>
        Number(
          await scalar<string>(
            `select count(*)::int
               from public.payment_run_items pri
               join public.payment_runs pr on pr.id = pri.run_id
              where pri.target_type = 'invoice'
                and pri.target_id = $1::uuid
                and pr.notes = $2`,
            [invoiceId, runNotes],
          ),
        ),
      isCommitted: (before, cur) => before === 0 && cur === 1,
      describeState: (n) => `payment_run_items[invoice=${invoiceId}, notes=${runNotes}]=${n}`,
    });
  } finally {
    await session.context.close();
  }
});

test("[12/35] /finance/fx — Kuru kaydet (fx/save)", async ({ browser }) => {
  const route = "/finance/fx";
  const role: SeededRole = "finance_operator";

  // `fx_rate_snapshots` append-only bir tablodur (UPDATE/DELETE trigger ile kapalıdır).
  // Çakışmasız `(base_currency, quote_currency='TRY', rate_date, source='other')` yuvası bul.
  const unusedSlot = await db(async (c) => {
    const currencies = ["CHF", "CAD", "SEK", "NOK", "DKK", "AUD"];
    for (const cur of currencies) {
      for (let dayOffset = 400; dayOffset < 900; dayOffset++) {
        const candidateDate = addDaysIso("2023-01-01", dayOffset);
        const exists = await c.query(
          `select 1 from public.fx_rate_snapshots
            where base_currency = $1 and quote_currency = 'TRY' and rate_date = $2::date and source = 'other'
            limit 1`,
          [cur, candidateDate],
        );
        if (exists.rowCount === 0) {
          return { baseCurrency: cur, rateDate: candidateDate };
        }
      }
    }
    throw new Error("fx_rate_snapshots için boş test tarihi bulunamadı");
  });

  const session = await openAs(browser, role);
  try {
    await gotoReady(session.page, route);
    const signature = await resolveFinanceSignature(route, "Kuru kaydet", session.page);

    const fxForm = session.page
      .locator("form")
      .filter({ has: session.page.getByRole("button", { name: "Kuru kaydet", exact: true }) })
      .first();

    await fxForm.locator('input[name="baseCurrency"]').fill(unusedSlot.baseCurrency);
    await fxForm.locator('input[name="rateDate"]').fill(unusedSlot.rateDate);
    await fxForm.locator('input[name="rate"]').fill("39.4567");
    await fxForm.locator('select[name="source"]').selectOption("other");

    await executeAndVerifyMutation({
      id: "finance-fx-save",
      session,
      route,
      role,
      signature,
      labelForProof: "Kuru kaydet",
      button: fxForm.getByRole("button", { name: "Kuru kaydet", exact: true }),
      readState: async () =>
        Number(
          await scalar<string>(
            `select count(*)::int from public.fx_rate_snapshots
              where base_currency = $1 and quote_currency = 'TRY' and rate_date = $2::date and source = 'other'`,
            [unusedSlot.baseCurrency, unusedSlot.rateDate],
          ),
        ),
      isCommitted: (before, cur) => before === 0 && cur === 1,
      describeState: (n) =>
        `fx_rate_snapshots[${unusedSlot.baseCurrency}/TRY @ ${unusedSlot.rateDate}]=${n}`,
    });
  } finally {
    await session.context.close();
  }
});

test("[13/35] /finance/invoices — Görünümü Kaydet (filter/save-view)", async ({ browser }) => {
  const route = "/finance/invoices";
  const role: SeededRole = "finance_operator";
  const viewName = `IX-INV-VIEW-${uniqueSuffix()}`;

  const session = await openAs(browser, role);
  try {
    await gotoReady(session.page, route);
    const signature = await resolveFinanceSignature(route, "Görünümü Kaydet", session.page);

    const saveBtn = session.page.getByRole("button", { name: "Görünümü Kaydet", exact: true }).first();
    await openEnclosingDetailsIfClosed(saveBtn);

    const saveForm = session.page
      .locator("form")
      .filter({ has: session.page.getByRole("button", { name: "Görünümü Kaydet", exact: true }) })
      .first();
    await saveForm.locator('input[name="name"]').fill(viewName);

    await executeAndVerifyMutation({
      id: "finance-invoices-save-view",
      session,
      route,
      role,
      signature,
      labelForProof: "Görünümü Kaydet",
      button: saveForm.getByRole("button", { name: "Görünümü Kaydet", exact: true }),
      readState: async () =>
        Number(
          await scalar<string>(
            `select count(*)::int from public.saved_views where module_key = 'invoices' and name = $1`,
            [viewName],
          ),
        ),
      isCommitted: (before, cur) => before === 0 && cur === 1,
      describeState: (n) => `saved_views[invoices, "${viewName}"]=${n}`,
    });
  } finally {
    await session.context.close();
  }
});

test("[14/35] /finance/invoices — Taslak oluştur (invoices/draft)", async ({ browser }) => {
  const route = "/finance/invoices";
  const role: SeededRole = "finance_operator";
  const today = istanbulTodayIso();
  const dueDate = addDaysIso(today, 15);
  const suffix = uniqueSuffix();
  const invoiceNo = `IX-DRAFT-INV-${suffix}`;

  const party = await ensureActiveParty("customer", "IX-INV-CUST");
  await db(async (c) => {
    await unlockMonthsForDates(c, [today, dueDate]);
  });

  const session = await openAs(browser, role);
  try {
    await gotoReady(session.page, route);
    const signature = await resolveFinanceSignature(route, "Taslak oluştur", session.page);

    const draftForm = session.page
      .locator("form")
      .filter({ has: session.page.getByRole("button", { name: "Taslak oluştur", exact: true }) })
      .first();

    await draftForm.locator('select[name="direction"]').selectOption("sales");
    await draftForm.locator('select[name="partyId"]').selectOption(party.id);
    await draftForm.locator('input[name="invoiceNo"]').fill(invoiceNo);
    await draftForm.locator('input[name="issueDate"]').fill(today);
    await draftForm.locator('select[name="currency"]').selectOption("TRY");
    await draftForm.locator('input[name="dueDate"]').fill(dueDate);
    await draftForm.locator('input[name="lineDescription"]').fill(`IX Taslak Kalem ${suffix}`);
    await draftForm.locator('input[name="lineQuantity"]').fill("2");
    await draftForm.locator('input[name="lineUnitPrice"]').fill("3500");
    await draftForm.locator('input[name="lineTaxRate"]').fill("0.20");

    await executeAndVerifyMutation({
      id: "finance-invoices-draft-create",
      session,
      route,
      role,
      signature,
      labelForProof: "Taslak oluştur",
      button: draftForm.getByRole("button", { name: "Taslak oluştur", exact: true }),
      readState: async () =>
        await scalar<string>(
          `select status || '|lines=' || (select count(*)::int from public.invoice_lines il where il.invoice_id = i.id)::text
             from public.invoices i
            where i.invoice_no = $1`,
          [invoiceNo],
        ),
      isCommitted: (before, cur) => before === null && cur === "draft|lines=1",
      describeState: (s) => `invoices[${invoiceNo}]=${s ?? "null"}`,
    });
  } finally {
    await session.context.close();
  }
});

test("[15/35] /finance/promises — Kırılan sözleri tespit et (promises/detect)", async ({
  browser,
}) => {
  const route = "/finance/promises";
  const role: SeededRole = "finance_operator";
  const pastDate = addDaysIso(istanbulTodayIso(), -7);
  const suffix = uniqueSuffix();
  const party = await ensureActiveParty("customer", "IX-PROM-BROKEN");

  const promiseId = await db(async (c) => {
    const ins = await c.query<{ id: string }>(
      `insert into public.promise_to_pay
         (party_id, promised_amount, currency, promised_date, channel, status, note)
       values ($1::uuid, 7800.00, 'TRY', $2::date, 'phone', 'pending', $3)
       returning id::text as id`,
      [party.id, pastDate, `IX gecikmiş ödeme sözü ${suffix}`],
    );
    return ins.rows[0].id;
  });

  const session = await openAs(browser, role);
  try {
    await gotoReady(session.page, route);
    const signature = await resolveFinanceSignature(
      route,
      "Kırılan sözleri tespit et",
      session.page,
    );

    const detectBtn = session.page
      .getByRole("button", { name: "Kırılan sözleri tespit et", exact: true })
      .first();

    await executeAndVerifyMutation({
      id: "finance-promises-detect-broken",
      session,
      route,
      role,
      signature,
      labelForProof: "Kırılan sözleri tespit et",
      button: detectBtn,
      readState: async () =>
        await scalar<string>(
          `select status || '|' || coalesce(resolution_source, '') from public.promise_to_pay where id = $1::uuid`,
          [promiseId],
        ),
      isCommitted: (before, cur) => before === "pending|" && cur === "broken|auto_detection",
      describeState: (s) => `promise_to_pay[${promiseId}]=${s ?? "null"}`,
    });
  } finally {
    await session.context.close();
  }
});

test("[16/35] /finance/promises — Sözü kaydet (promises/save)", async ({ browser }) => {
  const route = "/finance/promises";
  const role: SeededRole = "finance_operator";
  const futureDate = addDaysIso(istanbulTodayIso(), 10);
  const suffix = uniqueSuffix();
  const noteMarker = `IX-PROMISE-SAVE-${suffix}`;
  const party = await ensureActiveParty("customer", "IX-PROM-SAVE");

  const session = await openAs(browser, role);
  try {
    await gotoReady(session.page, route);
    const signature = await resolveFinanceSignature(route, "Sözü kaydet", session.page);

    const form = session.page
      .locator("form")
      .filter({ has: session.page.getByRole("button", { name: "Sözü kaydet", exact: true }) })
      .first();

    await form.locator('select[name="partyId"]').selectOption(party.id);
    await form.locator('input[name="promisedDate"]').fill(futureDate);
    await form.locator('input[name="promisedAmount"]').fill("14600");
    await form.locator('select[name="currency"]').selectOption("TRY");
    await form.locator('select[name="channel"]').selectOption("phone");
    await form.locator('input[name="note"]').fill(noteMarker);

    await executeAndVerifyMutation({
      id: "finance-promises-save",
      session,
      route,
      role,
      signature,
      labelForProof: "Sözü kaydet",
      button: form.getByRole("button", { name: "Sözü kaydet", exact: true }),
      readState: async () =>
        Number(
          await scalar<string>(
            `select count(*)::int from public.promise_to_pay where party_id = $1::uuid and note = $2`,
            [party.id, noteMarker],
          ),
        ),
      isCommitted: (before, cur) => before === 0 && cur === 1,
      describeState: (n) => `promise_to_pay[note=${noteMarker}]=${n}`,
    });
  } finally {
    await session.context.close();
  }
});

test("[17/35] /finance/treasury — Hesap ekle (treasury/upsert-account)", async ({ browser }) => {
  const route = "/finance/treasury";
  const role: SeededRole = "finance_manager";
  const today = istanbulTodayIso();
  const suffix = uniqueSuffix();
  const accountName = `IX Hazine Kasa ${suffix}`;

  await db(async (c) => {
    await unlockMonthsForDates(c, [today]);
  });

  const session = await openAs(browser, role);
  try {
    await gotoReady(session.page, route);
    const signature = await resolveFinanceSignature(route, "Hesap ekle", session.page);

    const addForm = session.page
      .locator("form")
      .filter({ has: session.page.getByRole("button", { name: "Hesap ekle", exact: true }) })
      .first();

    await addForm.locator('input[name="name"]').fill(accountName);
    await addForm.locator('select[name="kind"]').selectOption("cash");
    await addForm.locator('select[name="currency"]').selectOption("TRY");
    await addForm.locator('input[name="openingBalance"]').fill("18500.00");
    await addForm.locator('input[name="openingBalanceDate"]').fill(today);

    await executeAndVerifyMutation({
      id: "finance-treasury-add-account",
      session,
      route,
      role,
      signature,
      labelForProof: "Hesap ekle",
      button: addForm.getByRole("button", { name: "Hesap ekle", exact: true }),
      readState: async () =>
        Number(
          await scalar<string>(
            `select count(*)::int from public.cash_accounts where name = $1 and opening_journal_entry_id is not null`,
            [accountName],
          ),
        ),
      isCommitted: (before, cur) => before === 0 && cur === 1,
      describeState: (n) => `cash_accounts[name="${accountName}", with_500_99_journal]=${n}`,
    });
  } finally {
    await session.context.close();
  }
});

test("[18/35] /finance/treasury — Kaydet (treasury/upsert-account)", async ({ browser }) => {
  const route = "/finance/treasury";
  const role: SeededRole = "finance_manager";
  const today = istanbulTodayIso();
  const suffix = uniqueSuffix();
  const updatedBalance = "26400.50";

  const cashAccountId = await db(async (c) => {
    await unlockMonthsForDates(c, [today]);
    const ins = await c.query<{ id: string }>(
      `insert into public.cash_accounts (name, account_type, currency, opening_balance, opening_balance_date, is_active)
       values ($1, 'cash', 'TRY', 9200.00, $2::date, true)
       returning id::text as id`,
      [`IX Hazine Güncelleme ${suffix}`, today],
    );
    return ins.rows[0].id;
  });

  const session = await openAs(browser, role);
  try {
    await gotoReady(session.page, route);
    // Büyük 'K' ile "Kaydet": hesap satırı güncelleme formu (`treasury/upsert-account`)
    const signature = await resolveFinanceSignature(route, "Kaydet", session.page);

    const rowForm = session.page
      .locator("form")
      .filter({
        has: session.page.locator(`input[name="cashAccountId"][value="${cashAccountId}"]`),
      })
      .filter({ has: session.page.getByRole("button", { name: "Kaydet", exact: true }) })
      .first();

    await rowForm.locator('input[name="openingBalance"]').fill(updatedBalance);
    await rowForm.locator('input[name="openingBalanceDate"]').fill(today);

    await executeAndVerifyMutation({
      id: "finance-treasury-update-account",
      session,
      route,
      role,
      signature,
      labelForProof: "Kaydet",
      button: rowForm.getByRole("button", { name: "Kaydet", exact: true }),
      readState: async () =>
        await scalar<string>(
          `select (opening_balance::numeric(14,2))::text from public.cash_accounts where id = $1::uuid`,
          [cashAccountId],
        ),
      isCommitted: (before, cur) => before === "9200.00" && cur === updatedBalance,
      describeState: (s) => `cash_accounts[${cashAccountId}].opening_balance=${s ?? "null"}`,
    });
  } finally {
    await session.context.close();
  }
});

test("[19/35] /finance/treasury — kaydet (treasury/save)", async ({ browser }) => {
  const route = "/finance/treasury";
  const role: SeededRole = "admin";

  const policyTarget = await db(async (c) => {
    const existing = await c.query<{
      code: string;
      policy_kind: string;
      threshold_amount: string | null;
      threshold_days: number | null;
    }>(
      `select code, policy_kind, threshold_amount::text, threshold_days
         from public.treasury_policies
        order by code asc
        limit 1`,
    );
    if ((existing.rowCount ?? 0) > 0) {
      return existing.rows[0];
    }
    const ins = await c.query<{
      code: string;
      policy_kind: string;
      threshold_amount: string | null;
      threshold_days: number | null;
    }>(
      `insert into public.treasury_policies (code, description, policy_kind, currency, threshold_amount, is_active)
       values ('ix_min_cash_try', 'IX Asgari Nakit Politikası', 'min_cash', 'TRY', 50000.00, true)
       returning code, policy_kind, threshold_amount::text, threshold_days`,
    );
    return ins.rows[0];
  });

  const isMinCash = policyTarget.policy_kind === "min_cash";
  const currentAmt = Number(policyTarget.threshold_amount ?? "0");
  const nextAmt = currentAmt === 76543 ? "65432.00" : "76543.00";
  const currentDays = Number(policyTarget.threshold_days ?? 14);
  const nextDays = currentDays === 21 ? 18 : 21;

  const session = await openAs(browser, role);
  try {
    await gotoReady(session.page, route);
    // Küçük 'k' ile "kaydet": hazine politikası güncelleme formu (`treasury/save`)
    const signature = await resolveFinanceSignature(route, "kaydet", session.page);

    const policyForm = session.page
      .locator("form")
      .filter({
        has: session.page.locator(`input[name="code"][value="${policyTarget.code}"]`),
      })
      .filter({ has: session.page.getByRole("button", { name: "kaydet", exact: true }) })
      .first();

    if (isMinCash) {
      await policyForm.locator('input[name="thresholdAmount"]').fill(nextAmt);
    } else {
      await policyForm.locator('input[name="thresholdDays"]').fill(String(nextDays));
    }

    await executeAndVerifyMutation({
      id: "finance-treasury-save-policy",
      session,
      route,
      role,
      signature,
      labelForProof: "kaydet",
      button: policyForm.getByRole("button", { name: "kaydet", exact: true }),
      readState: async () =>
        await scalar<string>(
          `select case when policy_kind = 'min_cash'
                       then (threshold_amount::numeric(14,2))::text
                       else threshold_days::text
                  end
             from public.treasury_policies
            where code = $1`,
          [policyTarget.code],
        ),
      isCommitted: (before, cur) =>
        isMinCash ? cur === nextAmt && cur !== before : cur === String(nextDays) && cur !== before,
      describeState: (s) => `treasury_policies[${policyTarget.code}]=${s ?? "null"}`,
    });
  } finally {
    await session.context.close();
  }
});

test("[20/35] /cashflow/13-week — Haftalık Tahmin Anlık Görüntüsünü Dondur (cashflow-13w/freeze)", async ({
  browser,
}) => {
  const route = "/cashflow/13-week";
  const role: SeededRole = "finance_manager";

  const session = await openAs(browser, role);
  try {
    await gotoReady(session.page, route);
    const signature = await resolveFinanceSignature(
      route,
      "Haftalık Tahmin Anlık Görüntüsünü Dondur (",
      session.page,
      { prefixMatch: true },
    );

    const freezeBtn = session.page
      .getByRole("button", { name: /^Haftalık Tahmin Anlık Görüntüsünü Dondur \(/ })
      .first();

    await executeAndVerifyMutation({
      id: "cashflow-13w-freeze",
      session,
      route,
      role,
      signature,
      labelForProof: "Haftalık Tahmin Anlık Görüntüsünü Dondur",
      button: freezeBtn,
      readState: async () => {
        const auditCount = Number(
          await scalar<string>(
            `select count(*)::int from public.audit_logs where action = 'freeze_forecast_13w_snapshot'`,
          ),
        );
        const snapCount = Number(
          await scalar<string>(
            `select count(*)::int from public.forecast_snapshots_13w where currency = 'TRY'`,
          ),
        );
        return { auditCount, snapCount };
      },
      isCommitted: (before, cur) => cur.auditCount > before.auditCount && cur.snapCount >= 1,
      describeState: (s) =>
        `audit[freeze_forecast_13w_snapshot]=${s.auditCount}, snapshots_try=${s.snapCount}`,
    });
  } finally {
    await session.context.close();
  }
});

test("[21/35] /cashflow/13-week — Manuel Tahmin Satırı Ekle (cashflow-13w/manual-override)", async ({
  browser,
}) => {
  const route = "/cashflow/13-week";
  const role: SeededRole = "finance_operator";
  const suffix = uniqueSuffix();
  const noteMarker = `IX-13W-MANUAL-${suffix}`;

  const session = await openAs(browser, role);
  try {
    await gotoReady(session.page, route);
    const signature = await resolveFinanceSignature(
      route,
      "Manuel Tahmin Satırı Ekle",
      session.page,
    );

    const form = session.page
      .locator("form")
      .filter({
        has: session.page.getByRole("button", { name: "Manuel Tahmin Satırı Ekle", exact: true }),
      })
      .first();

    await form.locator('select[name="direction"]').selectOption("inflow");
    await form.locator('input[name="amount"]').fill("27500");
    await form.locator('input[name="notes"]').fill(noteMarker);

    await executeAndVerifyMutation({
      id: "cashflow-13w-manual-override",
      session,
      route,
      role,
      signature,
      labelForProof: "Manuel Tahmin Satırı Ekle",
      button: form.getByRole("button", { name: "Manuel Tahmin Satırı Ekle", exact: true }),
      readState: async () =>
        Number(
          await scalar<string>(
            `select count(*)::int from public.forecast_lines where source_kind = 'manual' and notes = $1`,
            [noteMarker],
          ),
        ),
      isCommitted: (before, cur) => before === 0 && cur === 1,
      describeState: (n) => `forecast_lines[manual, notes=${noteMarker}]=${n}`,
    });
  } finally {
    await session.context.close();
  }
});

test("[22/35] /cashflow/budget — Bütçe oluştur (budget/create)", async ({ browser }) => {
  const route = "/cashflow/budget";
  const role: SeededRole = "finance_operator";
  const suffix = uniqueSuffix();
  const budgetName = `IX-BUDGET-${suffix}`;

  const session = await openAs(browser, role);
  try {
    await gotoReady(session.page, route);
    const signature = await resolveFinanceSignature(route, "Bütçe oluştur", session.page);

    const createBtn = session.page.getByRole("button", { name: "Bütçe oluştur", exact: true }).first();
    await openEnclosingDetailsIfClosed(createBtn);

    const form = session.page
      .locator("form")
      .filter({ has: session.page.getByRole("button", { name: "Bütçe oluştur", exact: true }) })
      .first();

    await form.locator('input[name="name"]').fill(budgetName);
    await form.locator('input[name="fiscalYear"]').fill("2026");
    await form.locator('select[name="periodKind"]').selectOption("monthly");
    await form.locator('select[name="currency"]').selectOption("TRY");

    await executeAndVerifyMutation({
      id: "cashflow-budget-create",
      session,
      route,
      role,
      signature,
      labelForProof: "Bütçe oluştur",
      button: form.getByRole("button", { name: "Bütçe oluştur", exact: true }),
      readState: async () =>
        Number(
          await scalar<string>(`select count(*)::int from public.budgets where name = $1`, [
            budgetName,
          ]),
        ),
      isCommitted: (before, cur) => before === 0 && cur === 1,
      describeState: (n) => `budgets[name=${budgetName}]=${n}`,
    });
  } finally {
    await session.context.close();
  }
});

test("[23/35] /cashflow/budget — Tahmin kabı aç (budget/create-forecast)", async ({ browser }) => {
  const route = "/cashflow/budget";
  const role: SeededRole = "finance_operator";
  const today = istanbulTodayIso();
  const suffix = uniqueSuffix();
  const forecastName = `IX-FORECAST-${suffix}`;

  const session = await openAs(browser, role);
  try {
    await gotoReady(session.page, route);
    const signature = await resolveFinanceSignature(route, "Tahmin kabı aç", session.page);

    const openBtn = session.page.getByRole("button", { name: "Tahmin kabı aç", exact: true }).first();
    await openEnclosingDetailsIfClosed(openBtn);

    const form = session.page
      .locator("form")
      .filter({ has: session.page.getByRole("button", { name: "Tahmin kabı aç", exact: true }) })
      .first();

    await form.locator('input[name="name"]').fill(forecastName);
    await form.locator('input[name="anchorDate"]').fill(today);
    await form.locator('select[name="horizonKind"]').selectOption("weekly_13");
    await form.locator('select[name="currency"]').selectOption("TRY");

    await executeAndVerifyMutation({
      id: "cashflow-budget-create-forecast",
      session,
      route,
      role,
      signature,
      labelForProof: "Tahmin kabı aç",
      button: form.getByRole("button", { name: "Tahmin kabı aç", exact: true }),
      readState: async () =>
        Number(
          await scalar<string>(`select count(*)::int from public.forecasts where name = $1`, [
            forecastName,
          ]),
        ),
      isCommitted: (before, cur) => before === 0 && cur === 1,
      describeState: (n) => `forecasts[name=${forecastName}]=${n}`,
    });
  } finally {
    await session.context.close();
  }
});

test("[24/35] /finance/facilities — Kredi limitini kaydet (facilities/create)", async ({
  browser,
}) => {
  const route = "/finance/facilities";
  const role: SeededRole = "finance_operator";
  const suffix = uniqueSuffix();
  const facilityName = `IX-FACILITY-${suffix}`;

  const session = await openAs(browser, role);
  try {
    await gotoReady(session.page, route);
    const signature = await resolveFinanceSignature(
      route,
      "Kredi limitini kaydet",
      session.page,
    );

    const saveBtn = session.page
      .getByRole("button", { name: "Kredi limitini kaydet", exact: true })
      .first();
    await openEnclosingDetailsIfClosed(saveBtn);

    const form = session.page
      .locator("form")
      .filter({
        has: session.page.getByRole("button", { name: "Kredi limitini kaydet", exact: true }),
      })
      .first();

    await form.locator('input[name="name"]').fill(facilityName);
    await form.locator('input[name="limitAmount"]').fill("450000");
    await form.locator('select[name="currency"]').selectOption("TRY");

    await executeAndVerifyMutation({
      id: "finance-facilities-create",
      session,
      route,
      role,
      signature,
      labelForProof: "Kredi limitini kaydet",
      button: form.getByRole("button", { name: "Kredi limitini kaydet", exact: true }),
      readState: async () =>
        Number(
          await scalar<string>(
            `select count(*)::int from public.credit_facilities where name = $1`,
            [facilityName],
          ),
        ),
      isCommitted: (before, cur) => before === 0 && cur === 1,
      describeState: (n) => `credit_facilities[name=${facilityName}]=${n}`,
    });
  } finally {
    await session.context.close();
  }
});

test("[25/35] /finance/facilities — Teminatı kaydet (facilities/collateral)", async ({
  browser,
}) => {
  const route = "/finance/facilities";
  const role: SeededRole = "finance_operator";
  const suffix = uniqueSuffix();
  const collateralDesc = `IX-COLLATERAL-${suffix}`;

  const facilityId = await db(async (c) => {
    const existing = await c.query<{ id: string }>(
      `select id::text as id from public.credit_facilities where status = 'active' limit 1`,
    );
    if ((existing.rowCount ?? 0) > 0) return existing.rows[0].id;
    const ins = await c.query<{ id: string }>(
      `insert into public.credit_facilities (name, facility_type, currency, limit_amount, status)
       values ($1, 'revolving', 'TRY', 300000, 'active')
       returning id::text as id`,
      [`IX-BASE-FAC-${suffix}`],
    );
    return ins.rows[0].id;
  });

  const session = await openAs(browser, role);
  try {
    await gotoReady(session.page, route);
    const signature = await resolveFinanceSignature(route, "Teminatı kaydet", session.page);

    const saveBtn = session.page.getByRole("button", { name: "Teminatı kaydet", exact: true }).first();
    await openEnclosingDetailsIfClosed(saveBtn);

    const form = session.page
      .locator("form")
      .filter({ has: session.page.getByRole("button", { name: "Teminatı kaydet", exact: true }) })
      .first();

    await form
      .locator('select[name="subject"]')
      .selectOption(`facility:${facilityId}`);
    await form.locator('input[name="valueAmount"]').fill("175000");
    await form.locator('select[name="currency"]').selectOption("TRY");
    await form.locator('input[name="description"]').fill(collateralDesc);

    await executeAndVerifyMutation({
      id: "finance-facilities-collateral",
      session,
      route,
      role,
      signature,
      labelForProof: "Teminatı kaydet",
      button: form.getByRole("button", { name: "Teminatı kaydet", exact: true }),
      readState: async () =>
        Number(
          await scalar<string>(
            `select count(*)::int from public.collateral_records where description = $1`,
            [collateralDesc],
          ),
        ),
      isCommitted: (before, cur) => before === 0 && cur === 1,
      describeState: (n) => `collateral_records[description=${collateralDesc}]=${n}`,
    });
  } finally {
    await session.context.close();
  }
});

test("[26/35] /finance/facilities — Kovenantı kaydet (facilities/covenant)", async ({
  browser,
}) => {
  const route = "/finance/facilities";
  const role: SeededRole = "finance_operator";
  const suffix = uniqueSuffix();
  const covenantDesc = `IX-COVENANT-${suffix}`;

  const facilityId = await db(async (c) => {
    const existing = await c.query<{ id: string }>(
      `select id::text as id from public.credit_facilities where status = 'active' limit 1`,
    );
    if ((existing.rowCount ?? 0) > 0) return existing.rows[0].id;
    const ins = await c.query<{ id: string }>(
      `insert into public.credit_facilities (name, facility_type, currency, limit_amount, status)
       values ($1, 'revolving', 'TRY', 300000, 'active')
       returning id::text as id`,
      [`IX-COV-FAC-${suffix}`],
    );
    return ins.rows[0].id;
  });

  const session = await openAs(browser, role);
  try {
    await gotoReady(session.page, route);
    const signature = await resolveFinanceSignature(route, "Kovenantı kaydet", session.page);

    const saveBtn = session.page
      .getByRole("button", { name: "Kovenantı kaydet", exact: true })
      .first();
    await openEnclosingDetailsIfClosed(saveBtn);

    const form = session.page
      .locator("form")
      .filter({ has: session.page.getByRole("button", { name: "Kovenantı kaydet", exact: true }) })
      .first();

    await form.locator('select[name="covenantId"]').selectOption("");
    await form
      .locator('select[name="subject"]')
      .selectOption(`facility:${facilityId}`);
    await form.locator('input[name="description"]').fill(covenantDesc);
    await form.locator('select[name="comparison"]').selectOption("gte");
    await form.locator('input[name="thresholdValue"]').fill("1.25");

    await executeAndVerifyMutation({
      id: "finance-facilities-covenant",
      session,
      route,
      role,
      signature,
      labelForProof: "Kovenantı kaydet",
      button: form.getByRole("button", { name: "Kovenantı kaydet", exact: true }),
      readState: async () =>
        Number(
          await scalar<string>(
            `select count(*)::int from public.covenant_records where description = $1`,
            [covenantDesc],
          ),
        ),
      isCommitted: (before, cur) => before === 0 && cur === 1,
      describeState: (n) => `covenant_records[description=${covenantDesc}]=${n}`,
    });
  } finally {
    await session.context.close();
  }
});

test("[27/35] /finance/ledger — Operasyonel Kayıtlardan Yönetim Defterini Senkronla (Idempotent) (ledger/sync-from-domain)", async ({
  browser,
}) => {
  const route = "/finance/ledger";
  const role: SeededRole = "finance_operator";
  const today = istanbulTodayIso();
  const suffix = uniqueSuffix();
  const party = await ensureActiveParty("customer", "IX-LEDGER-SYNC");

  // Doğrudan DB'ye açık fatura yazıyoruz (henüz yevmiye fişi yok); Senkronla düğmesi bu faturayı fişlemeli.
  const invoiceId = await db(async (c) => {
    await unlockMonthsForDates(c, [today]);
    const ins = await c.query<{ id: string }>(
      `insert into public.invoices
         (direction, invoice_no, party_id, issue_date, due_date, currency,
          net_amount, tax_amount, gross_amount, payable_amount, paid_amount, allocated_amount, status, approval_status)
       values ('sales', $1, $2::uuid, $3::date, $3::date, 'TRY',
               10000.00, 2000.00, 12000.00, 12000.00, 0, 0, 'open', 'not_required')
       returning id::text as id`,
      [`IX-SYNC-INV-${suffix}`, party.id, today],
    );
    return ins.rows[0].id;
  });

  const session = await openAs(browser, role);
  try {
    await gotoReady(session.page, route);
    const label = "Operasyonel Kayıtlardan Yönetim Defterini Senkronla (Idempotent)";
    const signature = await resolveFinanceSignature(route, label, session.page);

    const syncBtn = session.page.getByRole("button", { name: label, exact: true }).first();

    await executeAndVerifyMutation({
      id: "finance-ledger-sync-domain",
      session,
      route,
      role,
      signature,
      labelForProof: label,
      button: syncBtn,
      readState: async () =>
        Number(
          await scalar<string>(
            `select count(*)::int
               from public.management_journal_entries
              where source_type = 'invoice' and source_id = $1::uuid and status = 'posted'`,
            [invoiceId],
          ),
        ),
      isCommitted: (before, cur) => before === 0 && cur === 1,
      describeState: (n) => `management_journal_entries[invoice=${invoiceId}]=${n}`,
    });
  } finally {
    await session.context.close();
  }
});

test("[28/35] /finance/ledger — Geçici Kur Fişlerini Değerle (TCMB) (ledger/revalue-fx)", async ({
  browser,
}) => {
  const route = "/finance/ledger";
  const role: SeededRole = "finance_manager";
  const today = istanbulTodayIso();
  const suffix = uniqueSuffix();

  const provisionalEntryId = await db(async (c) => {
    await unlockMonthsForDates(c, [today]);
    await c.query("begin");
    try {
      await c.query(
        `insert into public.fx_rate_snapshots (base_currency, quote_currency, rate_date, rate, source)
         values ('USD', 'TRY', $1::date, 35.2500, 'tcmb')
         on conflict (base_currency, quote_currency, rate_date, source) do nothing`,
        [today],
      );

      const acc102 = await c.query<{ id: string }>(
        `select id::text as id from public.management_accounts where code = '102' limit 1`,
      );
      const acc600 = await c.query<{ id: string }>(
        `select id::text as id from public.management_accounts where code = '600' limit 1`,
      );
      if (acc102.rowCount === 0 || acc600.rowCount === 0) {
        throw new Error("TDHP 102 veya 600 hesabı bulunamadı");
      }

      const je = await c.query<{ id: string }>(
        `insert into public.management_journal_entries
           (entry_date, source_type, idempotency_key, status, needs_tax_split_review, description)
         values ($1::date, 'manual_adjustment', $2, 'provisional_fx', false, $3)
         returning id::text as id`,
        [today, `ix:prov-fx:${suffix}`, `IX Geçici Kur Fişi ${suffix}`],
      );
      const entryId = je.rows[0].id;

      await c.query(
        `insert into public.management_journal_lines
           (entry_id, line_no, account_id, native_currency, debit_native, credit_native, fx_rate, debit_try, credit_try, line_memo)
         values
           ($1::uuid, 1, $2::uuid, 'USD', 100.00, 0.00, null, null, null, 'IX USD Borç'),
           ($1::uuid, 2, $3::uuid, 'USD', 0.00, 100.00, null, null, null, 'IX USD Alacak')`,
        [entryId, acc102.rows[0].id, acc600.rows[0].id],
      );

      await c.query("commit");
      return entryId;
    } catch (e) {
      await c.query("rollback");
      throw e;
    }
  });

  const session = await openAs(browser, role);
  try {
    await gotoReady(session.page, route);
    const label = "Geçici Kur Fişlerini Değerle (TCMB)";
    const signature = await resolveFinanceSignature(route, label, session.page);

    const revalueBtn = session.page.getByRole("button", { name: label, exact: true }).first();

    await executeAndVerifyMutation({
      id: "finance-ledger-revalue-fx",
      session,
      route,
      role,
      signature,
      labelForProof: label,
      button: revalueBtn,
      readState: async () =>
        await scalar<string>(
          `select je.status || '|try_set=' || bool_and(jl.debit_try is not null and jl.credit_try is not null)::text
             from public.management_journal_entries je
             join public.management_journal_lines jl on jl.entry_id = je.id
            where je.id = $1::uuid
            group by je.status`,
          [provisionalEntryId],
        ),
      isCommitted: (before, cur) =>
        before === "provisional_fx|try_set=false" && cur === "posted|try_set=true",
      describeState: (s) => `journal_entry[${provisionalEntryId}]=${s ?? "null"}`,
    });
  } finally {
    await session.context.close();
  }
});

test("[29/35] /finance/ledger — Tahakkuk Fişi Kaydet (ledger/post-manual-adjustment)", async ({
  browser,
}) => {
  const route = "/finance/ledger";
  const role: SeededRole = "finance_operator";
  const today = istanbulTodayIso();
  const suffix = uniqueSuffix();
  const accrualDesc = `IX-ACCRUAL-${suffix}`;

  await db(async (c) => {
    await unlockMonthsForDates(c, [today]);
  });

  const session = await openAs(browser, role);
  try {
    await gotoReady(session.page, route);
    const label = "Tahakkuk Fişi Kaydet";
    const signature = await resolveFinanceSignature(route, label, session.page);

    const form = session.page
      .locator("form")
      .filter({ has: session.page.getByRole("button", { name: label, exact: true }) })
      .first();

    await form.locator('input[name="entryDate"]').fill(today);
    await form.locator('input[name="amount"]').fill("8750.00");
    await form.locator('select[name="currency"]').selectOption("TRY");
    await form.locator('input[name="description"]').fill(accrualDesc);

    await executeAndVerifyMutation({
      id: "finance-ledger-manual-accrual",
      session,
      route,
      role,
      signature,
      labelForProof: label,
      button: form.getByRole("button", { name: label, exact: true }),
      readState: async () =>
        Number(
          await scalar<string>(
            `select count(*)::int
               from public.management_journal_entries
              where description = $1 and status = 'posted'`,
            [accrualDesc],
          ),
        ),
      isCommitted: (before, cur) => before === 0 && cur === 1,
      describeState: (n) => `management_journal_entries[desc=${accrualDesc}]=${n}`,
    });
  } finally {
    await session.context.close();
  }
});

test("[30/35] /finance/ledger — TDHP Alt Hesap Aç (ledger/create-sub-account)", async ({
  browser,
}) => {
  const route = "/finance/ledger";
  const role: SeededRole = "finance_manager";
  const suffix = uniqueSuffix();
  const subCode = `120.IX${suffix.slice(-4)}`;
  const subName = `IX Yurtiçi Alıcılar ${suffix}`;

  const session = await openAs(browser, role);
  try {
    await gotoReady(session.page, route);
    const label = "TDHP Alt Hesap Aç";
    const signature = await resolveFinanceSignature(route, label, session.page);

    const form = session.page
      .locator("form")
      .filter({ has: session.page.getByRole("button", { name: label, exact: true }) })
      .first();

    await form.locator('input[name="code"]').fill(subCode);
    await form.locator('input[name="name"]').fill(subName);

    await executeAndVerifyMutation({
      id: "finance-ledger-create-sub-account",
      session,
      route,
      role,
      signature,
      labelForProof: label,
      button: form.getByRole("button", { name: label, exact: true }),
      readState: async () =>
        Number(
          await scalar<string>(
            `select count(*)::int from public.management_accounts where code = $1`,
            [subCode],
          ),
        ),
      isCommitted: (before, cur) => before === 0 && cur === 1,
      describeState: (n) => `management_accounts[code=${subCode}]=${n}`,
    });
  } finally {
    await session.context.close();
  }
});

test("[31/35] /finance/ledger — Ters Kayıt (Storno) (ledger/reverse-entry)", async ({
  browser,
}) => {
  const route = "/finance/ledger";
  const role: SeededRole = "finance_manager";
  const today = istanbulTodayIso();
  const topDate = addDaysIso(today, 2);
  const suffix = uniqueSuffix();

  // `order by je.entry_date desc, je.entry_no desc limit 50` içinde ilk sırada yer alacak posted fiş.
  const postedEntryId = await db(async (c) => {
    await unlockMonthsForDates(c, [today, topDate]);
    await c.query("begin");
    try {
      const acc770 = await c.query<{ id: string }>(
        `select id::text as id from public.management_accounts where code = '770' limit 1`,
      );
      const acc100 = await c.query<{ id: string }>(
        `select id::text as id from public.management_accounts where code = '100' limit 1`,
      );
      if (acc770.rowCount === 0 || acc100.rowCount === 0) {
        throw new Error("TDHP 770 veya 100 hesabı bulunamadı");
      }

      const je = await c.query<{ id: string }>(
        `insert into public.management_journal_entries
           (entry_date, source_type, idempotency_key, status, needs_tax_split_review, description)
         values ($1::date, 'manual_adjustment', $2, 'posted', false, $3)
         returning id::text as id`,
        [topDate, `ix:storno-src:${suffix}`, `IX Storno Kaynak Fiş ${suffix}`],
      );
      const entryId = je.rows[0].id;

      await c.query(
        `insert into public.management_journal_lines
           (entry_id, line_no, account_id, native_currency, debit_native, credit_native, fx_rate, debit_try, credit_try, line_memo)
         values
           ($1::uuid, 1, $2::uuid, 'TRY', 4200.00, 0.00, 1, 4200.00, 0.00, 'IX Borç'),
           ($1::uuid, 2, $3::uuid, 'TRY', 0.00, 4200.00, 1, 0.00, 4200.00, 'IX Alacak')`,
        [entryId, acc770.rows[0].id, acc100.rows[0].id],
      );

      await c.query("commit");
      return entryId;
    } catch (e) {
      await c.query("rollback");
      throw e;
    }
  });

  const session = await openAs(browser, role);
  try {
    await gotoReady(session.page, route);
    const label = "Ters Kayıt (Storno)";
    const signature = await resolveFinanceSignature(route, label, session.page);

    const reverseForm = session.page
      .locator("form")
      .filter({
        has: session.page.locator(`input[name="entryId"][value="${postedEntryId}"]`),
      })
      .filter({ has: session.page.getByRole("button", { name: label, exact: true }) })
      .first();

    await reverseForm.locator('input[name="reason"]').fill(`IX Storno Gerekçesi ${suffix}`);

    await executeAndVerifyMutation({
      id: "finance-ledger-reverse-entry",
      session,
      route,
      role,
      signature,
      labelForProof: label,
      button: reverseForm.getByRole("button", { name: label, exact: true }),
      readState: async () =>
        await scalar<string>(
          `select status || '|rev=' || (reversed_by_entry_id is not null)::text
             from public.management_journal_entries
            where id = $1::uuid`,
          [postedEntryId],
        ),
      isCommitted: (before, cur) => before === "posted|rev=false" && cur === "reversed|rev=true",
      describeState: (s) => `management_journal_entries[${postedEntryId}]=${s ?? "null"}`,
    });
  } finally {
    await session.context.close();
  }
});

test("[32/35] /finance/counterparties — Karşı taraf ekle (counterparties/create)", async ({
  browser,
}) => {
  const route = "/finance/counterparties";
  const role: SeededRole = "finance_manager";
  const suffix = uniqueSuffix();
  const partyName = `IX Yeni Cari ${suffix}`;

  const session = await openAs(browser, role);
  try {
    await gotoReady(session.page, route);
    const label = "Karşı taraf ekle";
    const signature = await resolveFinanceSignature(route, label, session.page);

    const form = session.page
      .locator("form")
      .filter({ has: session.page.getByRole("button", { name: label, exact: true }) })
      .first();

    await form.locator('input[name="name"]').fill(partyName);
    await form.locator('select[name="partyType"]').selectOption("customer");
    await form.locator('input[name="city"]').fill("İstanbul");
    await form.locator('input[name="paymentTermsDays"]').fill("30");

    await executeAndVerifyMutation({
      id: "finance-counterparties-create",
      session,
      route,
      role,
      signature,
      labelForProof: label,
      button: form.getByRole("button", { name: label, exact: true }),
      readState: async () =>
        Number(
          await scalar<string>(`select count(*)::int from public.parties where name = $1`, [
            partyName,
          ]),
        ),
      isCommitted: (before, cur) => before === 0 && cur === 1,
      describeState: (n) => `parties[name="${partyName}"]=${n}`,
    });
  } finally {
    await session.context.close();
  }
});

test("[33/35] /finance/counterparties — IBAN kaydet (counterparties/add-iban)", async ({
  browser,
}) => {
  const route = "/finance/counterparties";
  const role: SeededRole = "finance_manager";
  const validIban = generateValidTrIban();
  const party = await ensureActiveParty("vendor", "IX-CP-IBAN");

  const session = await openAs(browser, role);
  try {
    await gotoReady(session.page, route);
    const label = "IBAN kaydet";
    const signature = await resolveFinanceSignature(route, label, session.page);

    const saveBtn = session.page.getByRole("button", { name: label, exact: true }).first();
    await openEnclosingDetailsIfClosed(saveBtn);

    const form = session.page
      .locator("form")
      .filter({ has: session.page.getByRole("button", { name: label, exact: true }) })
      .first();

    await form.locator('select[name="partyId"]').selectOption(party.id);
    await form.locator('input[name="iban"]').fill(validIban);
    await form.locator('input[name="bankName"]').fill("IX Vakıfbank");
    await form.locator('select[name="currency"]').selectOption("TRY");

    await executeAndVerifyMutation({
      id: "finance-counterparties-add-iban",
      session,
      route,
      role,
      signature,
      labelForProof: label,
      button: form.getByRole("button", { name: label, exact: true }),
      readState: async () => {
        const ibanCnt = Number(
          await scalar<string>(
            `select count(*)::int from public.ibans where party_id = $1::uuid and iban_normalized = $2`,
            [party.id, validIban],
          ),
        );
        const evtCnt = Number(
          await scalar<string>(
            `select count(*)::int from public.iban_change_events where party_id = $1::uuid`,
            [party.id],
          ),
        );
        return `${ibanCnt}|${evtCnt}`;
      },
      isCommitted: (before, cur) => before === "0|0" && (cur === "1|1" || cur === "1|2"),
      describeState: (s) => `ibans|iban_change_events[${validIban}]=${s}`,
    });
  } finally {
    await session.context.close();
  }
});

test("[34/35] /finance/counterparties — Boyut oluştur (counterparties/create-dimension)", async ({
  browser,
}) => {
  const route = "/finance/counterparties";
  const role: SeededRole = "finance_manager";
  const suffix = uniqueSuffix();
  const dimCode = `IX-PRJ-${suffix}`;
  const dimName = `IX Proje Boyutu ${suffix}`;

  const session = await openAs(browser, role);
  try {
    await gotoReady(session.page, route);
    const label = "Boyut oluştur";
    const signature = await resolveFinanceSignature(route, label, session.page);

    const createBtn = session.page.getByRole("button", { name: label, exact: true }).first();
    await openEnclosingDetailsIfClosed(createBtn);

    const form = session.page
      .locator("form")
      .filter({ has: session.page.getByRole("button", { name: label, exact: true }) })
      .first();

    await form.locator('select[name="table"]').selectOption("projects");
    await form.locator('input[name="code"]').fill(dimCode);
    await form.locator('input[name="name"]').fill(dimName);

    await executeAndVerifyMutation({
      id: "finance-counterparties-create-dimension",
      session,
      route,
      role,
      signature,
      labelForProof: label,
      button: form.getByRole("button", { name: label, exact: true }),
      readState: async () =>
        Number(
          await scalar<string>(`select count(*)::int from public.projects where code = $1`, [
            dimCode,
          ]),
        ),
      isCommitted: (before, cur) => before === 0 && cur === 1,
      describeState: (n) => `projects[code=${dimCode}]=${n}`,
    });
  } finally {
    await session.context.close();
  }
});

test("[35/35] /finance/profitability — Kuralı kaydet (profitability/rule-save)", async ({
  browser,
}) => {
  const route = "/finance/profitability";
  const role: SeededRole = "admin";

  const targetRule = await db(async (c) => {
    const existing = await c.query<{
      code: string;
      fixed_percent: string | null;
    }>(
      `select code, fixed_percent::text
         from public.cost_allocation_rules
        where is_active = true
        order by cost_kind asc, code asc
        limit 1`,
    );
    if ((existing.rowCount ?? 0) > 0) {
      return existing.rows[0];
    }
    const cc = await c.query<{ id: string }>(
      `insert into public.cost_centers (code, name, is_active)
       values ('IX-CC-RULE', 'IX Dağıtım Masraf Merkezi', true)
       on conflict (code) do update set is_active = true
       returning id::text as id`,
    );
    const ins = await c.query<{ code: string; fixed_percent: string | null }>(
      `insert into public.cost_allocation_rules
         (code, description, cost_kind, allocation_basis, cost_center_id, fixed_percent, is_active)
       values ('ix_common_rule', 'IX Genel Gider Dağıtım Kuralı', 'common', 'equal_split', $1::uuid, null, true)
       returning code, fixed_percent::text`,
      [cc.rows[0].id],
    );
    return ins.rows[0];
  });

  const currentFixed = Number(targetRule.fixed_percent ?? "0");
  const nextPctUi = Math.abs(currentFixed - 0.35) < 0.001 ? "42.5" : "35";
  const expectedDbRatio = nextPctUi === "42.5" ? "0.4250" : "0.3500";

  const session = await openAs(browser, role);
  try {
    await gotoReady(session.page, route);
    const label = "Kuralı kaydet";
    const signature = await resolveFinanceSignature(route, label, session.page);

    const saveBtn = session.page.getByRole("button", { name: label, exact: true }).first();
    await openEnclosingDetailsIfClosed(saveBtn);

    const form = session.page
      .locator("form")
      .filter({ has: session.page.getByRole("button", { name: label, exact: true }) })
      .first();

    await form.locator('select[name="code"]').selectOption(targetRule.code);
    await form.locator('select[name="allocationBasis"]').selectOption("fixed_percent");
    await form.locator('input[name="fixedPercentPct"]').fill(nextPctUi);
    await form.locator('select[name="isActive"]').selectOption("true");

    await executeAndVerifyMutation({
      id: "finance-profitability-rule-save",
      session,
      route,
      role,
      signature,
      labelForProof: label,
      button: form.getByRole("button", { name: label, exact: true }),
      readState: async () =>
        await scalar<string>(
          `select allocation_basis || '|' || coalesce((fixed_percent::numeric(6,4))::text, 'null')
             from public.cost_allocation_rules
            where code = $1`,
          [targetRule.code],
        ),
      isCommitted: (before, cur) =>
        cur === `fixed_percent|${expectedDbRatio}` && cur !== before,
      describeState: (s) => `cost_allocation_rules[${targetRule.code}]=${s ?? "null"}`,
    });
  } finally {
    await session.context.close();
  }
});
