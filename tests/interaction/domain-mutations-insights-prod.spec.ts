/**
 * ALAN MUTASYONLARI — SENARYOLAR, İÇGÖRÜLER, BRİFİNG, RAPORLAR, GÖREVLER, HATIRLATMALAR VE ÜRETİM (34 KONTROL)
 *
 * Bu paket `slice-mutations-insights-prod.json` içindeki 34 `(rota, kontrol)` çiftinin TAMAMINI
 * gerçek Chromium tıklaması + uygulamadan bağımsız PostgreSQL (`db()`) before/after doğrulaması +
 * `audit_logs` izi + `page.reload()` kalıcılığı ile uçtan uca kanıtlar ve sonuçları
 * `docs/interaction-audit/evidence-mutations-insights-prod.json` dosyasına yazar.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Browser, Locator, Page } from "@playwright/test";
import {
  assertClean,
  db,
  expect,
  loadRuntimeInventory,
  openAs,
  scalar,
  test,
  type Evidence,
  type RoleSession,
  type SeededRole,
} from "./harness";
import { refreshRoleSession, usernameFor } from "../visual/global-setup";
import { waitForWorkspaceReady } from "./workspace-ready";

const OUT = path.join(process.cwd(), "docs", "interaction-audit");
const evidence: Evidence[] = [];

test.afterAll(() => {
  mkdirSync(OUT, { recursive: true });
  writeFileSync(
    path.join(OUT, "evidence-mutations-insights-prod.json"),
    `${JSON.stringify({ rows: evidence }, null, 2)}\n`,
    "utf8",
  );
});

const EXPECTED_SLICE: ReadonlyArray<{ route: string; label: string }> = [
  { route: "/", label: "Görev Oluştur" },
  { route: "/scenarios", label: "Gider %10 artarsa" },
  { route: "/scenarios", label: "Gelir %10 artarsa" },
  { route: "/scenarios", label: "Senaryoyu çalıştır" },
  { route: "/scenarios/compare", label: "Matrisi Güncelle" },
  { route: "/scenarios/history", label: "Arşivle" },
  { route: "/scenarios/optimization", label: "Çalıştır ve kaydet" },
  { route: "/insights/ask", label: "Cevapla" },
  { route: "/insights/ask", label: "Gecikmiş açık satış ve alış faturaları ne kadar?" },
  { route: "/insights/ask", label: "13 haftalık likidite ve kasa projeksiyonu nedir?" },
  { route: "/insights/ask", label: "TDHP 102 mizan bakiyesi ve yönetim EBITDA tutarı nedir?" },
  { route: "/insights/ask", label: "Son 30 günlük banka hareketleri ve eşleşmemiş ekstre satırları neler?" },
  { route: "/insights/ask", label: "Cari bakiye ve çek yoğunlaşması en yüksek firmalar hangileri?" },
  { route: "/insights/ask", label: "Üretim parça marjları, tarife kartları ve OEE durumu nedir?" },
  { route: "/insights/ask", label: "Aktif kredi kovenant ve DSCR boşluğu ne durumda?" },
  { route: "/insights/briefing", label: "Brifingi Kanallara Gönder" },
  { route: "/insights/briefing", label: "Brifingi üret ve kaydet" },
  { route: "/insights/reports", label: "Haftalık üret →" },
  { route: "/insights/reports", label: "Aylık üret →" },
  { route: "/insights/reports", label: "Yönetim Kurulu & Banka Paketi üret →" },
  { route: "/insights/reports", label: "Brifingi Kanallara Gönder" },
  { route: "/insights/reports", label: "Telegram'a ilet" },
  { route: "/insights/tasks", label: "Engelle" },
  { route: "/insights/tasks", label: "İptal" },
  { route: "/insights/tasks", label: "Tamamla" },
  { route: "/insights/tasks", label: "Görevi Oluştur" },
  { route: "/production/costs", label: "Kârlılığı Şimdi Yeniden Hesapla" },
  { route: "/insights/reminders", label: "Vade Taraması Çalıştır →" },
  { route: "/insights/reminders", label: "Bekleyenleri Gönder →" },
  { route: "/insights/reminders", label: "Kaydet" },
  { route: "/insights/reminders", label: "Pasife Al" },
  { route: "/production", label: "Parametreyi kaydet" },
  { route: "/production/costs", label: "Maliyet kalemini kaydet" },
  { route: "/production/costs", label: "Tarifeyi kaydet ve kârlılığı yenile" },
  { route: "/production/costs", label: "Parçayı kaydet" },
  { route: "/production/costs", label: "Ürünü kaydet" },
  { route: "/production/roi", label: "Makineyi kaydet" },
];

let uniqueCounter = 0;
function uniqueStamp(): string {
  uniqueCounter += 1;
  return `${Date.now()}-${uniqueCounter}`;
}

async function count(sql: string, params: unknown[] = []): Promise<number> {
  return Number((await scalar<string | number>(sql, params)) ?? 0);
}

/**
 * Uzun süreli tam paket koşularında 60 dakikalık boşta kalma sınırı (`src/lib/auth.ts`) devreye
 * girdiğinde oturumu gerçek `/login` formundan tazeleyip rotayı yeniden açar.
 */
async function openAndGotoReady(browser: Browser, role: SeededRole, route: string): Promise<RoleSession> {
  let session = await openAs(browser, role);
  await session.page.goto(route, { waitUntil: "domcontentloaded" });
  if (new URL(session.page.url()).pathname.startsWith("/login")) {
    await session.context.close();
    await refreshRoleSession(browser, role);
    session = await openAs(browser, role);
    await session.page.goto(route, { waitUntil: "domcontentloaded" });
  }
  expect(
    new URL(session.page.url()).pathname.startsWith("/login"),
    `${role} rolü ${route} rotasında /login ekranına düştü`,
  ).toBe(false);
  await waitForWorkspaceReady(session.page);
  return session;
}

/**
 * Envanterden YALNIZ `tag === "button"` olan kontrol imzasını çözer; envanterde yoksa tıklanacak
 * gerçek düğme öğesinden aynı formülle (`button|type|label|actionId`) çıkarır.
 *
 * Not: `signatureFor(route, label)` etiket bazlı aradığı için `/insights/tasks` ekranındaki
 * `<a href="/insights/tasks?status=cancelled">İptal</a>` sekmesi ile `<button>İptal</button>`
 * mutasyon düğmesini karıştırabilir; `c.tag === "button"` filtresi bu çakışmayı önler.
 */
async function buttonSignature(button: Locator, route: string, label: string): Promise<string> {
  try {
    const inv = loadRuntimeInventory();
    const hit = inv.controls.find((c) => c.route === route && c.tag === "button" && c.label === label);
    if (hit) return hit.signature;
  } catch {
    // runtime-inventory henüz yoksa doğrudan canlı DOM düğmesinden üret.
  }
  return button.evaluate((node, expectedLabel: string) => {
    const btn = node as HTMLButtonElement;
    const form = btn.closest("form");
    let actionId: string | null = null;
    if (form) {
      const hidden = form.querySelector('input[name^="$ACTION_ID_"]');
      if (hidden) actionId = hidden.getAttribute("name");
      else if (form.querySelector('input[name="$ACTION_REF_1"]')) actionId = "$ACTION_REF_1";
    }
    const type = btn.getAttribute("type") ?? "";
    return `button|${type}|${expectedLabel}|${actionId ?? btn.getAttribute("href") ?? ""}`;
  }, label);
}

/** `<details><summary>...</summary></details>` bloğu kapalıysa gerçek tıklamayla açar. */
async function ensureDetailsOpen(page: Page, summaryText: string): Promise<Locator> {
  const details = page
    .locator("details")
    .filter({ has: page.locator("summary", { hasText: summaryText }) })
    .first();
  await expect(details, `'${summaryText}' açıklama bloğu bulunamadı`).toBeVisible({ timeout: 15_000 });
  const isOpen = await details.evaluate((el) => (el as HTMLDetailsElement).open);
  if (!isOpen) {
    await details.locator("summary").first().click();
  }
  await expect
    .poll(() => details.evaluate((el) => (el as HTMLDetailsElement).open), { timeout: 5_000 })
    .toBe(true);
  return details;
}

/* ── Tekrar çalıştırılabilir PostgreSQL fixture kurucuları ───────────────────────────────── */

async function userIdFor(role: SeededRole): Promise<string> {
  return db(async (c) => {
    const r = await c.query<{ id: string }>("select id from public.users where username = $1 limit 1", [
      usernameFor(role),
    ]);
    const id = r.rows[0]?.id;
    expect(id, `${role} kullanıcısı bulunamadı — globalSetup çalışmamış olabilir`).toBeTruthy();
    return id!;
  });
}

/**
 * Senaryo ekranları (`/scenarios`, `/scenarios/optimization`) ve Ana Ekran (`/`) için en az bir
 * kilitli olmayan `cashflow_months` satırı garanti eder (`0100` dönem kilidi tetikleyicisine takılmaz).
 */
async function ensureCashflowBaseline(): Promise<void> {
  await db(async (c) => {
    const existing = await c.query<{ n: number }>("select count(*)::int as n from public.cashflow_months");
    if ((existing.rows[0]?.n ?? 0) > 0) return;
    await c.query(
      `insert into public.cashflow_months
         (month_start, opening_balance, projected_income, projected_expense, monthly_delta, closing_balance, confidence, status)
       values
         ('2026-08-01', 250000.00, 180000.00, 120000.00, 60000.00, 310000.00, 'calculated', 'draft')
       on conflict (month_start) do nothing`,
    );
  });
}

/**
 * `/` üzerindeki `Görev oluştur` (`createActionFromHomeSignal`) aynı `source_fact_key` için açık
 * (`open | in_progress | blocked`) bir `home_action` kaydı varsa idempotent olarak mevcut satırı
 * döndürür. Gerçek INSERT ve `audit_logs` yazımını her koşuda kanıtlamak için mevcut açık
 * `home_action` satırları önce `cancelled` durumuna çekilir.
 */
async function setupHomeActionPrecondition(): Promise<void> {
  await ensureCashflowBaseline();
  await db(async (c) => {
    await c.query(
      `update public.action_items
          set status = 'cancelled'
        where source_type = 'home_action'
          and status in ('open', 'in_progress', 'blocked')`,
    );
  });
}

/** `/scenarios/history` arşivleme testi için taze, arşivlenmemiş bir `scenario_runs` kaydı üretir. */
async function createUnarchivedScenarioRun(role: SeededRole): Promise<string> {
  const actorId = await userIdFor(role);
  const stamp = uniqueStamp();
  return db(async (c) => {
    const scen = await c.query<{ id: string }>(
      `insert into public.scenarios (name, scenario_type, baseline_label, baseline_month_count, created_by)
       values ($1, 'revenue_up_down_percent', 'etkilesim-baz', 1, $2)
       returning id`,
      [`IX Arşiv Senaryosu ${stamp}`, actorId],
    );
    const run = await c.query<{ id: string }>(
      `insert into public.scenario_runs
         (scenario_id, assumptions, baseline_final_cash, scenario_final_cash, final_delta,
          max_cash_gap, month_count, null_month_count, confidence, notes)
       values ($1, '{"revenuePct":0.1}'::jsonb, 100000.00, 118000.00, 18000.00, 0.00, 1, 0, 'medium', 'IX arşiv testi')
       returning id`,
      [scen.rows[0].id],
    );
    return run.rows[0].id;
  });
}

/** `/scenarios/compare` karşılaştırma testi için iki ayrık `scenario_runs` + `scenario_run_lines` çifti üretir. */
async function ensureComparableScenarioRuns(role: SeededRole): Promise<{
  runAId: string;
  runBId: string;
  nameA: string;
  nameB: string;
}> {
  const actorId = await userIdFor(role);
  const stamp = uniqueStamp();
  const nameA = `IX Karşılaştırma A ${stamp}`;
  const nameB = `IX Karşılaştırma B ${stamp}`;
  return db(async (c) => {
    const sA = await c.query<{ id: string }>(
      `insert into public.scenarios (name, scenario_type, baseline_label, baseline_month_count, created_by)
       values ($1, 'revenue_up_down_percent', 'etkilesim-baz', 1, $2)
       returning id`,
      [nameA, actorId],
    );
    const rA = await c.query<{ id: string }>(
      `insert into public.scenario_runs
         (scenario_id, assumptions, baseline_final_cash, scenario_final_cash, final_delta,
          max_cash_gap, month_count, null_month_count, confidence, notes)
       values ($1, '{"revenuePct":0.15}'::jsonb, 200000.00, 230000.00, 30000.00, 0.00, 1, 0, 'medium', 'IX compare A')
       returning id`,
      [sA.rows[0].id],
    );
    await c.query(
      `insert into public.scenario_run_lines
         (run_id, month_start, baseline_income, scenario_income, baseline_expense, scenario_expense,
          baseline_closing, scenario_closing, delta)
       values ($1, '2026-08-01', 150000.00, 180000.00, 100000.00, 100000.00, 200000.00, 230000.00, 30000.00)
       on conflict (run_id, month_start) do nothing`,
      [rA.rows[0].id],
    );

    const sB = await c.query<{ id: string }>(
      `insert into public.scenarios (name, scenario_type, baseline_label, baseline_month_count, created_by)
       values ($1, 'expense_up_down_percent', 'etkilesim-baz', 1, $2)
       returning id`,
      [nameB, actorId],
    );
    const rB = await c.query<{ id: string }>(
      `insert into public.scenario_runs
         (scenario_id, assumptions, baseline_final_cash, scenario_final_cash, final_delta,
          max_cash_gap, month_count, null_month_count, confidence, notes)
       values ($1, '{"expensePct":0.10}'::jsonb, 200000.00, 185000.00, -15000.00, 15000.00, 1, 0, 'medium', 'IX compare B')
       returning id`,
      [sB.rows[0].id],
    );
    await c.query(
      `insert into public.scenario_run_lines
         (run_id, month_start, baseline_income, scenario_income, baseline_expense, scenario_expense,
          baseline_closing, scenario_closing, delta)
       values ($1, '2026-08-01', 150000.00, 150000.00, 100000.00, 115000.00, 200000.00, 185000.00, -15000.00)
       on conflict (run_id, month_start) do nothing`,
      [rB.rows[0].id],
    );

    return { runAId: rA.rows[0].id, runBId: rB.rows[0].id, nameA, nameB };
  });
}

/** `/insights/reports` üzerinde satır içi `Telegram'a ilet` düğmesinin görünmesi için en az 1 rapor garanti eder. */
async function ensureAtLeastOneReport(): Promise<void> {
  await db(async (c) => {
    const existing = await c.query<{ id: string }>("select id from public.reports limit 1");
    if ((existing.rowCount ?? 0) > 0) return;
    await c.query(
      `insert into public.reports (report_type, period_start, period_end, body_md, meta)
       values (
         'daily',
         (now() at time zone 'Europe/Istanbul')::date,
         (now() at time zone 'Europe/Istanbul')::date,
         '# IX Günlük Özet',
         '{"fixture":true}'::jsonb
       )`,
    );
  });
}

/**
 * `/insights/tasks` aksiyonları (`Engelle`, `İptal`, `Tamamla`) için tıklayacak rolün SAHİP OLDUĞU
 * (`created_by = ownerId`, `OWNER_SCOPED` RLS) ve listenin en üstünde yer alan (`severity = 'critical'`)
 * taze bir `'open'` görev üretir.
 */
async function createDedicatedOpenTaskOwnedBy(role: SeededRole, labelHint: string): Promise<string> {
  const ownerId = await userIdFor(role);
  const stamp = uniqueStamp();
  return db(async (c) => {
    const ins = await c.query<{ id: string }>(
      `insert into public.action_items (title, status, severity, source_type, owner, note, created_by)
       values ($1, 'open', 'critical', 'manual', 'Finans Operasyon', 'IX görev yaşam döngüsü', $2)
       returning id`,
      [`IX-${labelHint}-${stamp}`, ownerId],
    );
    return ins.rows[0].id;
  });
}

/** `/insights/reminders` `Kaydet` formunun her koşuda yeni bir `public.reminders` satırı eklemesini garanti eder. */
async function clearReminderSaveSlot(offsetDays: number): Promise<void> {
  await db(async (c) => {
    await c.query(
      "delete from public.reminders where target_kind = 'invoice' and offset_days = $1 and channel = 'email'",
      [offsetDays],
    );
  });
}

/** `/insights/reminders` `Pasife Al` düğmesi için aktif (`is_active = true`) bir kural garanti eder. */
async function ensureActiveReminderRuleForToggle(): Promise<string> {
  return db(async (c) => {
    const r = await c.query<{ id: string }>(
      `insert into public.reminders (name, target_kind, offset_days, channel, min_amount, is_active)
       values ('IX Pasife Al Kuralı', 'promise_to_pay', 212, 'email', 100.00, true)
       on conflict (target_kind, offset_days, channel) do update
         set name = excluded.name,
             is_active = true
       returning id`,
    );
    return r.rows[0].id;
  });
}

/**
 * `/insights/reminders` `Vade taraması çalıştır` aksiyonu için dönem kilidinden (`0100`) bağımsız
 * bir `promise_to_pay` vadesi (bugün) ve buna eşleşen aktif `offset_days = 0` kuralı kurar.
 */
async function setupDuePromiseScanFixture(): Promise<string> {
  const stamp = uniqueStamp();
  return db(async (c) => {
    await c.query(
      `insert into public.reminders (name, target_kind, offset_days, channel, min_amount, is_active)
       values ('IX Söz Vade Bugün', 'promise_to_pay', 0, 'email', null, true)
       on conflict (target_kind, offset_days, channel) do update
         set is_active = true,
             min_amount = null`,
    );
    const party = await c.query<{ id: string }>(
      `insert into public.parties (name, normalized_name, party_type, is_active)
       values ($1, $2, 'customer', true)
       returning id`,
      [`IX Hatırlatma Cari ${stamp}`, `ix_hatirlatma_cari_${stamp}`],
    );
    const ptp = await c.query<{ id: string }>(
      `insert into public.promise_to_pay (party_id, promised_amount, currency, promised_date, status, channel, note)
       values ($1, 14500.00, 'TRY', (now() at time zone 'Europe/Istanbul')::date, 'pending', 'phone', 'IX vade tarama testi')
       returning id`,
      [party.rows[0].id],
    );
    return ptp.rows[0].id;
  });
}

/**
 * `/insights/reminders` `Bekleyenleri gönder` aksiyonu için bugün vadeli `'pending'` bir
 * `reminder_deliveries` satırı hazırlar.
 */
async function setupPendingReminderDeliveryFixture(): Promise<string> {
  const stamp = uniqueStamp();
  return db(async (c) => {
    const rule = await c.query<{ id: string }>(
      `insert into public.reminders (name, target_kind, offset_days, channel, min_amount, is_active)
       values ('IX Bekleyen Teslimat Kuralı', 'promise_to_pay', 213, 'email', null, true)
       on conflict (target_kind, offset_days, channel) do update
         set is_active = true
       returning id`,
    );
    const party = await c.query<{ id: string }>(
      `insert into public.parties (name, normalized_name, party_type, is_active)
       values ($1, $2, 'customer', true)
       returning id`,
      [`IX Teslimat Cari ${stamp}`, `ix_teslimat_cari_${stamp}`],
    );
    const ptp = await c.query<{ id: string }>(
      `insert into public.promise_to_pay (party_id, promised_amount, currency, promised_date, status, channel, note)
       values ($1, 18250.00, 'TRY', (now() at time zone 'Europe/Istanbul')::date, 'pending', 'email', 'IX teslimat testi')
       returning id`,
      [party.rows[0].id],
    );
    const deliv = await c.query<{ id: string }>(
      `insert into public.reminder_deliveries (reminder_id, entity_table, entity_id, scheduled_for, status, payload)
       values ($1, 'promise_to_pay', $2, (now() at time zone 'Europe/Istanbul')::date, 'pending', '{"message":"IX bekleyen hatırlatma iletisi"}'::jsonb)
       returning id`,
      [rule.rows[0].id, ptp.rows[0].id],
    );
    return deliv.rows[0].id;
  });
}

/**
 * `/production/costs` `Kârlılığı Şimdi Yeniden Hesapla` düğmesi için baz `cost_models` kaydını ve
 * henüz `part_profitability_runs` satırı bulunmayan taze bir `production_parts` kaydını kurar.
 */
async function setupProfitabilityRecalcFixture(): Promise<string> {
  const stamp = uniqueStamp();
  return db(async (c) => {
    const capCount = await c.query<{ n: number }>("select count(*)::int as n from public.capacity_models");
    let capId: string;
    if ((capCount.rows[0]?.n ?? 0) === 0) {
      const capIns = await c.query<{ id: string }>(
        `insert into public.capacity_models
           (name, scenario_type, monthly_hours, monthly_minutes, work_days_per_month, efficiency_rate,
            torna_rate_tl_per_min, freze_rate_tl_per_min, rate_year, is_stale_rate)
         values ('IX Baz Kapasite', 'normal', 176, 8976, 22, 0.85, 22.00, 26.00, 2026, false)
         returning id`,
      );
      capId = capIns.rows[0].id;
    } else {
      capId = (await c.query<{ id: string }>("select id from public.capacity_models order by created_at asc limit 1"))
        .rows[0].id;
    }

    const cmCount = await c.query<{ n: number }>("select count(*)::int as n from public.cost_models");
    if ((cmCount.rows[0]?.n ?? 0) === 0) {
      await c.query(
        `insert into public.cost_models
           (capacity_model_id, model_name, scenario_type, total_fixed_cost, monthly_allocated_cost,
            break_even_torna_tl_per_min, break_even_freze_tl_per_min, break_even_tl_per_min, effective_monthly_minutes)
         values ($1, 'IX Baz Maliyet Modeli', 'normal', 140000.00, 140000.00, 15.60, 15.60, 15.60, 8976)`,
        [capId],
      );
    }

    const part = await c.query<{ id: string }>(
      `insert into public.production_parts
         (part_code, part_name, quantity, torna_minutes, freze_minutes, unit_sale_price, currency, notes)
       values ($1, $2, 15, 6.5, 7.5, 490.00, 'TRY', 'IX karlılık yeniden hesaplama')
       returning id`,
      [`IX-RCLC-${stamp}`, `IX Karlılık Parçası ${stamp}`],
    );
    return part.rows[0].id;
  });
}

/* ── Server Action mutasyon vakası şablonu (33 vaka) ─────────────────────────────────────── */

interface ServerMutationContext {
  targetId: string | null;
  stamp: string;
}

interface ServerMutationCase {
  id: string;
  route: string;
  label: string;
  role: SeededRole;
  setup?: (stamp: string) => Promise<string | void>;
  locateButton?: (page: Page, ctx: ServerMutationContext) => Promise<Locator>;
  fill?: (page: Page, button: Locator, ctx: ServerMutationContext) => Promise<void>;
  countSql: (ctx: ServerMutationContext) => string;
  auditSql?: (ctx: ServerMutationContext) => string;
  afterExtraAssert?: (page: Page, ctx: ServerMutationContext) => Promise<string | void>;
}

const SERVER_MUTATION_CASES: ServerMutationCase[] = [
  {
    id: "home/create-task-from-insight",
    route: "/",
    label: "Görev Oluştur",
    role: "finance_operator",
    setup: async () => {
      await setupHomeActionPrecondition();
    },
    locateButton: async (page) => {
      const details = await ensureDetailsOpen(page, "Bugün Yapılacaklar");
      return details.getByRole("button", { name: "Görev Oluştur", exact: true }).first();
    },
    countSql: () =>
      "select count(*)::int from public.action_items where source_type = 'home_action' and status = 'open'",
    auditSql: () =>
      "select count(*)::int from public.audit_logs where entity_table = 'action_items' and action = 'create_action_from_home'",
  },
  {
    id: "scenarios/preset-expense-up-10",
    route: "/scenarios",
    label: "Gider %10 artarsa",
    role: "finance_operator",
    setup: async () => {
      await ensureCashflowBaseline();
    },
    countSql: () => "select count(*)::int from public.scenario_runs",
    auditSql: () =>
      "select count(*)::int from public.audit_logs where entity_table = 'scenario_runs' and action = 'run_scenario'",
  },
  {
    id: "scenarios/preset-revenue-up-10",
    route: "/scenarios",
    label: "Gelir %10 artarsa",
    role: "finance_operator",
    setup: async () => {
      await ensureCashflowBaseline();
    },
    countSql: () => "select count(*)::int from public.scenario_runs",
    auditSql: () =>
      "select count(*)::int from public.audit_logs where entity_table = 'scenario_runs' and action = 'run_scenario'",
  },
  {
    id: "scenarios/custom-run",
    route: "/scenarios",
    label: "Senaryoyu çalıştır",
    role: "finance_operator",
    setup: async () => {
      await ensureCashflowBaseline();
    },
    fill: async (_page, button, { stamp }) => {
      const form = button.locator("xpath=ancestor::form[1]");
      await form.locator('input[name="name"]').fill(`IX Özel Senaryo ${stamp}`);
      await form.locator('input[name="revenuePct"]').fill("12.5");
    },
    countSql: ({ stamp }) =>
      `select count(*)::int from public.scenario_runs r join public.scenarios s on s.id = r.scenario_id where s.name = 'IX Özel Senaryo ${stamp}'`,
    auditSql: () =>
      "select count(*)::int from public.audit_logs where entity_table = 'scenario_runs' and action = 'run_scenario'",
  },
  {
    id: "scenarios/history-archive",
    route: "/scenarios/history",
    label: "Arşivle",
    role: "finance_manager",
    setup: async () => createUnarchivedScenarioRun("finance_manager"),
    locateButton: async (page, { targetId }) =>
      page
        .locator("form")
        .filter({ has: page.locator(`input[name="id"][value="${targetId}"]`) })
        .getByRole("button", { name: "Arşivle", exact: true })
        .first(),
    countSql: ({ targetId }) =>
      `select count(*)::int from public.scenario_runs where id = '${targetId}' and archived_at is not null`,
    auditSql: ({ targetId }) =>
      `select count(*)::int from public.audit_logs where entity_table = 'scenario_runs' and entity_id::text = '${targetId}' and action = 'archive_record'`,
  },
  {
    id: "scenarios/optimization-run-save",
    route: "/scenarios/optimization",
    label: "Çalıştır ve kaydet",
    role: "finance_operator",
    setup: async () => {
      await ensureCashflowBaseline();
    },
    countSql: () => "select count(*)::int from public.scenario_runs",
    auditSql: () =>
      "select count(*)::int from public.audit_logs where entity_table = 'scenario_runs' and action = 'run_scenario'",
  },
  {
    id: "insights/ask-answer",
    route: "/insights/ask",
    label: "Cevapla",
    role: "finance_operator",
    fill: async (_page, button, { stamp }) => {
      const form = button.locator("xpath=ancestor::form[1]");
      await form
        .locator('textarea[name="question"]')
        .fill(`Önümüzdeki 7 günde toplam nakit çıkışı ne kadar? (${stamp})`);
      const detCheckbox = form.locator('input[name="forceDeterministic"]');
      if ((await detCheckbox.count()) > 0 && !(await detCheckbox.isChecked())) {
        await detCheckbox.check();
      }
    },
    countSql: () => "select count(*)::int from public.ai_response_snapshots",
    auditSql: () => "select count(*)::int from public.audit_logs where entity_table = 'ai_response_snapshots'",
  },
  {
    id: "insights/ask-suggested-1",
    route: "/insights/ask",
    label: "Gecikmiş açık satış ve alış faturaları ne kadar?",
    role: "finance_operator",
    countSql: () => "select count(*)::int from public.ai_response_snapshots",
    auditSql: () => "select count(*)::int from public.audit_logs where entity_table = 'ai_response_snapshots'",
  },
  {
    id: "insights/ask-suggested-2",
    route: "/insights/ask",
    label: "13 haftalık likidite ve kasa projeksiyonu nedir?",
    role: "finance_operator",
    countSql: () => "select count(*)::int from public.ai_response_snapshots",
    auditSql: () => "select count(*)::int from public.audit_logs where entity_table = 'ai_response_snapshots'",
  },
  {
    id: "insights/ask-suggested-3",
    route: "/insights/ask",
    label: "TDHP 102 mizan bakiyesi ve yönetim EBITDA tutarı nedir?",
    role: "finance_operator",
    countSql: () => "select count(*)::int from public.ai_response_snapshots",
    auditSql: () => "select count(*)::int from public.audit_logs where entity_table = 'ai_response_snapshots'",
  },
  {
    id: "insights/ask-suggested-4",
    route: "/insights/ask",
    label: "Son 30 günlük banka hareketleri ve eşleşmemiş ekstre satırları neler?",
    role: "finance_operator",
    countSql: () => "select count(*)::int from public.ai_response_snapshots",
    auditSql: () => "select count(*)::int from public.audit_logs where entity_table = 'ai_response_snapshots'",
  },
  {
    id: "insights/ask-suggested-5",
    route: "/insights/ask",
    label: "Cari bakiye ve çek yoğunlaşması en yüksek firmalar hangileri?",
    role: "finance_operator",
    countSql: () => "select count(*)::int from public.ai_response_snapshots",
    auditSql: () => "select count(*)::int from public.audit_logs where entity_table = 'ai_response_snapshots'",
  },
  {
    id: "insights/ask-suggested-6",
    route: "/insights/ask",
    label: "Üretim parça marjları, tarife kartları ve OEE durumu nedir?",
    role: "finance_operator",
    countSql: () => "select count(*)::int from public.ai_response_snapshots",
    auditSql: () => "select count(*)::int from public.audit_logs where entity_table = 'ai_response_snapshots'",
  },
  {
    id: "insights/ask-suggested-7",
    route: "/insights/ask",
    label: "Aktif kredi kovenant ve DSCR boşluğu ne durumda?",
    role: "finance_operator",
    countSql: () => "select count(*)::int from public.ai_response_snapshots",
    auditSql: () => "select count(*)::int from public.audit_logs where entity_table = 'ai_response_snapshots'",
  },
  {
    id: "insights/briefing-generate",
    route: "/insights/briefing",
    label: "Brifingi üret ve kaydet",
    role: "finance_operator",
    countSql: () => "select count(*)::int from public.reports where report_type = 'cfo_briefing'",
    auditSql: () => "select count(*)::int from public.audit_logs where entity_table = 'reports'",
  },
  {
    id: "insights/briefing-dispatch",
    route: "/insights/briefing",
    label: "Brifingi Kanallara Gönder",
    role: "finance_operator",
    countSql: () =>
      "select count(*)::int from public.audit_logs where entity_table = 'reports' and action = 'dispatch_cfo_briefing'",
    afterExtraAssert: async (page) => {
      await expect
        .poll(
          () => {
            const u = new URL(page.url());
            return u.searchParams.has("dispatched") || u.searchParams.has("dispatchError");
          },
          {
            timeout: 15_000,
            message: "/insights/briefing kanal gönderimi dürüst teslimat sonucu (dispatched / dispatchError) üretmeli",
          },
        )
        .toBe(true);
      return `URL durum kanıtı: ${new URL(page.url()).search}`;
    },
  },
  {
    id: "insights/reports-weekly",
    route: "/insights/reports",
    label: "Haftalık üret →",
    role: "finance_operator",
    countSql: () => "select count(*)::int from public.reports where report_type = 'weekly'",
    auditSql: () => "select count(*)::int from public.audit_logs where entity_table = 'reports'",
  },
  {
    id: "insights/reports-monthly",
    route: "/insights/reports",
    label: "Aylık üret →",
    role: "finance_operator",
    countSql: () => "select count(*)::int from public.reports where report_type = 'monthly'",
    auditSql: () => "select count(*)::int from public.audit_logs where entity_table = 'reports'",
  },
  {
    id: "insights/reports-board-pack",
    route: "/insights/reports",
    label: "Yönetim Kurulu & Banka Paketi üret →",
    role: "finance_operator",
    countSql: () => "select count(*)::int from public.reports where report_type = 'strategic'",
    auditSql: () => "select count(*)::int from public.audit_logs where entity_table = 'reports'",
  },
  {
    id: "insights/reports-dispatch-briefing",
    route: "/insights/reports",
    label: "Brifingi Kanallara Gönder",
    role: "finance_operator",
    countSql: () =>
      "select count(*)::int from public.audit_logs where entity_table = 'reports' and action = 'dispatch_cfo_briefing'",
    afterExtraAssert: async (page) => {
      await expect
        .poll(
          () => {
            const u = new URL(page.url());
            return u.searchParams.has("dispatched") || u.searchParams.has("dispatchError");
          },
          {
            timeout: 15_000,
            message: "/insights/reports kanal gönderimi dürüst teslimat sonucu (dispatched / dispatchError) üretmeli",
          },
        )
        .toBe(true);
      return `URL durum kanıtı: ${new URL(page.url()).search}`;
    },
  },
  {
    id: "insights/reports-send-telegram",
    route: "/insights/reports",
    label: "Telegram'a ilet",
    role: "finance_operator",
    setup: async () => {
      await ensureAtLeastOneReport();
    },
    countSql: () =>
      "select count(*)::int from public.audit_logs where entity_table = 'reports' and action = 'dispatch_cfo_briefing'",
    afterExtraAssert: async (page) => {
      await expect
        .poll(
          () => {
            const u = new URL(page.url());
            return u.searchParams.has("dispatched") || u.searchParams.has("dispatchError");
          },
          {
            timeout: 15_000,
            message: "/insights/reports Telegram iletimi dürüst teslimat sonucu (dispatched / dispatchError) üretmeli",
          },
        )
        .toBe(true);
      return `URL durum kanıtı: ${new URL(page.url()).search}`;
    },
  },
  {
    id: "insights/tasks-block",
    route: "/insights/tasks",
    label: "Engelle",
    role: "finance_operator",
    setup: async () => createDedicatedOpenTaskOwnedBy("finance_operator", "engelle"),
    locateButton: async (page, { targetId }) =>
      page
        .locator("form")
        .filter({
          has: page.locator(`input[name="id"][value="${targetId}"]`),
        })
        .filter({
          has: page.locator('input[name="status"][value="blocked"]'),
        })
        .getByRole("button", { name: "Engelle", exact: true })
        .first(),
    countSql: ({ targetId }) =>
      `select count(*)::int from public.action_items where id = '${targetId}' and status = 'blocked'`,
    auditSql: ({ targetId }) =>
      `select count(*)::int from public.audit_logs where entity_table = 'action_items' and entity_id::text = '${targetId}' and action = 'set_action_status'`,
  },
  {
    id: "insights/tasks-cancel",
    route: "/insights/tasks",
    label: "İptal",
    role: "finance_operator",
    setup: async () => createDedicatedOpenTaskOwnedBy("finance_operator", "iptal"),
    locateButton: async (page, { targetId }) =>
      page
        .locator("form")
        .filter({
          has: page.locator(`input[name="id"][value="${targetId}"]`),
        })
        .filter({
          has: page.locator('input[name="status"][value="cancelled"]'),
        })
        .getByRole("button", { name: "İptal", exact: true })
        .first(),
    countSql: ({ targetId }) =>
      `select count(*)::int from public.action_items where id = '${targetId}' and status = 'cancelled'`,
    auditSql: ({ targetId }) =>
      `select count(*)::int from public.audit_logs where entity_table = 'action_items' and entity_id::text = '${targetId}' and action = 'set_action_status'`,
  },
  {
    id: "insights/tasks-complete",
    route: "/insights/tasks",
    label: "Tamamla",
    role: "finance_operator",
    setup: async () => createDedicatedOpenTaskOwnedBy("finance_operator", "tamamla"),
    locateButton: async (page, { targetId }) =>
      page
        .locator("form")
        .filter({
          has: page.locator(`input[name="id"][value="${targetId}"]`),
        })
        .filter({
          has: page.locator('input[name="status"][value="done"]'),
        })
        .getByRole("button", { name: "Tamamla", exact: true })
        .first(),
    fill: async (_page, button) => {
      const form = button.locator("xpath=ancestor::form[1]");
      await form.locator('input[name="completionNote"]').fill("Etkileşim doğrulaması kapanış kanıtı");
    },
    countSql: ({ targetId }) =>
      `select count(*)::int from public.action_items where id = '${targetId}' and status = 'done' and note ilike '%Etkileşim doğrulaması kapanış kanıtı%'`,
    auditSql: ({ targetId }) =>
      `select count(*)::int from public.audit_logs where entity_table = 'action_items' and entity_id::text = '${targetId}' and action = 'set_action_status'`,
  },
  {
    id: "insights/tasks-create",
    route: "/insights/tasks",
    label: "Görevi Oluştur",
    role: "finance_operator",
    fill: async (_page, button, { stamp }) => {
      const form = button.locator("xpath=ancestor::form[1]");
      await form.locator('input[name="title"]').fill(`IX Manuel Görev ${stamp}`);
      await form.locator('select[name="severity"]').selectOption("high");
      await form.locator('input[name="owner"]').fill("Finans Operasyon");
      await form.locator('textarea[name="note"]').fill("Manuel görev oluşturma kanıtı");
    },
    countSql: ({ stamp }) =>
      `select count(*)::int from public.action_items where source_type = 'manual' and title = 'IX Manuel Görev ${stamp}'`,
    auditSql: () =>
      "select count(*)::int from public.audit_logs where entity_table = 'action_items' and action = 'create_manual_action'",
  },
  {
    id: "production/costs-recalculate-profitability",
    route: "/production/costs",
    label: "Kârlılığı Şimdi Yeniden Hesapla",
    role: "finance_operator",
    setup: async () => setupProfitabilityRecalcFixture(),
    countSql: ({ targetId }) =>
      `select count(*)::int from public.part_profitability_runs where part_id = '${targetId}'`,
  },
  {
    id: "insights/reminders-plan-due-scan",
    route: "/insights/reminders",
    label: "Vade Taraması Çalıştır →",
    role: "finance_operator",
    setup: async () => setupDuePromiseScanFixture(),
    countSql: ({ targetId }) =>
      `select count(*)::int from public.reminder_deliveries where entity_table = 'promise_to_pay' and entity_id = '${targetId}'`,
  },
  {
    id: "insights/reminders-dispatch-pending",
    route: "/insights/reminders",
    label: "Bekleyenleri Gönder →",
    role: "finance_operator",
    setup: async () => setupPendingReminderDeliveryFixture(),
    countSql: ({ targetId }) =>
      `select count(*)::int from public.reminder_deliveries where id = '${targetId}' and status in ('sent', 'skipped', 'failed')`,
  },
  {
    id: "insights/reminders-save-rule",
    route: "/insights/reminders",
    label: "Kaydet",
    role: "finance_operator",
    setup: async () => {
      await clearReminderSaveSlot(211);
    },
    locateButton: async (page) => {
      const details = await ensureDetailsOpen(page, "+ Yeni hatırlatma kuralı ekle");
      return details.getByRole("button", { name: "Kaydet", exact: true }).first();
    },
    fill: async (_page, button, { stamp }) => {
      const form = button.locator("xpath=ancestor::form[1]");
      await form.locator('input[name="name"]').fill(`IX Fatura Hatırlatma ${stamp}`);
      await form.locator('select[name="targetKind"]').selectOption("invoice");
      await form.locator('input[name="offsetDays"]').fill("211");
      await form.locator('select[name="channel"]').selectOption("email");
      await form.locator('input[name="minAmount"]').fill("750");
    },
    countSql: () =>
      "select count(*)::int from public.reminders where target_kind = 'invoice' and offset_days = 211 and channel = 'email'",
    auditSql: () => "select count(*)::int from public.audit_logs where entity_table = 'reminders'",
  },
  {
    id: "insights/reminders-toggle-passive",
    route: "/insights/reminders",
    label: "Pasife Al",
    role: "finance_operator",
    setup: async () => ensureActiveReminderRuleForToggle(),
    locateButton: async (page, { targetId }) =>
      page
        .locator("form")
        .filter({ has: page.locator(`input[name="id"][value="${targetId}"]`) })
        .getByRole("button", { name: "Pasife Al", exact: true })
        .first(),
    countSql: ({ targetId }) =>
      `select count(*)::int from public.reminders where id = '${targetId}' and is_active = false`,
    auditSql: ({ targetId }) =>
      `select count(*)::int from public.audit_logs where entity_table = 'reminders' and entity_id::text = '${targetId}'`,
  },
  {
    id: "production/save-capacity-parameter",
    route: "/production",
    label: "Parametreyi kaydet",
    role: "finance_manager",
    locateButton: async (page) => {
      const details = await ensureDetailsOpen(page, "+ Kapasite / vardiya parametresi ekle");
      return details.getByRole("button", { name: "Parametreyi kaydet", exact: true }).first();
    },
    fill: async (_page, button, { stamp }) => {
      const form = button.locator("xpath=ancestor::form[1]");
      await form.locator('input[name="name"]').fill(`IX Kapasite Vardiya ${stamp}`);
      await form.locator('input[name="workDaysPerMonth"]').fill("22");
      await form.locator('input[name="hoursPerDay"]').fill("8");
      await form.locator('input[name="efficiencyRate"]').fill("0.86");
      await form.locator('input[name="tornaRateTLPerMin"]').fill("21.5");
      await form.locator('input[name="frezeRateTLPerMin"]').fill("25.5");
      await form.locator('input[name="notes"]').fill("IX etkileşim kapasite testi");
    },
    countSql: ({ stamp }) =>
      `select count(*)::int from public.capacity_models where name = 'IX Kapasite Vardiya ${stamp}'`,
    auditSql: () =>
      "select count(*)::int from public.audit_logs where entity_table = 'capacity_models' and action = 'upsert_capacity_model_manual'",
  },
  {
    id: "production/costs-save-cost-item",
    route: "/production/costs",
    label: "Maliyet kalemini kaydet",
    role: "finance_manager",
    locateButton: async (page) => {
      const details = await ensureDetailsOpen(page, "+ Sabit maliyet kalemi ekle / güncelle");
      return details.getByRole("button", { name: "Maliyet kalemini kaydet", exact: true }).first();
    },
    fill: async (_page, button, { stamp }) => {
      const form = button.locator("xpath=ancestor::form[1]");
      await form.locator('select[name="scenarioType"]').selectOption("normal");
      await form.locator('input[name="costCategory"]').fill(`IX Atölye Elektrik ${stamp}`);
      await form.locator('input[name="monthlyAmount"]').fill("46800");
      await form.locator('input[name="staffCount"]').fill("6");
      await form.locator('input[name="monthlyWorkHours"]').fill("176");
      await form.locator('input[name="efficiencyRate"]').fill("0.85");
      await form.locator('input[name="description"]').fill("IX etkileşim sabit maliyet kalemi");
    },
    countSql: ({ stamp }) =>
      `select count(*)::int from public.cost_model_items where cost_category = 'IX Atölye Elektrik ${stamp}'`,
    auditSql: () =>
      "select count(*)::int from public.audit_logs where entity_table = 'cost_model_items' and action = 'upsert_cost_model_item_manual'",
  },
  {
    id: "production/costs-save-operation-rates",
    route: "/production/costs",
    label: "Tarifeyi kaydet ve kârlılığı yenile",
    role: "finance_manager",
    locateButton: async (page) => {
      const details = await ensureDetailsOpen(page, "+ Tezgâh / müşteri dakika tarifesi (TL/dk) güncelle");
      return details.getByRole("button", { name: "Tarifeyi kaydet ve kârlılığı yenile", exact: true }).first();
    },
    fill: async (_page, button) => {
      const form = button.locator("xpath=ancestor::form[1]");
      await form.locator('select[name="scenarioType"]').selectOption("normal");
      await form.locator('input[name="tornaRateTLPerMin"]').fill("24.75");
      await form.locator('input[name="frezeRateTLPerMin"]').fill("29.50");
      await form.locator('input[name="effectiveMonthlyMinutes"]').fill("9600");
      await form.locator('input[name="akonTornaTLPerMin"]').fill("31.25");
      await form.locator('input[name="akonFrezeTLPerMin"]').fill("36.50");
      await form.locator('input[name="rateYear"]').fill("2026");
    },
    countSql: () =>
      "select count(*)::int from public.audit_logs where entity_table = 'cost_models' and action = 'upsert_operation_rates_manual'",
    afterExtraAssert: async () => {
      const matched = await count(
        "select count(*)::int from public.cost_models where scenario_type = 'normal' and akon_torna_tl_per_min = 31.25 and akon_freze_tl_per_min = 36.50",
      );
      expect(matched, "cost_models üzerinde Akon torna/freze dakika tarifeleri güncellenmeli").toBeGreaterThanOrEqual(
        1,
      );
      return "cost_models.akon_torna_tl_per_min=31.25 ve akon_freze_tl_per_min=36.50 doğrulandı";
    },
  },
  {
    id: "production/costs-save-part",
    route: "/production/costs",
    label: "Parçayı kaydet",
    role: "finance_manager",
    locateButton: async (page) => {
      const details = await ensureDetailsOpen(
        page,
        "+ Tekil üretim parçası (süre / birim satış fiyatı) ekle veya güncelle",
      );
      return details.getByRole("button", { name: "Parçayı kaydet", exact: true }).first();
    },
    fill: async (_page, button, { stamp }) => {
      const form = button.locator("xpath=ancestor::form[1]");
      await form.locator('input[name="partCode"]').fill(`IX-PRT-${stamp}`);
      await form.locator('input[name="partName"]').fill(`IX Hidrolik Gövde ${stamp}`);
      await form.locator('input[name="quantity"]').fill("25");
      await form.locator('input[name="unitSalePrice"]').fill("540");
      await form.locator('input[name="tornaMinutes"]').fill("6.5");
      await form.locator('input[name="frezeMinutes"]').fill("8.25");
      await form.locator('input[name="otherOperationMinutes"]').fill("1.5");
    },
    countSql: ({ stamp }) =>
      `select count(*)::int from public.production_parts where part_code = 'IX-PRT-${stamp}'`,
    auditSql: () =>
      "select count(*)::int from public.audit_logs where entity_table = 'production_parts' and action = 'upsert_production_part_manual'",
  },
  {
    id: "production/costs-save-catalog-product",
    route: "/production/costs",
    label: "Ürünü kaydet",
    role: "finance_manager",
    locateButton: async (page) => {
      const details = await ensureDetailsOpen(page, "+ Katalog ürünü ekle / güncelle");
      return details.getByRole("button", { name: "Ürünü kaydet", exact: true }).first();
    },
    fill: async (_page, button, { stamp }) => {
      const form = button.locator("xpath=ancestor::form[1]");
      await form.locator('input[name="code"]').fill(`IX-URN-${stamp}`);
      await form.locator('input[name="name"]').fill(`IX CNC Flanş ${stamp}`);
      await form.locator('input[name="unit"]').fill("Adet");
      await form.locator('input[name="notes"]').fill("IX etkileşim katalog ürünü");
    },
    countSql: ({ stamp }) => `select count(*)::int from public.products where code = 'IX-URN-${stamp}'`,
    auditSql: () =>
      "select count(*)::int from public.audit_logs where entity_table = 'products' and action = 'upsert_catalog_product'",
  },
  {
    id: "production/roi-save-machine",
    route: "/production/roi",
    label: "Makineyi kaydet",
    role: "finance_manager",
    locateButton: async (page) => {
      const details = await ensureDetailsOpen(page, "+ Klasik makine / yıllık ROI kaydı ekle veya güncelle");
      return details.getByRole("button", { name: "Makineyi kaydet", exact: true }).first();
    },
    fill: async (_page, button, { stamp }) => {
      const form = button.locator("xpath=ancestor::form[1]");
      // Kişisel veri koruması (`maaş`, `kira`, `aile` vb.) nedeniyle endüstriyel makine adı kullanılır.
      await form.locator('input[name="name"]').fill(`IX CNC İşleme Merkezi ${stamp}`);
      await form.locator('input[name="machineCode"]').fill(`IX-MC-${stamp.slice(-6)}`);
      await form.locator('input[name="purchaseCost"]').fill("1850000");
      await form.locator('input[name="monthlyRevenue"]').fill("82000");
      await form.locator('input[name="monthlyOperatingCost"]').fill("34000");
      await form.locator('input[name="usefulLifeMonths"]').fill("84");
      await form.locator('input[name="snapshotYear"]').fill("2026");
      await form.locator('input[name="annualRevenue"]').fill("984000");
      await form.locator('input[name="annualCost"]').fill("408000");
      await form.locator('input[name="notes"]').fill("IX etkileşim makine ROI kaydı");
    },
    countSql: ({ stamp }) =>
      `select count(*)::int from public.machine_assets ma join public.machine_roi_snapshots s on s.machine_asset_id = ma.id where ma.name = 'IX CNC İşleme Merkezi ${stamp}' and s.snapshot_year = 2026`,
    auditSql: () =>
      "select count(*)::int from public.audit_logs where entity_table = 'machine_assets' and action = 'upsert_machine_roi_manual'",
  },
];

/* ── Statik dilim kapsam kontrolü ────────────────────────────────────────────────────────── */
{
  const covered = new Set<string>([
    ...SERVER_MUTATION_CASES.map((c) => `${c.route}|${c.label}`),
    "/scenarios/compare|Matrisi Güncelle",
  ]);
  if (covered.size !== EXPECTED_SLICE.length) {
    throw new Error(`Dilim kapsam hatası: beklenen ${EXPECTED_SLICE.length}, tanımlanan ${covered.size}`);
  }
  for (const item of EXPECTED_SLICE) {
    const key = `${item.route}|${item.label}`;
    if (!covered.has(key)) {
      throw new Error(`Dilimde eksik kontrol: ${key}`);
    }
  }
}

/* ── 1) 33 Server Action mutasyonunun kanıt zinciri ──────────────────────────────────────── */

for (const tc of SERVER_MUTATION_CASES) {
  test(`${tc.id}: '${tc.label}' (${tc.route}) gerçek tıklama + DB before/after + reload`, async ({ browser }) => {
    test.setTimeout(240_000);

    const stamp = uniqueStamp();
    const setupResult = tc.setup ? await tc.setup(stamp) : undefined;
    const ctx: ServerMutationContext = {
      targetId: typeof setupResult === "string" ? setupResult : null,
      stamp,
    };

    const session = await openAndGotoReady(browser, tc.role, tc.route);
    const { page } = session;

    try {
      const button = tc.locateButton
        ? await tc.locateButton(page, ctx)
        : page.getByRole("button", { name: tc.label, exact: true }).first();

      await expect(
        button,
        `${tc.route} üzerinde '${tc.label}' düğmesi görünür olmalı`,
      ).toBeVisible({ timeout: 20_000 });
      await expect(
        button,
        `${tc.route} üzerinde '${tc.label}' düğmesi etkin (enabled) olmalı`,
      ).toBeEnabled({ timeout: 10_000 });

      if (tc.fill) {
        await tc.fill(page, button, ctx);
      }

      const controlSignature = await buttonSignature(button, tc.route, tc.label);
      const sql = tc.countSql(ctx);
      const aSql = tc.auditSql ? tc.auditSql(ctx) : null;

      const before = await count(sql);
      const auditBefore = aSql ? await count(aSql) : 0;

      const post = page
        .waitForResponse((r) => r.request().method() === "POST", { timeout: 60_000 })
        .catch(() => null);
      await button.click();
      await post;
      await page.waitForLoadState("networkidle", { timeout: 60_000 }).catch(() => {});
      await waitForWorkspaceReady(page);

      const body = await page.locator("body").innerText();
      expect(
        /Application error|Internal Server Error/i.test(body),
        `${tc.id}: uygulama hata ekranı üretti`,
      ).toBe(false);

      const currentUrl = new URL(page.url());
      expect(
        currentUrl.searchParams.get("error"),
        `${tc.id}: aksiyon hata parametresiyle yönlendi (${currentUrl.href})`,
      ).toBeNull();

      await expect
        .poll(
          async () => {
            const now = await count(sql);
            return now > before;
          },
          {
            message: `${tc.id}: DB sayacı artmalı (before=${before}, sql=${sql})`,
            timeout: 30_000,
            intervals: [250, 500, 1000, 2000, 2000],
          },
        )
        .toBe(true);

      const after = await count(sql);

      let auditProof = "audit_logs izi bu aksiyon için ayrı sorgulanmadı";
      if (aSql) {
        await expect
          .poll(async () => (await count(aSql)) > auditBefore, {
            message: `${tc.id}: audit_logs sayacı artmalı (before=${auditBefore})`,
            timeout: 15_000,
            intervals: [250, 500, 1000],
          })
          .toBe(true);
        const auditAfter = await count(aSql);
        auditProof = `audit_logs: ${auditBefore} -> ${auditAfter}`;
      }

      const extraNote = tc.afterExtraAssert ? await tc.afterExtraAssert(page, ctx) : undefined;

      await page.reload({ waitUntil: "domcontentloaded" });
      await waitForWorkspaceReady(page);
      const afterReload = await count(sql);
      expect(afterReload, `${tc.id}: reload sonrası DB etkisi kalıcı olmalı`).toBeGreaterThanOrEqual(after);

      assertClean(session, tc.id);

      const proof: string[] = [
        `before DB: ${before}`,
        `click: gerçek '${tc.label}' düğmesi (${tc.route})`,
        `after DB: ${after} (artış doğrulandı)`,
        auditProof,
        `reload sonrası DB: ${afterReload} — kalıcı`,
      ];
      if (extraNote) proof.push(extraNote);

      evidence.push({
        route: tc.route,
        control: controlSignature,
        role: tc.role,
        verdict: "PASS",
        proof,
      });
    } finally {
      await session.context.close();
    }
  });
}

/* ── 2) `/scenarios/compare` -> `Karşılaştır` (GET formu + DB senaryo çifti + DOM/reload) ─ */

test("scenarios/compare: 'Matrisi Güncelle' (/scenarios/compare) iki DB senaryosunu karşılaştırır ve reload sonrası korur", async ({
  browser,
}) => {
  test.setTimeout(240_000);

  const { runAId, runBId, nameA, nameB } = await ensureComparableScenarioRuns("finance_operator");

  const dbPairBefore = await count(
    "select count(*)::int from public.scenario_runs where id in ($1::uuid, $2::uuid) and archived_at is null",
    [runAId, runBId],
  );
  expect(dbPairBefore, "Karşılaştırılacak iki senaryo çalışması DB'de hazır olmalı").toBe(2);

  const session = await openAndGotoReady(browser, "finance_operator", "/scenarios/compare");
  const { page } = session;

  try {
    const button = page.getByRole("button", { name: "Matrisi Güncelle", exact: true }).first();
    await expect(button, "/scenarios/compare üzerinde 'Matrisi Güncelle' düğmesi görünür olmalı").toBeVisible({
      timeout: 20_000,
    });

    const controlSignature = await buttonSignature(button, "/scenarios/compare", "Matrisi Güncelle");
    const form = button.locator("xpath=ancestor::form[1]");

    await form.locator('select[name="a"]').selectOption(runAId);
    await form.locator('select[name="b"]').selectOption(runBId);

    await Promise.all([
      page.waitForURL(
        (u) =>
          u.pathname === "/scenarios/compare" &&
          u.searchParams.get("a") === runAId &&
          u.searchParams.get("b") === runBId,
        { timeout: 30_000 },
      ),
      button.click(),
    ]);
    await waitForWorkspaceReady(page);

    const body = await page.locator("body").innerText();
    expect(
      /Application error|Internal Server Error/i.test(body),
      "scenarios/compare: uygulama hata ekranı üretti",
    ).toBe(false);

    await expect(page.getByText("Net Kasa Farkı (Δ)", { exact: false }).first()).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(`A: ${nameA}`, { exact: false }).first()).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(`B: ${nameB}`, { exact: false }).first()).toBeVisible({ timeout: 15_000 });

    const dbPairAfter = await count(
      "select count(*)::int from public.scenario_runs where id in ($1::uuid, $2::uuid) and archived_at is null",
      [runAId, runBId],
    );
    expect(dbPairAfter).toBe(2);

    await page.reload({ waitUntil: "domcontentloaded" });
    await waitForWorkspaceReady(page);

    const reloadedUrl = new URL(page.url());
    expect(reloadedUrl.searchParams.get("a")).toBe(runAId);
    expect(reloadedUrl.searchParams.get("b")).toBe(runBId);
    await expect(page.getByText(`A: ${nameA}`, { exact: false }).first()).toBeVisible({ timeout: 15_000 });

    assertClean(session, "scenarios/compare");

    evidence.push({
      route: "/scenarios/compare",
      control: controlSignature,
      role: "finance_operator",
      verdict: "PASS",
      proof: [
        `DB önkoşul: 2 aktif scenario_runs satırı doğrulandı (${runAId}, ${runBId})`,
        "click: gerçek 'Matrisi Güncelle' düğmesi (/scenarios/compare)",
        `URL durumu: ?a=${runAId}&b=${runBId}`,
        `DOM karşılaştırma matrisi: 'A: ${nameA}', 'B: ${nameB}' ve 'Net Kasa Farkı (Δ)' satırı render edildi`,
        "reload sonrası: URL ve karşılaştırma tablosu korundu",
      ],
    });
  } finally {
    await session.context.close();
  }
});
