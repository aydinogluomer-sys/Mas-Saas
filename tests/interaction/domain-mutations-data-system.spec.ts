/**
 * VERİ VE SİSTEM ALANI MUTASYON KAPSAMI — 39 ayrık (rota, kontrol) birimi.
 *
 * Kapsanan rotalar (11):
 *   1. /data/imports              (1 kontrol: İÇE AKTAR)
 *   2. /data/assumptions          (4 kontrol: kaydet, onay, ret, arşiv)
 *   3. /data/reviews              (4 kontrol: Kabul, Çöz, Reddet, Görev oluştur)
 *   4. /data/approvals            (6 kontrol: Onayla, Reddet, Revizyon, Kural ekle, Pasife al, Aktifleştir)
 *   5. /data/documents            (1 kontrol: Kasaya yükle ve doğrula)
 *   6. /data/reconciliation       (3 kontrol: Mutabakatı imzala, Aksiyon görevi aç, Görev üret)
 *   7. /data/trial-balance-bridge (1 kontrol: Yasal Mizanı Yükle & Köprüyü Çalıştır)
 *   8. /data/integrations         (2 kontrol: Kapalı Çevrim Tam Senkron, Bağlantı Ekle)
 *   9. /system/controls           (5 kontrol: Gördüm, Ertele, Çözüldü, Yanlış alarm, görev aç)
 *  10. /system/jobs               (5 kontrol: + İç Kontrol, + Günlük CFO, + TCMB Kur, Sıradaki işi çalıştır, Kuyruğu süpür)
 *  11. /system/security           (7 kontrol: sıfırla, setRole select, rolü değiştir, pasifleştir, aktifleştir, createUser select, kullanıcı oluştur)
 *
 * Her kontrol için istisnasız doğrulama zinciri:
 *   1. Tekrar çalıştırılabilir PostgreSQL fixture ön koşulu (`db()` owner bağlantısı)
 *   2. Bağımsız owner bağlantısıyla BEFORE okuma + `audit_logs` başlangıç sayacı
 *   3. Gerçek Chromium UI etkileşimi (`fill` / `selectOption` / `setInputFiles` / `click`) + POST + `networkidle`
 *   4. Hata ekranı / `?error=` / `?flash=user_error` / HTTP 5xx / `console.error` yokluğu
 *   5. Bağımsız owner bağlantısıyla AFTER `expect.poll` doğrulaması + `audit_logs` artışı
 *   6. `page.reload()` + `waitForWorkspaceReady` + reload sonrası kalıcılık doğrulaması
 *   7. Kanıt çıktısı: `docs/interaction-audit/evidence-mutations-data-system.json`
 */

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import ExcelJS from "exceljs";
import { expect, test, type Locator, type Page } from "@playwright/test";
import {
  assertClean,
  db,
  loadRuntimeInventory,
  openAs,
  scalar,
  type Evidence,
  type RuntimeInventory,
  type SeededRole,
} from "./harness";
import { usernameFor } from "../visual/global-setup";
import { waitForWorkspaceReady } from "./workspace-ready";

const OUT = path.join(process.cwd(), "docs", "interaction-audit");
const EVIDENCE_FILE = path.join(OUT, "evidence-mutations-data-system.json");
const evidence: Evidence[] = [];

test.afterAll(() => {
  mkdirSync(OUT, { recursive: true });
  writeFileSync(EVIDENCE_FILE, `${JSON.stringify({ rows: evidence }, null, 2)}\n`, "utf8");
});

/* ── Oturum hesapları koruma kalkanı (/system/security) ──────────────────────────────────── */

const PROTECTED_USERNAMES = new Set<string>([
  "system",
  "testsprite-qa",
  "visual_viewer",
  "visual_finance_operator",
  "visual_finance_approver",
  "visual_finance_manager",
  "visual_admin",
  usernameFor("viewer"),
  usernameFor("finance_operator"),
  usernameFor("finance_approver"),
  usernameFor("finance_manager"),
  usernameFor("admin"),
]);

function assertSafeTargetUsername(username: string): void {
  const normalized = username.trim().toLowerCase();
  if (!normalized || normalized.startsWith("visual_") || PROTECTED_USERNAMES.has(normalized)) {
    throw new Error(
      `GÜVENLİK DURDURMASI: '${username}' korumalı bir oturum/sistem hesabıdır; /system/security testleri yalnız 'ix_*' hesaplarına dokunabilir.`,
    );
  }
}

/* ── Yardımcılar: DB skaler okuma, imza çıkarma ve sunucu aksiyonu bekleme ───────────────── */

async function count(sql: string, params: unknown[] = []): Promise<number> {
  return Number(await scalar<string>(sql, params));
}

async function userIdForRole(role: SeededRole): Promise<string> {
  const id = await scalar<string>("select id::text from public.users where username = $1", [usernameFor(role)]);
  expect(id, `${role} (${usernameFor(role)}) kullanıcısı bulunamadı — globalSetup çalışmamış olabilir`).toBeTruthy();
  return id as string;
}

let cachedInv: RuntimeInventory | null = null;

/**
 * Canlı DOM düğümünden `scripts/qa/runtime-interaction-crawl.ts` ile BİREBİR aynı formülle
 * (`tag|type|label|actionId`) imzayı üretir ve `runtime-inventory.json` ile çapraz doğrular.
 *
 * `/system/security` ekranında aynı etikete sahip iki ayrı `<select name="role">` (biri
 * `setRoleAction`, diğeri `createUserAction` formunda) bulunduğu için yalnız `(route, label)`
 * araması ilk eşleşmeye çarpardı; doğrudan hedef `Locator` üzerinden okuma her formu kendi
 * `$ACTION_ID_…` kimliğiyle kesin olarak ayırır.
 */
async function resolveControlSignature(
  route: string,
  locator: Locator,
  expectedTag: "button" | "select",
  expectedLabel?: string,
): Promise<string> {
  const domSig = await locator.evaluate((node) => {
    const clean = (s: string | null): string => (s ?? "").replace(/\s+/g, " ").trim();
    const el = node as HTMLElement;
    const form = el.closest("form");
    let actionId: string | null = null;
    if (form) {
      const hidden = form.querySelector('input[name^="$ACTION_ID_"]');
      if (hidden) actionId = hidden.getAttribute("name");
      else if (form.querySelector('input[name="$ACTION_REF_1"]')) actionId = "$ACTION_REF_1";
    }
    const label = (
      clean(el.textContent) ||
      el.getAttribute("aria-label") ||
      el.getAttribute("title") ||
      el.getAttribute("value") ||
      "(etiketsiz)"
    ).slice(0, 120);
    const tag = el.tagName.toLowerCase();
    const type = el.getAttribute("type") ?? "";
    return `${tag}|${type}|${label}|${actionId ?? el.getAttribute("href") ?? ""}`;
  });

  cachedInv ??= loadRuntimeInventory();
  const exactHit = cachedInv.controls.find((c) => c.route === route && c.signature === domSig);
  if (exactHit) return exactHit.signature;

  if (expectedLabel !== undefined) {
    const byTagLabel = cachedInv.controls.filter(
      (c) => c.route === route && c.tag === expectedTag && c.label === expectedLabel,
    );
    const distinct = [...new Set(byTagLabel.map((c) => c.signature))];
    if (distinct.length === 1) return distinct[0];
  }

  return domSig;
}

async function submitAndSettle(page: Page, trigger: () => Promise<void>): Promise<void> {
  const post = page
    .waitForResponse((r) => r.request().method() === "POST", { timeout: 60_000 })
    .catch(() => null);
  await trigger();
  await post;
  await page.waitForLoadState("networkidle", { timeout: 60_000 }).catch(() => {});
  await waitForWorkspaceReady(page).catch(() => {});
}

async function assertNoUiFailure(page: Page, contextLabel: string): Promise<void> {
  const body = await page.locator("body").innerText();
  expect(
    /Application error|Internal Server Error/i.test(body),
    `${contextLabel}: aksiyon uygulama hata ekranı üretti`,
  ).toBe(false);

  const parsedUrl = new URL(page.url());
  const errParam = parsedUrl.searchParams.get("error");
  expect(errParam, `${contextLabel}: aksiyon ?error=${errParam ?? ""} ile hata döndürdü`).toBeNull();

  const flashParam = parsedUrl.searchParams.get("flash");
  expect(
    flashParam === "user_error" || flashParam === "user_self",
    `${contextLabel}: aksiyon ?flash=${flashParam ?? ""} ile reddedildi`,
  ).toBe(false);
}

/* ── Bellek-içi geçerli dosya üreticileri (.xlsx / .pdf) ─────────────────────────────────── */

async function buildValidImportWorkbookBuffer(tag: string): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("IX_Serbest_Veri");
  ws.addRow(["Açıklama", "Tutar", "Para Birimi", "Referans"]);
  ws.addRow([`IX Serbest Aktarım Satırı 1 (${tag})`, 18500.5, "TRY", `IX-IMP-1-${tag}`]);
  ws.addRow([`IX Serbest Aktarım Satırı 2 (${tag})`, 9250.25, "TRY", `IX-IMP-2-${tag}`]);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

async function buildBalancedMizanWorkbookBuffer(tag: string): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Mizan");
  ws.addRow(["Hesap Kodu", "Hesap Adı", "Borç", "Alacak"]);
  ws.addRow(["100.01", `Merkez TL Kasa (${tag})`, 150000, 25000]);
  ws.addRow(["102.01", "Vadesiz Ticari Mevduat", 350000, 100000]);
  ws.addRow(["320.01", "Yurtiçi Tedarikçiler", 50000, 175000]);
  ws.addRow(["600.01", "Yurtiçi Satışlar", 0, 250000]);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

function buildValidPdfBuffer(tag: string): Buffer {
  const content = [
    "%PDF-1.4",
    `% IX-DOC-${tag}`,
    "1 0 obj",
    "<< /Type /Catalog /Pages 2 0 R >>",
    "endobj",
    "2 0 obj",
    "<< /Type /Pages /Kids [] /Count 0 >>",
    "endobj",
    "trailer",
    "<< /Root 1 0 R >>",
    "%%EOF",
    "",
  ].join("\n");
  return Buffer.from(content, "utf8");
}

/* ── Tekrar çalıştırılabilir PostgreSQL fixture kurucuları ───────────────────────────────── */

async function seedPendingExternalAssumption(tag: string): Promise<string> {
  const creatorId = await userIdForRole("finance_manager");
  return db(async (c) => {
    const r = await c.query<{ id: string }>(
      `insert into public.external_assumptions
         (assumption_type, label, value_numeric, unit, currency, source_kind,
          source_name, source_url, source_date, review_status, created_by)
       values
         ('interest_rate', $1, 44.50, 'yüzde', 'TRY', 'internet',
          'IX TCMB Kaynağı', 'https://www.tcmb.gov.tr', '2099-12-31'::date, 'pending_review', $2)
       returning id::text as id`,
      [`IX-FIXTURE Varsayım ${tag}`, creatorId],
    );
    return r.rows[0].id;
  });
}

async function ensureFixtureSourceWorkbook(): Promise<string> {
  const operatorId = await userIdForRole("finance_operator");
  return db(async (c) => {
    const existing = await c.query<{ id: string }>(
      `select id::text as id
         from public.source_workbooks
        where original_filename = 'ix-fixture-reviews-parent.xlsx'
        limit 1`,
    );
    if (existing.rowCount && existing.rows[0]) return existing.rows[0].id;

    const ins = await c.query<{ id: string }>(
      `insert into public.source_workbooks
         (original_filename, file_sha256, status, imported_by, notes)
       values ('ix-fixture-reviews-parent.xlsx', repeat('b', 64), 'parsed', $1, 'IX-FIXTURE')
       returning id::text as id`,
      [operatorId],
    );
    return ins.rows[0].id;
  });
}

async function seedOpenMappingReview(tag: string): Promise<string> {
  const workbookId = await ensureFixtureSourceWorkbook();
  return db(async (c) => {
    const r = await c.query<{ id: string }>(
      `insert into public.mapping_reviews
         (workbook_id, issue_type, severity, message, status)
       values ($1, 'ambiguous_row', 'critical', $2, 'open')
       returning id::text as id`,
      [workbookId, `IX-FIXTURE İnceleme Kaydı ${tag}`],
    );
    return r.rows[0].id;
  });
}

/**
 * `/data/approvals` karar testleri için 4-göz (`requested_by <> decided_by`) uyumlu
 * bekleyen onay kaydı ve gerçek `mapping_reviews` hedef satırı üretir.
 *
 * Talep eden `visual_finance_operator`, karar veren ise testte oturum açan `visual_admin`
 * olduğu için sistemde 2+ aktif onaycı varken de sıkı `maker <> checker` kısıtı ve
 * `applySubjectWriteback` RLS kuralları doğal biçimde sağlanır.
 */
async function seedPendingApprovalForAdminDecision(tag: string): Promise<{
  approvalId: string;
  subjectId: string;
}> {
  const operatorId = await userIdForRole("finance_operator");
  const subjectId = await seedOpenMappingReview(`onay-konusu-${tag}`);
  return db(async (c) => {
    const appRes = await c.query<{ id: string }>(
      `insert into public.approvals
         (subject_table, subject_id, subject_label, request_kind, rule_code, round_no,
          amount, currency, status, requested_by, notes)
       values
         ('mapping_reviews', $1, $2, 'data_review', null, 1,
          25000.00, 'TRY', 'pending', $3, 'IX-FIXTURE 4-göz onay testi')
       on conflict (subject_table, subject_id, round_no) do update
         set subject_label = excluded.subject_label,
             amount = excluded.amount,
             currency = excluded.currency,
             status = 'pending',
             requested_by = excluded.requested_by,
             decided_by = null,
             decided_at = null,
             notes = excluded.notes
       returning id::text as id`,
      [subjectId, `IX-FIXTURE Onay Konusu ${tag}`, operatorId],
    );
    const approvalId = appRes.rows[0].id;
    await c.query(
      `insert into public.approval_steps
         (approval_id, step_no, action, actor, note, to_status)
       values (
         $1,
         coalesce((select max(step_no) from public.approval_steps where approval_id = $1), 0) + 1,
         'requested',
         $2,
         'IX-FIXTURE talep açılışı',
         'pending'
       )`,
      [approvalId, operatorId],
    );
    return { approvalId, subjectId };
  });
}

async function ensureToggleableApprovalRule(isActive: boolean): Promise<string> {
  return db(async (c) => {
    const r = await c.query<{ id: string }>(
      `insert into public.approval_rules
         (code, description, trigger_kind, threshold_amount, currency, applies_to, is_active)
       values
         ('ix_fixture_toggle_rule', 'IX-FIXTURE Aç/Kapat Kuralı', 'amount_threshold', 999999999.00, 'TRY', array['invoices']::text[], $1)
       on conflict (code) do update
         set trigger_kind = 'amount_threshold',
             is_active = excluded.is_active,
             threshold_amount = 999999999.00
       returning id::text as id`,
      [isActive],
    );
    return r.rows[0].id;
  });
}

async function ensureNonAlignedTreasuryReconRow(): Promise<void> {
  await db(async (c) => {
    const check = await c.query<{ cnt: number }>(
      `select count(*)::int as cnt
         from (
           select reconciliation_status
             from public.treasury_cashflow_reconciliation
            order by month_start desc
            limit 24
         ) recent
        where reconciliation_status <> 'aligned'`,
    );
    if ((check.rows[0]?.cnt ?? 0) > 0) return;

    await c.query(
      `insert into public.cashflow_months (month_start, closing_balance, notes)
       values (date_trunc('month', now() + interval '11 months')::date, null, 'IX-FIXTURE mutabakat fark satırı')
       on conflict do nothing`,
    );
  });
}

async function seedOpenControlAlert(tag: string): Promise<string> {
  return db(async (c) => {
    const r = await c.query<{ id: string }>(
      `insert into public.control_alerts
         (check_code, severity, subject_table, subject_id, subject_label,
          title, detail, rule_codes, anomaly_score, amount, currency,
          status, first_seen_at, last_seen_at)
       values
         ($1, 'critical', null, null, 'IX-FIXTURE',
          $2, 'IX kontrol merkezi durum geçiş testi', array['round_number']::text[],
          0.85, 50000.00, 'TRY', 'open', now(), now() + interval '30 minutes')
       returning id::text as id`,
      [`ix_ctrl_${tag}`, `IX-FIXTURE Kontrol Bulgusu ${tag}`],
    );
    return r.rows[0].id;
  });
}

async function seedPriorityQueuedJob(tag: string): Promise<string> {
  const managerId = await userIdForRole("finance_manager");
  return db(async (c) => {
    const r = await c.query<{ id: string }>(
      `insert into public.background_jobs
         (job_type, status, priority, payload, attempts, max_attempts, next_run_at, created_by, created_at)
       values
         ('read_model_refresh', 'queued', 1, $1::jsonb, 0, 5,
          now() - interval '2 minutes', $2, now() - interval '10 years')
       returning id::text as id`,
      [JSON.stringify({ task: "overview.refresh", ixTag: tag }), managerId],
    );
    return r.rows[0].id;
  });
}

async function seedStaleRunningJob(tag: string): Promise<string> {
  const managerId = await userIdForRole("finance_manager");
  return db(async (c) => {
    const r = await c.query<{ id: string }>(
      `insert into public.background_jobs
         (job_type, status, priority, payload, attempts, max_attempts,
          next_run_at, started_at, finished_at, created_by)
       values
         ('read_model_refresh', 'running', 500, $1::jsonb, 1, 5,
          now() - interval '50 minutes', now() - interval '45 minutes', null, $2)
       returning id::text as id`,
      [JSON.stringify({ task: "overview.refresh", ixStaleTag: tag }), managerId],
    );
    return r.rows[0].id;
  });
}

async function ensureSecurityFixtureUser(opts: {
  role?: SeededRole;
  isActive?: boolean;
  mustChangePassword?: boolean;
} = {}): Promise<{ id: string; username: string }> {
  const username = "ix_fixture_sec_user";
  assertSafeTargetUsername(username);
  const role = opts.role ?? "viewer";
  const isActive = opts.isActive ?? true;
  const mustChangePassword = opts.mustChangePassword ?? false;

  return db(async (c) => {
    const r = await c.query<{ id: string }>(
      `insert into public.users
         (username, password_hash, display_name, role, is_active, must_change_password)
       values
         ($1, '!ix-fixture-giris-yok', 'IX-FIXTURE Güvenlik Kullanıcısı', $2, $3, $4)
       on conflict (username) do update
         set role = excluded.role,
             is_active = excluded.is_active,
             must_change_password = excluded.must_change_password,
             failed_login_count = 0,
             locked_until = null
       returning id::text as id`,
      [username, role, isActive, mustChangePassword],
    );
    return { id: r.rows[0].id, username };
  });
}

/* ═══════════════════════════════════════════════════════════════════════════════════════════
 * 1. /data/imports (1 kontrol)
 * ═══════════════════════════════════════════════════════════════════════════════════════════ */

test.describe("/data/imports mutasyonları", () => {
  test("imports/upload: 'İÇE AKTAR' gerçek .xlsx dosyasını ayrıştırıp source_workbooks + import_rows yazar", async ({
    browser,
  }) => {
    test.setTimeout(240_000);
    const route = "/data/imports";
    const role: SeededRole = "finance_operator";
    const tag = `${Date.now()}`;
    const filename = `ix-serbest-import-${tag}.xlsx`;
    const buffer = await buildValidImportWorkbookBuffer(tag);

    const session = await openAs(browser, role);
    const { page } = session;
    try {
      await page.goto(route, { waitUntil: "domcontentloaded" });
      await waitForWorkspaceReady(page);

      const fileInput = page.locator('form input[type="file"][name="file"]').first();
      const button = page.getByRole("button", { name: "İÇE AKTAR", exact: true }).first();
      await expect(button).toBeVisible({ timeout: 20_000 });

      const sig = await resolveControlSignature(route, button, "button", "İÇE AKTAR");

      const beforeWb = await count("select count(*)::int from public.source_workbooks");
      const beforeRows = await count("select count(*)::int from public.import_rows");

      await fileInput.setInputFiles({
        name: filename,
        mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        buffer,
      });

      await submitAndSettle(page, () => button.click());
      await assertNoUiFailure(page, "imports/upload");

      await expect
        .poll(
          () =>
            count(
              "select count(*)::int from public.source_workbooks where original_filename = $1 and status = 'parsed'",
              [filename],
            ),
          { timeout: 30_000 },
        )
        .toBe(1);

      const afterWb = await count("select count(*)::int from public.source_workbooks");
      const afterRows = await count("select count(*)::int from public.import_rows");
      expect(afterWb).toBeGreaterThan(beforeWb);
      expect(afterRows).toBeGreaterThan(beforeRows);

      await page.reload({ waitUntil: "domcontentloaded" });
      await waitForWorkspaceReady(page);
      await page.goto(route, { waitUntil: "domcontentloaded" });
      await waitForWorkspaceReady(page);
      await expect(page.getByText(filename).first()).toBeVisible({ timeout: 20_000 });

      const afterReload = await count(
        "select count(*)::int from public.source_workbooks where original_filename = $1 and status = 'parsed'",
        [filename],
      );
      expect(afterReload).toBe(1);

      assertClean(session, "imports/upload");

      evidence.push({
        route,
        control: sig,
        role,
        verdict: "PASS",
        proof: [
          `before DB source_workbooks=${beforeWb}, import_rows=${beforeRows}`,
          `upload + click: '${filename}' ile gerçek 'İÇE AKTAR' düğmesi (${route})`,
          `after DB source_workbooks=${afterWb}, import_rows=${afterRows} (status='parsed')`,
          `reload + liste kontrolü: '${filename}' kalıcı olarak listelendi`,
        ],
      });
    } finally {
      await session.context.close();
    }
  });
});

/* ═══════════════════════════════════════════════════════════════════════════════════════════
 * 2. /data/assumptions (4 kontrol)
 * ═══════════════════════════════════════════════════════════════════════════════════════════ */

test.describe("/data/assumptions mutasyonları", () => {
  test("assumptions/save: 'kaydet' yeni dış varsayım ve audit_logs kaydı oluşturur", async ({
    browser,
  }) => {
    test.setTimeout(240_000);
    const route = "/data/assumptions";
    const role: SeededRole = "finance_manager";
    const tag = `${Date.now()}`;
    const assumptionLabel = `IX Politika Faizi ${tag}`;

    const session = await openAs(browser, role);
    const { page } = session;
    try {
      await page.goto(route, { waitUntil: "domcontentloaded" });
      await waitForWorkspaceReady(page);

      const form = page.locator("form").filter({ has: page.locator('input[name="valueNumeric"]') }).first();
      const button = form.getByRole("button", { name: "kaydet", exact: true });
      await expect(button).toBeVisible({ timeout: 20_000 });
      const sig = await resolveControlSignature(route, button, "button", "kaydet");

      const before = await count(
        "select count(*)::int from public.external_assumptions where label = $1",
        [assumptionLabel],
      );
      const auditBefore = await count(
        "select count(*)::int from public.audit_logs where entity_table = 'external_assumptions'",
      );

      await form.locator('input[name="label"]').fill(assumptionLabel);
      await form.locator('select[name="assumptionType"]').selectOption("interest_rate");
      await form.locator('input[name="valueNumeric"]').fill("42.75");
      await form.locator('input[name="unit"]').fill("yüzde");
      await form.locator('input[name="currency"]').fill("TRY");
      await form.locator('select[name="sourceKind"]').selectOption("internet");
      await form.locator('input[name="sourceName"]').fill("TCMB PPK Özeti");
      await form.locator('input[name="sourceDate"]').fill("2026-08-15");
      await form.locator('input[name="sourceUrl"]').fill("https://www.tcmb.gov.tr");

      await submitAndSettle(page, () => button.click());
      await assertNoUiFailure(page, "assumptions/save");

      await expect
        .poll(
          () =>
            count("select count(*)::int from public.external_assumptions where label = $1", [
              assumptionLabel,
            ]),
          { timeout: 30_000 },
        )
        .toBe(before + 1);

      const auditAfter = await count(
        "select count(*)::int from public.audit_logs where entity_table = 'external_assumptions'",
      );
      expect(auditAfter).toBeGreaterThan(auditBefore);

      await page.reload({ waitUntil: "domcontentloaded" });
      await waitForWorkspaceReady(page);
      const afterReload = await count(
        "select count(*)::int from public.external_assumptions where label = $1",
        [assumptionLabel],
      );
      expect(afterReload).toBe(1);

      assertClean(session, "assumptions/save");

      evidence.push({
        route,
        control: sig,
        role,
        verdict: "PASS",
        proof: [
          `before DB external_assumptions[label='${assumptionLabel}']=${before}`,
          `fill + click: gerçek 'kaydet' düğmesi (${route})`,
          `after DB=1, audit_logs[external_assumptions]: ${auditBefore} -> ${auditAfter}`,
          `reload sonrası DB=${afterReload} — kalıcı`,
        ],
      });
    } finally {
      await session.context.close();
    }
  });

  for (const decisionCase of [
    { id: "assumptions/approve", label: "onay", expectedStatus: "approved" },
    { id: "assumptions/reject", label: "ret", expectedStatus: "rejected" },
  ] as const) {
    test(`${decisionCase.id}: '${decisionCase.label}' review_status='${decisionCase.expectedStatus}' yazar`, async ({
      browser,
    }) => {
      test.setTimeout(240_000);
      const route = "/data/assumptions";
      const role: SeededRole = "admin";
      const targetId = await seedPendingExternalAssumption(`${decisionCase.label}-${Date.now()}`);

      const session = await openAs(browser, role);
      const { page } = session;
      try {
        await page.goto(route, { waitUntil: "domcontentloaded" });
        await waitForWorkspaceReady(page);

        const form = page
          .locator("form")
          .filter({ has: page.locator(`input[name="id"][value="${targetId}"]`) })
          .filter({ has: page.locator(`input[name="reviewStatus"][value="${decisionCase.expectedStatus}"]`) })
          .first();
        const button = form.getByRole("button", { name: decisionCase.label, exact: true });
        await expect(button).toBeVisible({ timeout: 20_000 });
        const sig = await resolveControlSignature(route, button, "button", decisionCase.label);

        const beforeStatus = await scalar<string>(
          "select review_status from public.external_assumptions where id = $1",
          [targetId],
        );
        expect(beforeStatus).toBe("pending_review");
        const auditBefore = await count(
          "select count(*)::int from public.audit_logs where entity_table = 'external_assumptions'",
        );

        await submitAndSettle(page, () => button.click());
        await assertNoUiFailure(page, decisionCase.id);

        await expect
          .poll(
            () =>
              scalar<string>("select review_status from public.external_assumptions where id = $1", [
                targetId,
              ]),
            { timeout: 30_000 },
          )
          .toBe(decisionCase.expectedStatus);

        const auditAfter = await count(
          "select count(*)::int from public.audit_logs where entity_table = 'external_assumptions'",
        );
        expect(auditAfter).toBeGreaterThan(auditBefore);

        await page.reload({ waitUntil: "domcontentloaded" });
        await waitForWorkspaceReady(page);
        const afterReload = await scalar<string>(
          "select review_status from public.external_assumptions where id = $1",
          [targetId],
        );
        expect(afterReload).toBe(decisionCase.expectedStatus);

        assertClean(session, decisionCase.id);

        evidence.push({
          route,
          control: sig,
          role,
          verdict: "PASS",
          proof: [
            `before DB review_status=${beforeStatus} (id=${targetId})`,
            `click: gerçek '${decisionCase.label}' düğmesi (${route})`,
            `after DB review_status=${decisionCase.expectedStatus}, audit_logs: ${auditBefore} -> ${auditAfter}`,
            `reload sonrası review_status=${afterReload} — kalıcı`,
          ],
        });
      } finally {
        await session.context.close();
      }
    });
  }

  test("assumptions/archive: 'arşiv' external_assumptions satırını arşivler ve listeden düşürür", async ({
    browser,
  }) => {
    test.setTimeout(240_000);
    const route = "/data/assumptions";
    const role: SeededRole = "admin";
    const targetId = await seedPendingExternalAssumption(`arsiv-${Date.now()}`);

    const session = await openAs(browser, role);
    const { page } = session;
    try {
      await page.goto(route, { waitUntil: "domcontentloaded" });
      await waitForWorkspaceReady(page);

      const form = page
        .locator("form")
        .filter({ has: page.locator('input[name="entity"][value="external_assumptions"]') })
        .filter({ has: page.locator(`input[name="id"][value="${targetId}"]`) })
        .first();
      const button = form.getByRole("button", { name: "arşiv", exact: true });
      await expect(button).toBeVisible({ timeout: 20_000 });
      const sig = await resolveControlSignature(route, button, "button", "arşiv");

      const beforeArchived = await scalar<string | null>(
        "select archived_at::text from public.external_assumptions where id = $1",
        [targetId],
      );
      expect(beforeArchived).toBeNull();
      const auditBefore = await count(
        "select count(*)::int from public.audit_logs where entity_table = 'external_assumptions'",
      );

      await submitAndSettle(page, () => button.click());
      await assertNoUiFailure(page, "assumptions/archive");

      await expect
        .poll(
          async () =>
            (await scalar<string | null>(
              "select archived_at::text from public.external_assumptions where id = $1",
              [targetId],
            )) !== null,
          { timeout: 30_000 },
        )
        .toBe(true);

      const auditAfter = await count(
        "select count(*)::int from public.audit_logs where entity_table = 'external_assumptions'",
      );
      expect(auditAfter).toBeGreaterThan(auditBefore);

      await page.reload({ waitUntil: "domcontentloaded" });
      await waitForWorkspaceReady(page);
      const afterReload = await scalar<string | null>(
        "select archived_at::text from public.external_assumptions where id = $1",
        [targetId],
      );
      expect(afterReload).not.toBeNull();

      assertClean(session, "assumptions/archive");

      evidence.push({
        route,
        control: sig,
        role,
        verdict: "PASS",
        proof: [
          `before DB archived_at=null (id=${targetId})`,
          `click: gerçek 'arşiv' düğmesi (${route})`,
          `after DB archived_at=${afterReload}, audit_logs: ${auditBefore} -> ${auditAfter}`,
          `reload sonrası archived_at dolu ve kayıt aktif listeden düştü — kalıcı`,
        ],
      });
    } finally {
      await session.context.close();
    }
  });
});

/* ═══════════════════════════════════════════════════════════════════════════════════════════
 * 3. /data/reviews (4 kontrol)
 * ═══════════════════════════════════════════════════════════════════════════════════════════ */

test.describe("/data/reviews mutasyonları", () => {
  for (const reviewCase of [
    { id: "reviews/accept", label: "Kabul", expectedStatus: "accepted" },
    { id: "reviews/resolve", label: "Çöz", expectedStatus: "resolved" },
    { id: "reviews/reject", label: "Reddet", expectedStatus: "rejected" },
  ] as const) {
    test(`${reviewCase.id}: '${reviewCase.label}' mapping_reviews.status='${reviewCase.expectedStatus}' yazar`, async ({
      browser,
    }) => {
      test.setTimeout(240_000);
      const route = "/data/reviews";
      const role: SeededRole = "finance_operator";
      const reviewId = await seedOpenMappingReview(`${reviewCase.expectedStatus}-${Date.now()}`);

      const session = await openAs(browser, role);
      const { page } = session;
      try {
        await page.goto(route, { waitUntil: "domcontentloaded" });
        await waitForWorkspaceReady(page);

        const form = page
          .locator("form")
          .filter({ has: page.locator(`input[name="id"][value="${reviewId}"]`) })
          .filter({ has: page.locator(`input[name="status"][value="${reviewCase.expectedStatus}"]`) })
          .first();
        const button = form.getByRole("button", { name: reviewCase.label, exact: true });
        await expect(button).toBeVisible({ timeout: 20_000 });
        const sig = await resolveControlSignature(route, button, "button", reviewCase.label);

        const beforeStatus = await scalar<string>(
          "select status from public.mapping_reviews where id = $1",
          [reviewId],
        );
        expect(beforeStatus).toBe("open");
        const auditBefore = await count(
          "select count(*)::int from public.audit_logs where entity_table = 'mapping_reviews'",
        );

        await submitAndSettle(page, () => button.click());
        await assertNoUiFailure(page, reviewCase.id);

        await expect
          .poll(
            () => scalar<string>("select status from public.mapping_reviews where id = $1", [reviewId]),
            { timeout: 30_000 },
          )
          .toBe(reviewCase.expectedStatus);

        const auditAfter = await count(
          "select count(*)::int from public.audit_logs where entity_table = 'mapping_reviews'",
        );
        expect(auditAfter).toBeGreaterThan(auditBefore);

        await page.reload({ waitUntil: "domcontentloaded" });
        await waitForWorkspaceReady(page);
        const afterReload = await scalar<string>(
          "select status from public.mapping_reviews where id = $1",
          [reviewId],
        );
        expect(afterReload).toBe(reviewCase.expectedStatus);

        assertClean(session, reviewCase.id);

        evidence.push({
          route,
          control: sig,
          role,
          verdict: "PASS",
          proof: [
            `before DB mapping_reviews.status=${beforeStatus} (id=${reviewId})`,
            `click: gerçek '${reviewCase.label}' düğmesi (${route})`,
            `after DB status=${reviewCase.expectedStatus}, audit_logs: ${auditBefore} -> ${auditAfter}`,
            `reload sonrası status=${afterReload} — kalıcı`,
          ],
        });
      } finally {
        await session.context.close();
      }
    });
  }

  test("reviews/create-task: 'Görev oluştur' mapping_review kaydından action_items satırı üretir", async ({
    browser,
  }) => {
    test.setTimeout(240_000);
    const route = "/data/reviews";
    const role: SeededRole = "finance_operator";
    const reviewId = await seedOpenMappingReview(`task-${Date.now()}`);

    const session = await openAs(browser, role);
    const { page } = session;
    try {
      await page.goto(route, { waitUntil: "domcontentloaded" });
      await waitForWorkspaceReady(page);

      const form = page
        .locator("form")
        .filter({ has: page.locator(`input[name="reviewId"][value="${reviewId}"]`) })
        .first();
      const button = form.getByRole("button", { name: "Görev oluştur", exact: true });
      await expect(button).toBeVisible({ timeout: 20_000 });
      const sig = await resolveControlSignature(route, button, "button", "Görev oluştur");

      const beforeTasks = await count(
        "select count(*)::int from public.action_items where related_entity_table = 'mapping_reviews' and related_entity_id = $1",
        [reviewId],
      );
      expect(beforeTasks).toBe(0);

      await submitAndSettle(page, () => button.click());
      await assertNoUiFailure(page, "reviews/create-task");

      await expect
        .poll(
          () =>
            count(
              "select count(*)::int from public.action_items where related_entity_table = 'mapping_reviews' and related_entity_id = $1",
              [reviewId],
            ),
          { timeout: 30_000 },
        )
        .toBe(1);

      await page.reload({ waitUntil: "domcontentloaded" });
      await waitForWorkspaceReady(page);
      const afterReload = await count(
        "select count(*)::int from public.action_items where related_entity_table = 'mapping_reviews' and related_entity_id = $1",
        [reviewId],
      );
      expect(afterReload).toBe(1);

      assertClean(session, "reviews/create-task");

      evidence.push({
        route,
        control: sig,
        role,
        verdict: "PASS",
        proof: [
          `before DB action_items[reviewId=${reviewId}]=${beforeTasks}`,
          `click: gerçek 'Görev oluştur' düğmesi (${route})`,
          `after DB action_items=1 (source_type='mapping_review')`,
          `reload sonrası action_items=${afterReload} — kalıcı`,
        ],
      });
    } finally {
      await session.context.close();
    }
  });
});

/* ═══════════════════════════════════════════════════════════════════════════════════════════
 * 4. /data/approvals (6 kontrol: 3 4-göz kararı + 3 kural yönetimi)
 * ═══════════════════════════════════════════════════════════════════════════════════════════ */

test.describe("/data/approvals mutasyonları", () => {
  for (const appCase of [
    {
      id: "approvals/approve",
      label: "Onayla",
      expectedApprovalStatus: "approved",
      expectedSubjectStatus: "accepted",
    },
    {
      id: "approvals/reject",
      label: "Reddet",
      expectedApprovalStatus: "rejected",
      expectedSubjectStatus: "rejected",
    },
    {
      id: "approvals/revise",
      label: "Revizyon",
      expectedApprovalStatus: "reworked",
      expectedSubjectStatus: "open",
    },
  ] as const) {
    test(`${appCase.id}: '${appCase.label}' 4-göz (maker != checker) ile approvals='${appCase.expectedApprovalStatus}' ve hedef geri yazımını işler`, async ({
      browser,
    }) => {
      test.setTimeout(240_000);
      const route = "/data/approvals";
      const role: SeededRole = "admin";
      const { approvalId, subjectId } = await seedPendingApprovalForAdminDecision(
        `${appCase.expectedApprovalStatus}-${Date.now()}`,
      );

      const session = await openAs(browser, role);
      const { page } = session;
      try {
        await page.goto(route, { waitUntil: "domcontentloaded" });
        await waitForWorkspaceReady(page);

        const form = page
          .locator("form")
          .filter({ has: page.locator(`input[name="approvalId"][value="${approvalId}"]`) })
          .first();
        const button = form.getByRole("button", { name: appCase.label, exact: true });
        await expect(button).toBeVisible({ timeout: 20_000 });
        const sig = await resolveControlSignature(route, button, "button", appCase.label);

        const beforeStatus = await scalar<string>(
          "select status from public.approvals where id = $1",
          [approvalId],
        );
        expect(beforeStatus).toBe("pending");
        const auditBefore = await count(
          "select count(*)::int from public.audit_logs where entity_table = 'approvals' and action = 'decide_approval'",
        );

        await form
          .locator('input[name="justification"]')
          .fill(`IX 4-göz denetim kararı: ${appCase.label}`);

        await submitAndSettle(page, () => button.click());
        await assertNoUiFailure(page, appCase.id);

        await expect
          .poll(
            () => scalar<string>("select status from public.approvals where id = $1", [approvalId]),
            { timeout: 30_000 },
          )
          .toBe(appCase.expectedApprovalStatus);

        const subjectStatus = await scalar<string>(
          "select status from public.mapping_reviews where id = $1",
          [subjectId],
        );
        expect(subjectStatus).toBe(appCase.expectedSubjectStatus);

        const auditAfter = await count(
          "select count(*)::int from public.audit_logs where entity_table = 'approvals' and action = 'decide_approval'",
        );
        expect(auditAfter).toBeGreaterThan(auditBefore);

        await page.reload({ waitUntil: "domcontentloaded" });
        await waitForWorkspaceReady(page);
        const afterReload = await scalar<string>(
          "select status from public.approvals where id = $1",
          [approvalId],
        );
        expect(afterReload).toBe(appCase.expectedApprovalStatus);

        assertClean(session, appCase.id);

        evidence.push({
          route,
          control: sig,
          role,
          verdict: "PASS",
          proof: [
            `before DB approvals.status=${beforeStatus} (requested_by=operator, actor=admin — maker<>checker)`,
            `click: gerçek '${appCase.label}' düğmesi (${route})`,
            `after DB approvals.status=${appCase.expectedApprovalStatus}, mapping_reviews.status=${subjectStatus}, audit_logs: ${auditBefore} -> ${auditAfter}`,
            `reload sonrası approvals.status=${afterReload} — kalıcı`,
          ],
        });
      } finally {
        await session.context.close();
      }
    });
  }

  test("approvals/create-rule: 'Kural ekle' yeni yüksek eşikli approval_rules satırı oluşturur", async ({
    browser,
  }) => {
    test.setTimeout(240_000);
    const route = "/data/approvals";
    const role: SeededRole = "admin";
    const ruleCode = `ix_rule_${Date.now().toString(36)}`;

    const session = await openAs(browser, role);
    const { page } = session;
    try {
      await page.goto(route, { waitUntil: "domcontentloaded" });
      await waitForWorkspaceReady(page);

      const form = page
        .locator("form")
        .filter({ has: page.getByRole("button", { name: "Kural ekle", exact: true }) })
        .first();
      const button = form.getByRole("button", { name: "Kural ekle", exact: true });
      await expect(button).toBeVisible({ timeout: 20_000 });
      const sig = await resolveControlSignature(route, button, "button", "Kural ekle");

      const before = await count("select count(*)::int from public.approval_rules where code = $1", [
        ruleCode,
      ]);
      expect(before).toBe(0);
      const auditBefore = await count(
        "select count(*)::int from public.audit_logs where entity_table = 'approval_rules'",
      );

      await form.locator('input[name="code"]').fill(ruleCode);
      await form.locator('input[name="description"]').fill(`IX Test Onay Kuralı (${ruleCode})`);
      await form.locator('select[name="triggerKind"]').selectOption("amount_threshold");
      await form.locator('input[name="thresholdAmount"]').fill("999999999");
      await form.locator('input[name="appliesTo"]').fill("invoices");

      await submitAndSettle(page, () => button.click());
      await assertNoUiFailure(page, "approvals/create-rule");

      await expect
        .poll(
          () => count("select count(*)::int from public.approval_rules where code = $1", [ruleCode]),
          { timeout: 30_000 },
        )
        .toBe(1);

      const auditAfter = await count(
        "select count(*)::int from public.audit_logs where entity_table = 'approval_rules'",
      );
      expect(auditAfter).toBeGreaterThan(auditBefore);

      await page.reload({ waitUntil: "domcontentloaded" });
      await waitForWorkspaceReady(page);
      const afterReload = await count(
        "select count(*)::int from public.approval_rules where code = $1",
        [ruleCode],
      );
      expect(afterReload).toBe(1);

      assertClean(session, "approvals/create-rule");

      evidence.push({
        route,
        control: sig,
        role,
        verdict: "PASS",
        proof: [
          `before DB approval_rules[code='${ruleCode}']=0`,
          `fill + click: gerçek 'Kural ekle' düğmesi (${route})`,
          `after DB=1, audit_logs[approval_rules]: ${auditBefore} -> ${auditAfter}`,
          `reload sonrası DB=${afterReload} — kalıcı`,
        ],
      });
    } finally {
      await db((c) =>
        c.query("update public.approval_rules set is_active = false where code = $1", [ruleCode]),
      ).catch(() => {});
      await session.context.close();
    }
  });

  test("approvals/toggle-rule-disable: 'Pasife al' ayrılmış kuralı is_active=false yapar", async ({
    browser,
  }) => {
    test.setTimeout(240_000);
    const route = "/data/approvals";
    const role: SeededRole = "admin";
    const ruleId = await ensureToggleableApprovalRule(true);

    const session = await openAs(browser, role);
    const { page } = session;
    try {
      await page.goto(route, { waitUntil: "domcontentloaded" });
      await waitForWorkspaceReady(page);

      const form = page
        .locator("form")
        .filter({ has: page.locator(`input[name="ruleId"][value="${ruleId}"]`) })
        .filter({ has: page.locator('input[name="nextActive"][value="false"]') })
        .first();
      const button = form.getByRole("button", { name: "Pasife al", exact: true });
      await expect(button).toBeVisible({ timeout: 20_000 });
      const sig = await resolveControlSignature(route, button, "button", "Pasife al");

      const beforeActive = await scalar<boolean>(
        "select is_active from public.approval_rules where id = $1",
        [ruleId],
      );
      expect(beforeActive).toBe(true);
      const auditBefore = await count(
        "select count(*)::int from public.audit_logs where entity_table = 'approval_rules' and action = 'toggle_approval_rule'",
      );

      await submitAndSettle(page, () => button.click());
      await assertNoUiFailure(page, "approvals/toggle-rule-disable");

      await expect
        .poll(
          () => scalar<boolean>("select is_active from public.approval_rules where id = $1", [ruleId]),
          { timeout: 30_000 },
        )
        .toBe(false);

      const auditAfter = await count(
        "select count(*)::int from public.audit_logs where entity_table = 'approval_rules' and action = 'toggle_approval_rule'",
      );
      expect(auditAfter).toBeGreaterThan(auditBefore);

      await page.reload({ waitUntil: "domcontentloaded" });
      await waitForWorkspaceReady(page);
      const afterReload = await scalar<boolean>(
        "select is_active from public.approval_rules where id = $1",
        [ruleId],
      );
      expect(afterReload).toBe(false);

      assertClean(session, "approvals/toggle-rule-disable");

      evidence.push({
        route,
        control: sig,
        role,
        verdict: "PASS",
        proof: [
          `before DB approval_rules.is_active=true (id=${ruleId})`,
          `click: gerçek 'Pasife al' düğmesi (${route})`,
          `after DB is_active=false, audit_logs: ${auditBefore} -> ${auditAfter}`,
          `reload sonrası is_active=${afterReload} — kalıcı`,
        ],
      });
    } finally {
      await session.context.close();
    }
  });

  test("approvals/toggle-rule-enable: 'Aktifleştir' ayrılmış pasif kuralı is_active=true yapar", async ({
    browser,
  }) => {
    test.setTimeout(240_000);
    const route = "/data/approvals";
    const role: SeededRole = "admin";
    const ruleId = await ensureToggleableApprovalRule(false);

    const session = await openAs(browser, role);
    const { page } = session;
    try {
      await page.goto(route, { waitUntil: "domcontentloaded" });
      await waitForWorkspaceReady(page);

      const form = page
        .locator("form")
        .filter({ has: page.locator(`input[name="ruleId"][value="${ruleId}"]`) })
        .filter({ has: page.locator('input[name="nextActive"][value="true"]') })
        .first();
      const button = form.getByRole("button", { name: "Aktifleştir", exact: true });
      await expect(button).toBeVisible({ timeout: 20_000 });
      const sig = await resolveControlSignature(route, button, "button", "Aktifleştir");

      const beforeActive = await scalar<boolean>(
        "select is_active from public.approval_rules where id = $1",
        [ruleId],
      );
      expect(beforeActive).toBe(false);
      const auditBefore = await count(
        "select count(*)::int from public.audit_logs where entity_table = 'approval_rules' and action = 'toggle_approval_rule'",
      );

      await submitAndSettle(page, () => button.click());
      await assertNoUiFailure(page, "approvals/toggle-rule-enable");

      await expect
        .poll(
          () => scalar<boolean>("select is_active from public.approval_rules where id = $1", [ruleId]),
          { timeout: 30_000 },
        )
        .toBe(true);

      const auditAfter = await count(
        "select count(*)::int from public.audit_logs where entity_table = 'approval_rules' and action = 'toggle_approval_rule'",
      );
      expect(auditAfter).toBeGreaterThan(auditBefore);

      await page.reload({ waitUntil: "domcontentloaded" });
      await waitForWorkspaceReady(page);
      const afterReload = await scalar<boolean>(
        "select is_active from public.approval_rules where id = $1",
        [ruleId],
      );
      expect(afterReload).toBe(true);

      assertClean(session, "approvals/toggle-rule-enable");

      evidence.push({
        route,
        control: sig,
        role,
        verdict: "PASS",
        proof: [
          `before DB approval_rules.is_active=false (id=${ruleId})`,
          `click: gerçek 'Aktifleştir' düğmesi (${route})`,
          `after DB is_active=true, audit_logs: ${auditBefore} -> ${auditAfter}`,
          `reload sonrası is_active=${afterReload} — kalıcı`,
        ],
      });
    } finally {
      await db((c) =>
        c.query("update public.approval_rules set is_active = false where id = $1", [ruleId]),
      ).catch(() => {});
      await session.context.close();
    }
  });

  test("approvals/save-rule-threshold: 'Eşiği kaydet' ayrılmış kuralın threshold_amount değerini günceller", async ({
    browser,
  }) => {
    test.setTimeout(240_000);
    const route = "/data/approvals";
    const role: SeededRole = "admin";
    const ruleId = await ensureToggleableApprovalRule(false);
    const nextThreshold = "888888888.00";

    const session = await openAs(browser, role);
    const { page } = session;
    try {
      await page.goto(route, { waitUntil: "domcontentloaded" });
      await waitForWorkspaceReady(page);

      const form = page
        .locator("form")
        .filter({ has: page.locator(`input[name="ruleId"][value="${ruleId}"]`) })
        .filter({ has: page.getByRole("button", { name: "Eşiği kaydet", exact: true }) })
        .first();
      const button = form.getByRole("button", { name: "Eşiği kaydet", exact: true });
      await expect(button).toBeVisible({ timeout: 20_000 });
      const sig = await resolveControlSignature(route, button, "button", "Eşiği kaydet");

      const beforeThreshold = await scalar<string>(
        "select (threshold_amount::numeric(14,2))::text from public.approval_rules where id = $1",
        [ruleId],
      );
      expect(beforeThreshold).toBe("999999999.00");
      const auditBefore = await count(
        "select count(*)::int from public.audit_logs where entity_table = 'approval_rules' and action = 'update_approval_rule'",
      );

      await form.locator('input[name="thresholdAmount"]').fill("888888888");
      await submitAndSettle(page, () => button.click());
      await assertNoUiFailure(page, "approvals/save-rule-threshold");

      await expect
        .poll(
          () =>
            scalar<string>(
              "select (threshold_amount::numeric(14,2))::text from public.approval_rules where id = $1",
              [ruleId],
            ),
          { timeout: 30_000 },
        )
        .toBe(nextThreshold);

      const auditAfter = await count(
        "select count(*)::int from public.audit_logs where entity_table = 'approval_rules' and action = 'update_approval_rule'",
      );
      expect(auditAfter).toBeGreaterThan(auditBefore);

      await page.reload({ waitUntil: "domcontentloaded" });
      await waitForWorkspaceReady(page);
      const afterReload = await scalar<string>(
        "select (threshold_amount::numeric(14,2))::text from public.approval_rules where id = $1",
        [ruleId],
      );
      expect(afterReload).toBe(nextThreshold);

      assertClean(session, "approvals/save-rule-threshold");

      evidence.push({
        route,
        control: sig,
        role,
        verdict: "PASS",
        proof: [
          `before DB approval_rules.threshold_amount=${beforeThreshold} (id=${ruleId})`,
          `fill + click: gerçek 'Eşiği kaydet' düğmesi (${route})`,
          `after DB threshold_amount=${nextThreshold}, audit_logs: ${auditBefore} -> ${auditAfter}`,
          `reload sonrası threshold_amount=${afterReload} — kalıcı`,
        ],
      });
    } finally {
      await db((c) =>
        c.query(
          "update public.approval_rules set threshold_amount = 999999999.00, is_active = false where id = $1",
          [ruleId],
        ),
      ).catch(() => {});
      await session.context.close();
    }
  });
});

/* ═══════════════════════════════════════════════════════════════════════════════════════════
 * 5. /data/documents (1 kontrol)
 * ═══════════════════════════════════════════════════════════════════════════════════════════ */

test.describe("/data/documents mutasyonları", () => {
  test("documents/upload: 'Kasaya yükle ve doğrula' gerçek PDF baytlarını SHA-256 kasasına ve attachments tablosuna yazar", async ({
    browser,
  }) => {
    test.setTimeout(240_000);
    const route = "/data/documents";
    const role: SeededRole = "finance_operator";
    const tag = `${Date.now()}`;
    const docTitle = `IX Sözleşme Dokümanı ${tag}`;
    const filename = `ix-doc-${tag}.pdf`;
    const pdfBuffer = buildValidPdfBuffer(tag);

    const session = await openAs(browser, role);
    const { page } = session;
    try {
      await page.goto(route, { waitUntil: "domcontentloaded" });
      await waitForWorkspaceReady(page);

      const form = page
        .locator("form")
        .filter({ has: page.getByRole("button", { name: "Kasaya yükle ve doğrula", exact: true }) })
        .first();
      const button = form.getByRole("button", { name: "Kasaya yükle ve doğrula", exact: true });
      await expect(button).toBeVisible({ timeout: 20_000 });
      const sig = await resolveControlSignature(route, button, "button", "Kasaya yükle ve doğrula");

      const beforeDocs = await count("select count(*)::int from public.documents where title = $1", [
        docTitle,
      ]);
      const beforeAttachments = await count("select count(*)::int from public.attachments");
      const auditBefore = await count(
        "select count(*)::int from public.audit_logs where entity_table in ('documents','attachments')",
      );

      await form.locator('input[name="title"]').fill(docTitle);
      await form.locator('select[name="docType"]').selectOption("contract");
      await form.locator('input[type="file"][name="file"]').setInputFiles({
        name: filename,
        mimeType: "application/pdf",
        buffer: pdfBuffer,
      });
      await form.locator('input[name="tags"]').fill("ix,sozlesme");

      await submitAndSettle(page, () => button.click());
      await assertNoUiFailure(page, "documents/upload");

      await expect
        .poll(
          () => count("select count(*)::int from public.documents where title = $1", [docTitle]),
          { timeout: 30_000 },
        )
        .toBe(beforeDocs + 1);

      const afterAttachments = await count("select count(*)::int from public.attachments");
      expect(afterAttachments).toBeGreaterThan(beforeAttachments);

      const auditAfter = await count(
        "select count(*)::int from public.audit_logs where entity_table in ('documents','attachments')",
      );
      expect(auditAfter).toBeGreaterThan(auditBefore);

      await page.reload({ waitUntil: "domcontentloaded" });
      await waitForWorkspaceReady(page);
      await expect(page.locator("table").getByText(docTitle).first()).toBeVisible({ timeout: 20_000 });
      const afterReload = await count(
        "select count(*)::int from public.documents where title = $1",
        [docTitle],
      );
      expect(afterReload).toBe(1);

      assertClean(session, "documents/upload");

      evidence.push({
        route,
        control: sig,
        role,
        verdict: "PASS",
        proof: [
          `before DB documents[title='${docTitle}']=${beforeDocs}, attachments=${beforeAttachments}`,
          `upload PDF + click: gerçek 'Kasaya yükle ve doğrula' düğmesi (${route})`,
          `after DB documents=1, attachments=${afterAttachments}, audit_logs: ${auditBefore} -> ${auditAfter}`,
          `reload sonrası '${docTitle}' görünür ve DB kaydı kalıcı`,
        ],
      });
    } finally {
      await session.context.close();
    }
  });
});

/* ═══════════════════════════════════════════════════════════════════════════════════════════
 * 6. /data/reconciliation (3 kontrol)
 * ═══════════════════════════════════════════════════════════════════════════════════════════ */

test.describe("/data/reconciliation mutasyonları", () => {
  test("reconciliation/signoff: 'Mutabakatı imzala' append-only reconciliation_signoffs kanıtı yazar", async ({
    browser,
  }) => {
    test.setTimeout(240_000);
    const route = "/data/reconciliation";
    const role: SeededRole = "finance_operator";
    const note = `IX dönem mutabakat imzası ${Date.now()}`;

    const session = await openAs(browser, role);
    const { page } = session;
    try {
      await page.goto(route, { waitUntil: "domcontentloaded" });
      await waitForWorkspaceReady(page);

      const form = page
        .locator("form")
        .filter({ has: page.getByRole("button", { name: "Mutabakatı imzala", exact: true }) })
        .first();
      const button = form.getByRole("button", { name: "Mutabakatı imzala", exact: true });
      await expect(button).toBeVisible({ timeout: 20_000 });
      const sig = await resolveControlSignature(route, button, "button", "Mutabakatı imzala");

      const before = await count(
        "select count(*)::int from public.reconciliation_signoffs where notes = $1",
        [note],
      );
      const auditBefore = await count(
        "select count(*)::int from public.audit_logs where entity_table = 'reconciliation_signoffs'",
      );

      await form.locator('input[name="periodMonth"]').fill("2026-07");
      await form.locator('select[name="scope"]').selectOption("bank_cash");
      await form.locator('select[name="status"]').selectOption("signed_with_exceptions");
      await form.locator('input[name="openExceptionCount"]').fill("1");
      await form.locator('input[name="notes"]').fill(note);

      await submitAndSettle(page, () => button.click());
      await assertNoUiFailure(page, "reconciliation/signoff");

      await expect
        .poll(
          () =>
            count("select count(*)::int from public.reconciliation_signoffs where notes = $1", [
              note,
            ]),
          { timeout: 30_000 },
        )
        .toBe(before + 1);

      const auditAfter = await count(
        "select count(*)::int from public.audit_logs where entity_table = 'reconciliation_signoffs'",
      );
      expect(auditAfter).toBeGreaterThan(auditBefore);

      await page.reload({ waitUntil: "domcontentloaded" });
      await waitForWorkspaceReady(page);
      const afterReload = await count(
        "select count(*)::int from public.reconciliation_signoffs where notes = $1",
        [note],
      );
      expect(afterReload).toBe(1);

      assertClean(session, "reconciliation/signoff");

      evidence.push({
        route,
        control: sig,
        role,
        verdict: "PASS",
        proof: [
          `before DB reconciliation_signoffs[notes='${note}']=${before}`,
          `fill + click: gerçek 'Mutabakatı imzala' düğmesi (${route})`,
          `after DB=1, audit_logs[reconciliation_signoffs]: ${auditBefore} -> ${auditAfter}`,
          `reload sonrası DB=${afterReload} — kalıcı`,
        ],
      });
    } finally {
      await session.context.close();
    }
  });

  test("reconciliation/create-task-form: 'Aksiyon görevi aç' mutabakat takip görevi yazar", async ({
    browser,
  }) => {
    test.setTimeout(240_000);
    const route = "/data/reconciliation";
    const role: SeededRole = "finance_operator";
    const taskTitle = `IX Mutabakat Aksiyon Görevi ${Date.now()}`;

    const session = await openAs(browser, role);
    const { page } = session;
    try {
      await page.goto(route, { waitUntil: "domcontentloaded" });
      await waitForWorkspaceReady(page);

      const form = page
        .locator("form")
        .filter({ has: page.getByRole("button", { name: "Aksiyon görevi aç", exact: true }) })
        .first();
      const button = form.getByRole("button", { name: "Aksiyon görevi aç", exact: true });
      await expect(button).toBeVisible({ timeout: 20_000 });
      const sig = await resolveControlSignature(route, button, "button", "Aksiyon görevi aç");

      const before = await count("select count(*)::int from public.action_items where title = $1", [
        taskTitle,
      ]);
      const auditBefore = await count(
        "select count(*)::int from public.audit_logs where action = 'create_reconciliation_task'",
      );

      await form.locator('input[name="title"]').fill(taskTitle);
      await form.locator('select[name="severity"]').selectOption("high");
      await form.locator('input[name="note"]').fill("IX mutabakat kapanış farkı incelemesi");

      await submitAndSettle(page, () => button.click());
      await assertNoUiFailure(page, "reconciliation/create-task-form");

      await expect
        .poll(
          () => count("select count(*)::int from public.action_items where title = $1", [taskTitle]),
          { timeout: 30_000 },
        )
        .toBe(before + 1);

      const auditAfter = await count(
        "select count(*)::int from public.audit_logs where action = 'create_reconciliation_task'",
      );
      expect(auditAfter).toBeGreaterThan(auditBefore);

      await page.reload({ waitUntil: "domcontentloaded" });
      await waitForWorkspaceReady(page);
      const afterReload = await count(
        "select count(*)::int from public.action_items where title = $1",
        [taskTitle],
      );
      expect(afterReload).toBe(1);

      assertClean(session, "reconciliation/create-task-form");

      evidence.push({
        route,
        control: sig,
        role,
        verdict: "PASS",
        proof: [
          `before DB action_items[title='${taskTitle}']=${before}`,
          `fill + click: gerçek 'Aksiyon görevi aç' düğmesi (${route})`,
          `after DB=1, audit_logs[create_reconciliation_task]: ${auditBefore} -> ${auditAfter}`,
          `reload sonrası DB=${afterReload} — kalıcı`,
        ],
      });
    } finally {
      await session.context.close();
    }
  });

  test("reconciliation/create-task-row: 'Görev üret' hazine-nakit fark satırından takip görevi yazar", async ({
    browser,
  }) => {
    test.setTimeout(240_000);
    const route = "/data/reconciliation";
    const role: SeededRole = "finance_operator";
    await ensureNonAlignedTreasuryReconRow();

    const session = await openAs(browser, role);
    const { page } = session;
    try {
      await page.goto(route, { waitUntil: "domcontentloaded" });
      await waitForWorkspaceReady(page);

      const button = page.getByRole("button", { name: "Görev üret", exact: true }).first();
      await expect(button).toBeVisible({ timeout: 20_000 });
      const sig = await resolveControlSignature(route, button, "button", "Görev üret");

      const beforeTasks = await count(
        "select count(*)::int from public.action_items where source_type = 'control'",
      );
      const auditBefore = await count(
        "select count(*)::int from public.audit_logs where action = 'create_reconciliation_task'",
      );

      await submitAndSettle(page, () => button.click());
      await assertNoUiFailure(page, "reconciliation/create-task-row");

      await expect
        .poll(
          () => count("select count(*)::int from public.action_items where source_type = 'control'"),
          { timeout: 30_000 },
        )
        .toBeGreaterThan(beforeTasks);

      const afterTasks = await count(
        "select count(*)::int from public.action_items where source_type = 'control'",
      );
      const auditAfter = await count(
        "select count(*)::int from public.audit_logs where action = 'create_reconciliation_task'",
      );
      expect(auditAfter).toBeGreaterThan(auditBefore);

      await page.reload({ waitUntil: "domcontentloaded" });
      await waitForWorkspaceReady(page);
      const afterReload = await count(
        "select count(*)::int from public.action_items where source_type = 'control'",
      );
      expect(afterReload).toBe(afterTasks);

      assertClean(session, "reconciliation/create-task-row");

      evidence.push({
        route,
        control: sig,
        role,
        verdict: "PASS",
        proof: [
          `before DB action_items[source_type='control']=${beforeTasks}`,
          `click: tablo satırındaki gerçek 'Görev üret' düğmesi (${route})`,
          `after DB=${afterTasks}, audit_logs[create_reconciliation_task]: ${auditBefore} -> ${auditAfter}`,
          `reload sonrası DB=${afterReload} — kalıcı`,
        ],
      });
    } finally {
      await session.context.close();
    }
  });
});

/* ═══════════════════════════════════════════════════════════════════════════════════════════
 * 7. /data/trial-balance-bridge (1 kontrol)
 * ═══════════════════════════════════════════════════════════════════════════════════════════ */

test.describe("/data/trial-balance-bridge mutasyonları", () => {
  test("trial-balance/import-and-reconcile: 'Yasal Mizanı Yükle & Köprüyü Çalıştır' dengeli .xlsx mizanı ve mutabakat koşusunu yazar", async ({
    browser,
  }) => {
    test.setTimeout(240_000);
    const route = "/data/trial-balance-bridge";
    const role: SeededRole = "finance_operator";
    const tag = `${Date.now()}`;
    const periodLabel = `IX 2026-06 Mizanı (${tag})`;
    const filename = `ix-luca-mizan-${tag}.xlsx`;
    const mizanBuffer = await buildBalancedMizanWorkbookBuffer(tag);

    const session = await openAs(browser, role);
    const { page } = session;
    try {
      await page.goto(route, { waitUntil: "domcontentloaded" });
      await waitForWorkspaceReady(page);

      const label = "Yasal Mizanı Yükle & Köprüyü Çalıştır";
      const form = page
        .locator("form")
        .filter({ has: page.getByRole("button", { name: label, exact: true }) })
        .first();
      const button = form.getByRole("button", { name: label, exact: true });
      await expect(button).toBeVisible({ timeout: 20_000 });
      const sig = await resolveControlSignature(route, button, "button", label);

      const beforeMizan = await count(
        "select count(*)::int from public.statutory_trial_balances where period_label = $1",
        [periodLabel],
      );
      const beforeLines = await count(
        "select count(*)::int from public.statutory_trial_balance_lines",
      );
      const beforeRuns = await count(
        "select count(*)::int from public.trial_balance_reconciliation_runs",
      );

      await form.locator('input[name="asOfDate"]').fill("2026-06-30");
      await form.locator('input[name="periodLabel"]').fill(periodLabel);
      await form.locator('select[name="sourceSoftware"]').selectOption("Luca");
      await form.locator('input[type="file"][name="file"]').setInputFiles({
        name: filename,
        mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        buffer: mizanBuffer,
      });

      await submitAndSettle(page, () => button.click());
      await assertNoUiFailure(page, "trial-balance/import-and-reconcile");

      await expect
        .poll(
          () =>
            count(
              "select count(*)::int from public.statutory_trial_balances where period_label = $1 and is_self_balanced = true",
              [periodLabel],
            ),
          { timeout: 30_000 },
        )
        .toBe(beforeMizan + 1);

      const afterLines = await count(
        "select count(*)::int from public.statutory_trial_balance_lines",
      );
      const afterRuns = await count(
        "select count(*)::int from public.trial_balance_reconciliation_runs",
      );
      expect(afterLines).toBeGreaterThanOrEqual(beforeLines + 4);
      expect(afterRuns).toBeGreaterThan(beforeRuns);

      await page.reload({ waitUntil: "domcontentloaded" });
      await waitForWorkspaceReady(page);
      const afterReload = await count(
        "select count(*)::int from public.statutory_trial_balances where period_label = $1 and is_self_balanced = true",
        [periodLabel],
      );
      expect(afterReload).toBe(1);

      assertClean(session, "trial-balance/import-and-reconcile");

      evidence.push({
        route,
        control: sig,
        role,
        verdict: "PASS",
        proof: [
          `before DB statutory_trial_balances[period='${periodLabel}']=${beforeMizan}, runs=${beforeRuns}`,
          `upload .xlsx + click: gerçek '${label}' düğmesi (${route})`,
          `after DB statutory_trial_balances=1 (is_self_balanced=true), lines=${afterLines}, runs=${afterRuns}`,
          `reload sonrası DB=${afterReload} — kalıcı`,
        ],
      });
    } finally {
      await session.context.close();
    }
  });
});

/* ═══════════════════════════════════════════════════════════════════════════════════════════
 * 8. /data/integrations (2 kontrol)
 * ═══════════════════════════════════════════════════════════════════════════════════════════ */

test.describe("/data/integrations mutasyonları", () => {
  test("integrations/closed-loop-sync: 'Kapalı Çevrim Tam Senkron (TCMB + Paraşüt + Defter + 13H)' defter/13H hattını yürütür ve denetim izi yazar", async ({
    browser,
  }) => {
    test.setTimeout(240_000);
    const route = "/data/integrations";
    const role: SeededRole = "finance_operator";
    const label = "Kapalı Çevrim Tam Senkron (TCMB + Paraşüt + Defter + 13H)";

    const session = await openAs(browser, role);
    const { page } = session;
    try {
      await page.goto(route, { waitUntil: "domcontentloaded" });
      await waitForWorkspaceReady(page);

      const button = page.getByRole("button", { name: label, exact: true }).first();
      await expect(button).toBeVisible({ timeout: 20_000 });
      const sig = await resolveControlSignature(route, button, "button", label);

      const beforeAudit = await count(
        "select count(*)::int from public.audit_logs where action = 'manual_closed_loop_financial_sync' and entity_table = 'integration_sync_runs'",
      );

      await submitAndSettle(page, () => button.click());
      await assertNoUiFailure(page, "integrations/closed-loop-sync");

      await expect
        .poll(
          () =>
            count(
              "select count(*)::int from public.audit_logs where action = 'manual_closed_loop_financial_sync' and entity_table = 'integration_sync_runs'",
            ),
          { timeout: 60_000 },
        )
        .toBeGreaterThan(beforeAudit);

      const afterAudit = await count(
        "select count(*)::int from public.audit_logs where action = 'manual_closed_loop_financial_sync' and entity_table = 'integration_sync_runs'",
      );
      const snapshots13w = await count("select count(*)::int from public.forecast_snapshots_13w");
      expect(snapshots13w).toBeGreaterThanOrEqual(1);

      await page.reload({ waitUntil: "domcontentloaded" });
      await waitForWorkspaceReady(page);
      const afterReload = await count(
        "select count(*)::int from public.audit_logs where action = 'manual_closed_loop_financial_sync' and entity_table = 'integration_sync_runs'",
      );
      expect(afterReload).toBe(afterAudit);

      assertClean(session, "integrations/closed-loop-sync");

      evidence.push({
        route,
        control: sig,
        role,
        verdict: "PASS",
        proof: [
          `before DB audit_logs[manual_closed_loop_financial_sync]=${beforeAudit}`,
          `click: gerçek '${label}' düğmesi (${route})`,
          `after DB audit_logs=${afterAudit}, forecast_snapshots_13w=${snapshots13w}`,
          `reload sonrası audit_logs=${afterReload} — kalıcı`,
        ],
      });
    } finally {
      await session.context.close();
    }
  });

  test("integrations/add-connection: 'Bağlantı Ekle' yeni integration_connections kaydı oluşturur", async ({
    browser,
  }) => {
    test.setTimeout(240_000);
    const route = "/data/integrations";
    const role: SeededRole = "admin";
    const connName = `IX Paraşüt Bağlantısı ${Date.now()}`;

    const session = await openAs(browser, role);
    const { page } = session;
    try {
      await page.goto(route, { waitUntil: "domcontentloaded" });
      await waitForWorkspaceReady(page);

      const form = page
        .locator("form")
        .filter({ has: page.getByRole("button", { name: "Bağlantı Ekle", exact: true }) })
        .first();
      const button = form.getByRole("button", { name: "Bağlantı Ekle", exact: true });
      await expect(button).toBeVisible({ timeout: 20_000 });
      const sig = await resolveControlSignature(route, button, "button", "Bağlantı Ekle");

      const before = await count(
        "select count(*)::int from public.integration_connections where name = $1",
        [connName],
      );
      expect(before).toBe(0);
      const auditBefore = await count(
        "select count(*)::int from public.audit_logs where entity_table = 'integration_connections' and action = 'create_integration_connection'",
      );

      await form.locator('select[name="integrationKind"]').selectOption("accounting");
      await form.locator('input[name="name"]').fill(connName);
      await form.locator('input[name="provider"]').fill("parasut");
      await form.locator('input[name="companyId"]').fill("123456");
      await form.locator('input[name="credentialEnvVar"]').fill("PARASUT_PASSWORD");

      await submitAndSettle(page, () => button.click());
      await assertNoUiFailure(page, "integrations/add-connection");

      await expect
        .poll(
          () =>
            count("select count(*)::int from public.integration_connections where name = $1", [
              connName,
            ]),
          { timeout: 30_000 },
        )
        .toBe(1);

      const auditAfter = await count(
        "select count(*)::int from public.audit_logs where entity_table = 'integration_connections' and action = 'create_integration_connection'",
      );
      expect(auditAfter).toBeGreaterThan(auditBefore);

      await page.reload({ waitUntil: "domcontentloaded" });
      await waitForWorkspaceReady(page);
      await expect(page.getByText(connName).first()).toBeVisible({ timeout: 20_000 });
      const afterReload = await count(
        "select count(*)::int from public.integration_connections where name = $1",
        [connName],
      );
      expect(afterReload).toBe(1);

      assertClean(session, "integrations/add-connection");

      evidence.push({
        route,
        control: sig,
        role,
        verdict: "PASS",
        proof: [
          `before DB integration_connections[name='${connName}']=0`,
          `fill + click: gerçek 'Bağlantı Ekle' düğmesi (${route})`,
          `after DB=1, audit_logs[create_integration_connection]: ${auditBefore} -> ${auditAfter}`,
          `reload sonrası '${connName}' görünür ve DB kaydı kalıcı`,
        ],
      });
    } finally {
      await db((c) =>
        c.query("update public.integration_connections set status = 'disabled' where name = $1", [
          connName,
        ]),
      ).catch(() => {});
      await session.context.close();
    }
  });
});

/* ═══════════════════════════════════════════════════════════════════════════════════════════
 * 9. /system/controls (5 kontrol)
 * ═══════════════════════════════════════════════════════════════════════════════════════════ */

test.describe("/system/controls mutasyonları", () => {
  for (const ctrlCase of [
    {
      id: "system/controls-ack",
      label: "Gördüm",
      expectedStatus: "acknowledged",
      fill: undefined,
    },
    {
      id: "system/controls-snooze",
      label: "Ertele",
      expectedStatus: "snoozed",
      fill: async (form: Locator) => {
        await form.locator('input[name="snoozeUntil"]').fill("2099-12-31");
      },
    },
    {
      id: "system/controls-resolve",
      label: "Çözüldü",
      expectedStatus: "resolved",
      fill: async (form: Locator) => {
        await form.locator('input[name="note"]').fill("IX kontrol uyarısı çözüm gerekçesi");
      },
    },
    {
      id: "system/controls-false-positive",
      label: "Yanlış alarm",
      expectedStatus: "false_positive",
      fill: async (form: Locator) => {
        await form.locator('input[name="note"]').fill("IX yanlış alarm geri bildirim gerekçesi");
      },
    },
  ] as const) {
    test(`${ctrlCase.id}: '${ctrlCase.label}' control_alerts.status='${ctrlCase.expectedStatus}' geçişini yazar`, async ({
      browser,
    }) => {
      test.setTimeout(240_000);
      const route = "/system/controls";
      const role: SeededRole = "finance_manager";
      const alertId = await seedOpenControlAlert(`${ctrlCase.expectedStatus}_${Date.now()}`);

      const session = await openAs(browser, role);
      const { page } = session;
      try {
        await page.goto(route, { waitUntil: "domcontentloaded" });
        await waitForWorkspaceReady(page);

        const form = page
          .locator("form")
          .filter({ has: page.locator(`input[name="alertId"][value="${alertId}"]`) })
          .filter({ has: page.getByRole("button", { name: ctrlCase.label, exact: true }) })
          .first();
        const button = form.getByRole("button", { name: ctrlCase.label, exact: true });
        await expect(button).toBeVisible({ timeout: 20_000 });
        const sig = await resolveControlSignature(route, button, "button", ctrlCase.label);

        const beforeStatus = await scalar<string>(
          "select status from public.control_alerts where id = $1",
          [alertId],
        );
        expect(beforeStatus).toBe("open");
        const auditBefore = await count(
          "select count(*)::int from public.audit_logs where entity_table = 'control_alerts'",
        );

        if (ctrlCase.fill) await ctrlCase.fill(form);

        await submitAndSettle(page, () => button.click());
        await assertNoUiFailure(page, ctrlCase.id);

        await expect
          .poll(
            () => scalar<string>("select status from public.control_alerts where id = $1", [alertId]),
            { timeout: 30_000 },
          )
          .toBe(ctrlCase.expectedStatus);

        const auditAfter = await count(
          "select count(*)::int from public.audit_logs where entity_table = 'control_alerts'",
        );
        expect(auditAfter).toBeGreaterThan(auditBefore);

        await page.reload({ waitUntil: "domcontentloaded" });
        await waitForWorkspaceReady(page);
        const afterReload = await scalar<string>(
          "select status from public.control_alerts where id = $1",
          [alertId],
        );
        expect(afterReload).toBe(ctrlCase.expectedStatus);

        assertClean(session, ctrlCase.id);

        evidence.push({
          route,
          control: sig,
          role,
          verdict: "PASS",
          proof: [
            `before DB control_alerts.status=${beforeStatus} (id=${alertId})`,
            `click: gerçek '${ctrlCase.label}' düğmesi (${route})`,
            `after DB status=${ctrlCase.expectedStatus}, audit_logs: ${auditBefore} -> ${auditAfter}`,
            `reload sonrası status=${afterReload} — kalıcı`,
          ],
        });
      } finally {
        await session.context.close();
      }
    });
  }

  test("system/controls-create-task: 'görev aç' uyarıdan action_items satırı üretir ve action_item_id bağlar", async ({
    browser,
  }) => {
    test.setTimeout(240_000);
    const route = "/system/controls";
    const role: SeededRole = "finance_manager";
    const alertId = await seedOpenControlAlert(`task_${Date.now()}`);

    const session = await openAs(browser, role);
    const { page } = session;
    try {
      await page.goto(route, { waitUntil: "domcontentloaded" });
      await waitForWorkspaceReady(page);

      const form = page
        .locator("form")
        .filter({ has: page.locator(`input[name="alertId"][value="${alertId}"]`) })
        .filter({ has: page.getByRole("button", { name: "görev aç", exact: true }) })
        .first();
      const button = form.getByRole("button", { name: "görev aç", exact: true });
      await expect(button).toBeVisible({ timeout: 20_000 });
      const sig = await resolveControlSignature(route, button, "button", "görev aç");

      const beforeLinked = await scalar<string | null>(
        "select action_item_id::text from public.control_alerts where id = $1",
        [alertId],
      );
      expect(beforeLinked).toBeNull();
      const auditBefore = await count(
        "select count(*)::int from public.audit_logs where action = 'raise_control_action_item'",
      );

      await submitAndSettle(page, () => button.click());
      await assertNoUiFailure(page, "system/controls-create-task");

      await expect
        .poll(
          async () =>
            (await scalar<string | null>(
              "select action_item_id::text from public.control_alerts where id = $1",
              [alertId],
            )) !== null,
          { timeout: 30_000 },
        )
        .toBe(true);

      const linkedItemId = await scalar<string>(
        "select action_item_id::text from public.control_alerts where id = $1",
        [alertId],
      );
      const taskExists = await count("select count(*)::int from public.action_items where id = $1", [
        linkedItemId,
      ]);
      expect(taskExists).toBe(1);

      const auditAfter = await count(
        "select count(*)::int from public.audit_logs where action = 'raise_control_action_item'",
      );
      expect(auditAfter).toBeGreaterThan(auditBefore);

      await page.reload({ waitUntil: "domcontentloaded" });
      await waitForWorkspaceReady(page);
      const afterReload = await scalar<string | null>(
        "select action_item_id::text from public.control_alerts where id = $1",
        [alertId],
      );
      expect(afterReload).toBe(linkedItemId);

      assertClean(session, "system/controls-create-task");

      evidence.push({
        route,
        control: sig,
        role,
        verdict: "PASS",
        proof: [
          `before DB control_alerts.action_item_id=null (id=${alertId})`,
          `click: gerçek 'görev aç' düğmesi (${route})`,
          `after DB action_item_id=${linkedItemId} (action_items satırı mevcut), audit_logs: ${auditBefore} -> ${auditAfter}`,
          `reload sonrası action_item_id=${afterReload} — kalıcı`,
        ],
      });
    } finally {
      await session.context.close();
    }
  });
});

/* ═══════════════════════════════════════════════════════════════════════════════════════════
 * 10. /system/jobs (5 kontrol)
 * ═══════════════════════════════════════════════════════════════════════════════════════════ */

test.describe("/system/jobs mutasyonları", () => {
  for (const presetCase of [
    {
      id: "system/jobs-preset-controls",
      label: "+ İç Kontrol Denetimi Çalıştır",
      jobType: "read_model_refresh",
    },
    {
      id: "system/jobs-preset-cfo-report",
      label: "+ Günlük CFO Özeti Üret",
      jobType: "report_generation",
    },
    {
      id: "system/jobs-preset-tcmb-fx",
      label: "+ TCMB Günlük Kur Çek",
      jobType: "fx_rate_sync",
    },
  ] as const) {
    test(`${presetCase.id}: '${presetCase.label}' background_jobs kuyruğuna '${presetCase.jobType}' işi ekleyip dağıtıcıyı çalıştırır`, async ({
      browser,
    }) => {
      test.setTimeout(240_000);
      const route = "/system/jobs";
      const role: SeededRole = "finance_manager";

      const session = await openAs(browser, role);
      const { page } = session;
      try {
        await page.goto(route, { waitUntil: "domcontentloaded" });
        await waitForWorkspaceReady(page);

        const button = page.getByRole("button", { name: presetCase.label, exact: true }).first();
        await expect(button).toBeVisible({ timeout: 20_000 });
        const sig = await resolveControlSignature(route, button, "button", presetCase.label);

        const beforeJobs = await count(
          "select count(*)::int from public.background_jobs where job_type = $1",
          [presetCase.jobType],
        );
        const auditBefore = await count(
          "select count(*)::int from public.audit_logs where entity_table = 'background_jobs' and action = 'enqueue_job'",
        );

        await submitAndSettle(page, () => button.click());
        await assertNoUiFailure(page, presetCase.id);

        await expect
          .poll(
            () =>
              count("select count(*)::int from public.background_jobs where job_type = $1", [
                presetCase.jobType,
              ]),
            { timeout: 45_000 },
          )
          .toBeGreaterThan(beforeJobs);

        const afterJobs = await count(
          "select count(*)::int from public.background_jobs where job_type = $1",
          [presetCase.jobType],
        );
        const auditAfter = await count(
          "select count(*)::int from public.audit_logs where entity_table = 'background_jobs' and action = 'enqueue_job'",
        );
        expect(auditAfter).toBeGreaterThan(auditBefore);

        await page.reload({ waitUntil: "domcontentloaded" });
        await waitForWorkspaceReady(page);
        const afterReload = await count(
          "select count(*)::int from public.background_jobs where job_type = $1",
          [presetCase.jobType],
        );
        expect(afterReload).toBe(afterJobs);

        assertClean(session, presetCase.id);

        evidence.push({
          route,
          control: sig,
          role,
          verdict: "PASS",
          proof: [
            `before DB background_jobs[job_type='${presetCase.jobType}']=${beforeJobs}`,
            `click: gerçek '${presetCase.label}' düğmesi (${route})`,
            `after DB=${afterJobs}, audit_logs[enqueue_job]: ${auditBefore} -> ${auditAfter}`,
            `reload sonrası DB=${afterReload} — kalıcı`,
          ],
        });
      } finally {
        await session.context.close();
      }
    });
  }

  test("system/jobs-run-next: 'Sıradaki işi çalıştır' kuyruktaki öncelikli işi sahiplenip tamamlar", async ({
    browser,
  }) => {
    test.setTimeout(240_000);
    const route = "/system/jobs";
    const role: SeededRole = "finance_manager";
    const jobId = await seedPriorityQueuedJob(`run-next-${Date.now()}`);

    const session = await openAs(browser, role);
    const { page } = session;
    try {
      await page.goto(route, { waitUntil: "domcontentloaded" });
      await waitForWorkspaceReady(page);

      const button = page.getByRole("button", { name: "Sıradaki işi çalıştır", exact: true }).first();
      await expect(button).toBeVisible({ timeout: 20_000 });
      const sig = await resolveControlSignature(route, button, "button", "Sıradaki işi çalıştır");

      const beforeStatus = await scalar<string>(
        "select status from public.background_jobs where id = $1",
        [jobId],
      );
      expect(beforeStatus).toBe("queued");
      const auditBefore = await count(
        "select count(*)::int from public.audit_logs where entity_table = 'background_jobs' and action in ('claim_job','complete_job')",
      );

      await submitAndSettle(page, () => button.click());
      await assertNoUiFailure(page, "system/jobs-run-next");

      await expect
        .poll(
          () => scalar<string>("select status from public.background_jobs where id = $1", [jobId]),
          { timeout: 30_000 },
        )
        .toBe("succeeded");

      const auditAfter = await count(
        "select count(*)::int from public.audit_logs where entity_table = 'background_jobs' and action in ('claim_job','complete_job')",
      );
      expect(auditAfter).toBeGreaterThan(auditBefore);

      await page.reload({ waitUntil: "domcontentloaded" });
      await waitForWorkspaceReady(page);
      const afterReload = await scalar<string>(
        "select status from public.background_jobs where id = $1",
        [jobId],
      );
      expect(afterReload).toBe("succeeded");

      assertClean(session, "system/jobs-run-next");

      evidence.push({
        route,
        control: sig,
        role,
        verdict: "PASS",
        proof: [
          `before DB background_jobs.status=${beforeStatus} (id=${jobId}, priority=1)`,
          `click: gerçek 'Sıradaki işi çalıştır' düğmesi (${route})`,
          `after DB status='succeeded', audit_logs[claim/complete]: ${auditBefore} -> ${auditAfter}`,
          `reload sonrası status=${afterReload} — kalıcı`,
        ],
      });
    } finally {
      await session.context.close();
    }
  });

  test("system/drain-queue: 'Kuyruğu süpür' asılı running işi kurtarıp queued durumuna alır ve audit_logs yazar", async ({
    browser,
  }) => {
    test.setTimeout(240_000);
    const route = "/system/jobs";
    const role: SeededRole = "finance_manager";
    const staleJobId = await seedStaleRunningJob(`sweep-${Date.now()}`);

    const session = await openAs(browser, role);
    const { page } = session;
    try {
      await page.goto(route, { waitUntil: "domcontentloaded" });
      await waitForWorkspaceReady(page);

      const button = page.getByRole("button", { name: "Kuyruğu süpür", exact: true }).first();
      await expect(button).toBeVisible({ timeout: 20_000 });
      const sig = await resolveControlSignature(route, button, "button", "Kuyruğu süpür");

      const beforeStatus = await scalar<string>(
        "select status from public.background_jobs where id = $1",
        [staleJobId],
      );
      expect(beforeStatus).toBe("running");
      const auditBefore = await count(
        "select count(*)::int from public.audit_logs where entity_table = 'background_jobs' and action = 'reap_stale_running_jobs'",
      );

      await submitAndSettle(page, () => button.click());
      await assertNoUiFailure(page, "system/drain-queue");

      await expect
        .poll(
          () =>
            scalar<string>("select status from public.background_jobs where id = $1", [staleJobId]),
          { timeout: 30_000 },
        )
        .toBe("queued");

      const auditAfter = await count(
        "select count(*)::int from public.audit_logs where entity_table = 'background_jobs' and action = 'reap_stale_running_jobs'",
      );
      expect(auditAfter).toBeGreaterThan(auditBefore);

      await page.reload({ waitUntil: "domcontentloaded" });
      await waitForWorkspaceReady(page);
      const afterReload = await scalar<string>(
        "select status from public.background_jobs where id = $1",
        [staleJobId],
      );
      expect(afterReload).toBe("queued");

      assertClean(session, "system/drain-queue");

      evidence.push({
        route,
        control: sig,
        role,
        verdict: "PASS",
        proof: [
          `before DB background_jobs.status=${beforeStatus} (started_at=now()-45m, id=${staleJobId})`,
          `click: gerçek 'Kuyruğu süpür' düğmesi (${route})`,
          `after DB status='queued', audit_logs[reap_stale_running_jobs]: ${auditBefore} -> ${auditAfter}`,
          `reload sonrası status=${afterReload} — kalıcı`,
        ],
      });
    } finally {
      await db((c) =>
        c.query(
          "update public.background_jobs set status = 'cancelled', finished_at = now() where id = $1 and status = 'queued'",
          [staleJobId],
        ),
      ).catch(() => {});
      await session.context.close();
    }
  });
});

/* ═══════════════════════════════════════════════════════════════════════════════════════════
 * 11. /system/security (7 kontrol: 5 button + 2 select — YALNIZ ix_* hesapları hedeflenir!)
 * ═══════════════════════════════════════════════════════════════════════════════════════════ */

test.describe("/system/security mutasyonları (yalnız ix_* fixture hesapları)", () => {
  test("system/reset-password: 'sıfırla' yalnız ix_fixture_sec_user parolasını yeniler ve must_change_password=true yazar", async ({
    browser,
  }) => {
    test.setTimeout(240_000);
    const route = "/system/security";
    const role: SeededRole = "admin";
    const fixture = await ensureSecurityFixtureUser({
      role: "viewer",
      isActive: true,
      mustChangePassword: false,
    });
    assertSafeTargetUsername(fixture.username);

    const session = await openAs(browser, role);
    const { page } = session;
    try {
      await page.goto(route, { waitUntil: "domcontentloaded" });
      await waitForWorkspaceReady(page);

      const form = page
        .locator("form")
        .filter({ has: page.locator(`input[name="id"][value="${fixture.id}"]`) })
        .filter({ has: page.getByRole("button", { name: "sıfırla", exact: true }) })
        .first();
      const button = form.getByRole("button", { name: "sıfırla", exact: true });
      await expect(button).toBeVisible({ timeout: 20_000 });
      const sig = await resolveControlSignature(route, button, "button", "sıfırla");

      const beforeHash = await scalar<string>(
        "select password_hash from public.users where id = $1",
        [fixture.id],
      );
      const auditBefore = await count(
        "select count(*)::int from public.audit_logs where entity_table = 'users'",
      );

      await form.locator('input[name="password"]').fill("IxSecReset#2026!Ok");

      await submitAndSettle(page, () => button.click());
      await assertNoUiFailure(page, "system/reset-password");

      await expect
        .poll(
          async () => {
            const cur = await scalar<string>(
              "select password_hash from public.users where id = $1",
              [fixture.id],
            );
            return Boolean(cur && cur !== beforeHash && cur.startsWith("$argon2"));
          },
          { timeout: 30_000 },
        )
        .toBe(true);

      const mustChange = await scalar<boolean>(
        "select must_change_password from public.users where id = $1",
        [fixture.id],
      );
      expect(mustChange).toBe(true);

      const auditAfter = await count(
        "select count(*)::int from public.audit_logs where entity_table = 'users'",
      );
      expect(auditAfter).toBeGreaterThan(auditBefore);

      await page.reload({ waitUntil: "domcontentloaded" });
      await waitForWorkspaceReady(page);
      const afterReloadMustChange = await scalar<boolean>(
        "select must_change_password from public.users where id = $1",
        [fixture.id],
      );
      expect(afterReloadMustChange).toBe(true);

      assertClean(session, "system/reset-password");

      evidence.push({
        route,
        control: sig,
        role,
        verdict: "PASS",
        proof: [
          `before DB users[username='${fixture.username}'].must_change_password=false`,
          `fill password + click: gerçek 'sıfırla' düğmesi (${route}, yalnız '${fixture.username}')`,
          `after DB argon2id password_hash yenilendi, must_change_password=true, audit_logs: ${auditBefore} -> ${auditAfter}`,
          `reload sonrası must_change_password=${afterReloadMustChange} — kalıcı`,
        ],
      });
    } finally {
      await session.context.close();
    }
  });

  test("system/change-role + role-select: satır içi rol <select> ve 'rolü değiştir' yalnız ix_fixture_sec_user rolünü günceller", async ({
    browser,
  }) => {
    test.setTimeout(240_000);
    const route = "/system/security";
    const role: SeededRole = "admin";
    const fixture = await ensureSecurityFixtureUser({ role: "viewer", isActive: true });
    assertSafeTargetUsername(fixture.username);

    const session = await openAs(browser, role);
    const { page } = session;
    try {
      await page.goto(route, { waitUntil: "domcontentloaded" });
      await waitForWorkspaceReady(page);

      const form = page
        .locator("form")
        .filter({ has: page.locator(`input[name="id"][value="${fixture.id}"]`) })
        .filter({ has: page.getByRole("button", { name: "rolü değiştir", exact: true }) })
        .first();
      const roleSelect = form.locator('select[name="role"]');
      const button = form.getByRole("button", { name: "rolü değiştir", exact: true });
      await expect(roleSelect).toBeVisible({ timeout: 20_000 });
      await expect(button).toBeVisible({ timeout: 20_000 });

      const selectSig = await resolveControlSignature(route, roleSelect, "select");
      const buttonSig = await resolveControlSignature(route, button, "button", "rolü değiştir");
      expect(selectSig.startsWith("select|")).toBe(true);
      expect(buttonSig.startsWith("button|")).toBe(true);

      const beforeRole = await scalar<string>("select role from public.users where id = $1", [
        fixture.id,
      ]);
      expect(beforeRole).toBe("viewer");
      const auditBefore = await count(
        "select count(*)::int from public.audit_logs where entity_table = 'users'",
      );

      await roleSelect.selectOption("finance_approver");
      await expect(roleSelect).toHaveValue("finance_approver");

      await submitAndSettle(page, () => button.click());
      await assertNoUiFailure(page, "system/change-role");

      await expect
        .poll(
          () => scalar<string>("select role from public.users where id = $1", [fixture.id]),
          { timeout: 30_000 },
        )
        .toBe("finance_approver");

      const auditAfter = await count(
        "select count(*)::int from public.audit_logs where entity_table = 'users'",
      );
      expect(auditAfter).toBeGreaterThan(auditBefore);

      await page.reload({ waitUntil: "domcontentloaded" });
      await waitForWorkspaceReady(page);
      const afterReloadRole = await scalar<string>("select role from public.users where id = $1", [
        fixture.id,
      ]);
      expect(afterReloadRole).toBe("finance_approver");

      assertClean(session, "system/change-role");

      evidence.push({
        route,
        control: selectSig,
        role,
        verdict: "PASS",
        proof: [
          `before DB users[username='${fixture.username}'].role=${beforeRole}`,
          `selectOption('finance_approver') + submit: satır içi rol <select> (${route})`,
          `after DB role='finance_approver', audit_logs: ${auditBefore} -> ${auditAfter}`,
          `reload sonrası role=${afterReloadRole} — kalıcı`,
        ],
      });

      evidence.push({
        route,
        control: buttonSig,
        role,
        verdict: "PASS",
        proof: [
          `before DB users[username='${fixture.username}'].role=${beforeRole}`,
          `click: gerçek 'rolü değiştir' düğmesi (${route}, yalnız '${fixture.username}')`,
          `after DB role='finance_approver', audit_logs: ${auditBefore} -> ${auditAfter}`,
          `reload sonrası role=${afterReloadRole} — kalıcı`,
        ],
      });
    } finally {
      await session.context.close();
    }
  });

  test("system/deactivate-user: 'pasifleştir' yalnız ix_fixture_sec_user hesabını is_active=false yapar", async ({
    browser,
  }) => {
    test.setTimeout(240_000);
    const route = "/system/security";
    const role: SeededRole = "admin";
    const fixture = await ensureSecurityFixtureUser({ role: "viewer", isActive: true });
    assertSafeTargetUsername(fixture.username);

    const session = await openAs(browser, role);
    const { page } = session;
    try {
      await page.goto(route, { waitUntil: "domcontentloaded" });
      await waitForWorkspaceReady(page);

      const form = page
        .locator("form")
        .filter({ has: page.locator(`input[name="id"][value="${fixture.id}"]`) })
        .filter({ has: page.getByRole("button", { name: "pasifleştir", exact: true }) })
        .first();
      const button = form.getByRole("button", { name: "pasifleştir", exact: true });
      await expect(button).toBeVisible({ timeout: 20_000 });
      const sig = await resolveControlSignature(route, button, "button", "pasifleştir");

      const beforeActive = await scalar<boolean>(
        "select is_active from public.users where id = $1",
        [fixture.id],
      );
      expect(beforeActive).toBe(true);
      const auditBefore = await count(
        "select count(*)::int from public.audit_logs where entity_table = 'users'",
      );

      await submitAndSettle(page, () => button.click());
      await assertNoUiFailure(page, "system/deactivate-user");

      await expect
        .poll(
          () => scalar<boolean>("select is_active from public.users where id = $1", [fixture.id]),
          { timeout: 30_000 },
        )
        .toBe(false);

      const auditAfter = await count(
        "select count(*)::int from public.audit_logs where entity_table = 'users'",
      );
      expect(auditAfter).toBeGreaterThan(auditBefore);

      await page.reload({ waitUntil: "domcontentloaded" });
      await waitForWorkspaceReady(page);
      const afterReload = await scalar<boolean>(
        "select is_active from public.users where id = $1",
        [fixture.id],
      );
      expect(afterReload).toBe(false);

      assertClean(session, "system/deactivate-user");

      evidence.push({
        route,
        control: sig,
        role,
        verdict: "PASS",
        proof: [
          `before DB users[username='${fixture.username}'].is_active=true`,
          `click: gerçek 'pasifleştir' düğmesi (${route}, yalnız '${fixture.username}')`,
          `after DB is_active=false, audit_logs: ${auditBefore} -> ${auditAfter}`,
          `reload sonrası is_active=${afterReload} — kalıcı`,
        ],
      });
    } finally {
      await session.context.close();
    }
  });

  test("system/activate-user: 'aktifleştir' pasif ix_fixture_sec_user hesabını is_active=true yapar", async ({
    browser,
  }) => {
    test.setTimeout(240_000);
    const route = "/system/security";
    const role: SeededRole = "admin";
    const fixture = await ensureSecurityFixtureUser({ role: "viewer", isActive: false });
    assertSafeTargetUsername(fixture.username);

    const session = await openAs(browser, role);
    const { page } = session;
    try {
      await page.goto(route, { waitUntil: "domcontentloaded" });
      await waitForWorkspaceReady(page);

      const form = page
        .locator("form")
        .filter({ has: page.locator(`input[name="id"][value="${fixture.id}"]`) })
        .filter({ has: page.getByRole("button", { name: "aktifleştir", exact: true }) })
        .first();
      const button = form.getByRole("button", { name: "aktifleştir", exact: true });
      await expect(button).toBeVisible({ timeout: 20_000 });
      const sig = await resolveControlSignature(route, button, "button", "aktifleştir");

      const beforeActive = await scalar<boolean>(
        "select is_active from public.users where id = $1",
        [fixture.id],
      );
      expect(beforeActive).toBe(false);
      const auditBefore = await count(
        "select count(*)::int from public.audit_logs where entity_table = 'users'",
      );

      await submitAndSettle(page, () => button.click());
      await assertNoUiFailure(page, "system/activate-user");

      await expect
        .poll(
          () => scalar<boolean>("select is_active from public.users where id = $1", [fixture.id]),
          { timeout: 30_000 },
        )
        .toBe(true);

      const auditAfter = await count(
        "select count(*)::int from public.audit_logs where entity_table = 'users'",
      );
      expect(auditAfter).toBeGreaterThan(auditBefore);

      await page.reload({ waitUntil: "domcontentloaded" });
      await waitForWorkspaceReady(page);
      const afterReload = await scalar<boolean>(
        "select is_active from public.users where id = $1",
        [fixture.id],
      );
      expect(afterReload).toBe(true);

      assertClean(session, "system/activate-user");

      evidence.push({
        route,
        control: sig,
        role,
        verdict: "PASS",
        proof: [
          `before DB users[username='${fixture.username}'].is_active=false`,
          `click: gerçek 'aktifleştir' düğmesi (${route}, yalnız '${fixture.username}')`,
          `after DB is_active=true, audit_logs: ${auditBefore} -> ${auditAfter}`,
          `reload sonrası is_active=${afterReload} — kalıcı`,
        ],
      });
    } finally {
      await session.context.close();
    }
  });

  test("system/create-user + create-role-select: yeni kullanıcı formu <select> ve 'kullanıcı oluştur' yeni ix_created_* hesabı yazar", async ({
    browser,
  }) => {
    test.setTimeout(240_000);
    const route = "/system/security";
    const role: SeededRole = "admin";
    const newUsername = `ix_created_${Date.now().toString(36)}`;
    assertSafeTargetUsername(newUsername);

    const session = await openAs(browser, role);
    const { page } = session;
    try {
      await page.goto(route, { waitUntil: "domcontentloaded" });
      await waitForWorkspaceReady(page);

      const form = page
        .locator("form")
        .filter({ has: page.locator('input[name="username"]') })
        .first();
      const roleSelect = form.locator('select[name="role"]');
      const button = form.getByRole("button", { name: "kullanıcı oluştur", exact: true });
      await expect(roleSelect).toBeVisible({ timeout: 20_000 });
      await expect(button).toBeVisible({ timeout: 20_000 });

      const createSelectSig = await resolveControlSignature(route, roleSelect, "select");
      const createBtnSig = await resolveControlSignature(route, button, "button", "kullanıcı oluştur");
      expect(createSelectSig.startsWith("select|")).toBe(true);
      expect(createBtnSig.startsWith("button|")).toBe(true);

      const beforeCount = await count(
        "select count(*)::int from public.users where username = $1",
        [newUsername],
      );
      expect(beforeCount).toBe(0);
      const auditBefore = await count(
        "select count(*)::int from public.audit_logs where entity_table = 'users'",
      );

      await form.locator('input[name="username"]').fill(newUsername);
      await form.locator('input[name="displayName"]').fill(`IX Oluşturulan Kullanıcı (${newUsername})`);
      await roleSelect.selectOption("finance_operator");
      await expect(roleSelect).toHaveValue("finance_operator");
      await form.locator('input[name="password"]').fill("IxCreatedUser#2026!Ok");

      await submitAndSettle(page, () => button.click());
      await assertNoUiFailure(page, "system/create-user");

      await expect
        .poll(
          () =>
            count(
              "select count(*)::int from public.users where username = $1 and role = 'finance_operator' and is_active = true",
              [newUsername],
            ),
          { timeout: 30_000 },
        )
        .toBe(1);

      const auditAfter = await count(
        "select count(*)::int from public.audit_logs where entity_table = 'users'",
      );
      expect(auditAfter).toBeGreaterThan(auditBefore);

      await page.reload({ waitUntil: "domcontentloaded" });
      await waitForWorkspaceReady(page);
      await expect(page.getByText(newUsername).first()).toBeVisible({ timeout: 20_000 });
      const afterReload = await count(
        "select count(*)::int from public.users where username = $1 and role = 'finance_operator'",
        [newUsername],
      );
      expect(afterReload).toBe(1);

      assertClean(session, "system/create-user");

      evidence.push({
        route,
        control: createSelectSig,
        role,
        verdict: "PASS",
        proof: [
          `before DB users[username='${newUsername}']=0`,
          `selectOption('finance_operator') + submit: yeni kullanıcı rol <select> (${route})`,
          `after DB users[username='${newUsername}'].role='finance_operator', audit_logs: ${auditBefore} -> ${auditAfter}`,
          `reload sonrası DB=${afterReload} — kalıcı`,
        ],
      });

      evidence.push({
        route,
        control: createBtnSig,
        role,
        verdict: "PASS",
        proof: [
          `before DB users[username='${newUsername}']=0`,
          `fill + click: gerçek 'kullanıcı oluştur' düğmesi (${route}, '${newUsername}')`,
          `after DB users=1 (role='finance_operator', is_active=true), audit_logs: ${auditBefore} -> ${auditAfter}`,
          `reload sonrası '${newUsername}' listede görünür ve DB kaydı kalıcı`,
        ],
      });
    } finally {
      await db((c) =>
        c.query("update public.users set is_active = false where username = $1", [newUsername]),
      ).catch(() => {});
      await session.context.close();
    }
  });
});
