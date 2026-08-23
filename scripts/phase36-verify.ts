// Faz 36 verification — role-based navigation in the UI, global filters, saved views, table
// standard, and a SAMPLED cross-module consistency checklist.
//
// Usage:
//   env -u DATABASE_URL MIGRATION_DATABASE_URL=... pnpm phase36:verify
//
// The saved-views ownership test additionally needs a real low-privilege login, taken from
// MAS_RADAR_APP_DB_PASSWORD. When it is absent those checks FAIL LOUDLY rather than being
// skipped — the Faz 35 rule: a security check that quietly does not run is worse than none.
//
// ═══ THE CENTRAL DELIVERABLE: FAZ 24B'S UI HALF ═══
//
// Faz 24B shipped the backend answer and said in as many words that the UI half was Faz 36's.
// Measured before writing any of this: the SIDEBAR was already filtered by navigationFor(), so
// the gap was never there. It was one level down — `ModuleFrame` renders every module's TABS and
// had no role awareness at all, and all eight module layouts handed it a hard-coded list. A
// viewer could be offered a tab into a screen that refuses them.
//
// This gate proves the fix three ways: the layouts really call tabsFor(), the filtering really
// happens on the SERVER (so a hidden tab is never serialised), and — enumerated over the real tab
// lists parsed out of those eight files — no tier is offered a route it may not see, with a
// positive control proving the filter is not simply hiding everything.

import { readFileSync, readdirSync, existsSync } from "node:fs";
import path from "node:path";
import { Pool } from "pg";
import {
  APP_ROLES, CLASS_MATRIX, DB_ROLE, GATED_ROUTES, TABLE_CLASS, UI_CAPABILITIES,
  canPerform, canSeeModule, canSeeRoute, navigationFor, tabsFor, type AppRole,
} from "../src/lib/authz/matrix";
import {
  EMPTY_FILTERS, activeFilterCount, describeFilters, filtersToParams,
  globalFilterSchema, parseFilters, resolveDateRange,
} from "../src/lib/ui/filters";
import {
  DEFAULT_TABLE_STATE, MAX_ROWS_PER_REQUEST, buildPage, describeSelection,
  orderByClause, pageBounds, parseTableState, selectionSize,
} from "../src/lib/ui/table";
import { requireDisposableOwnerDatabaseUrl } from "./db/owner-url";

const ownerUrl = requireDisposableOwnerDatabaseUrl("phase36:verify");
const pool = new Pool({ connectionString: ownerUrl });

function appUrl(): string | null {
  const pw = process.env.MAS_RADAR_APP_DB_PASSWORD;
  if (!pw) return null;
  const u = new URL(ownerUrl);
  u.username = "mas_radar_app";
  u.password = pw;
  return u.toString();
}

interface Check { name: string; pass: boolean; detail: string }
const checks: Check[] = [];
function record(name: string, pass: boolean, detail: string): void {
  checks.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name} — ${detail}`);
}
const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e));
const ROOT = process.cwd();
const readSrc = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");
const codeOnly = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ").replace(/^\s*--.*$/gm, " ");

const MODULE_DIRS = ["cashflow", "data", "finance", "insights", "payments",
  "production", "scenarios", "system"] as const;
const layoutPath = (m: string) => `src/app/(dashboard)/${m}/layout.tsx`;

/** Pull the `href` values out of a module layout's hard-coded tab array. */
function tabHrefs(moduleDir: string): string[] {
  const src = readSrc(layoutPath(moduleDir));
  return [...src.matchAll(/href:\s*"([^"]+)"/g)].map((m) => m[1]);
}

const TAG = "P36-FIXTURE";
const purge = async () => {
  await pool.query(`delete from public.saved_views where name like $1`, [`${TAG}%`]).catch(() => undefined);
};

async function main(): Promise<void> {
  await purge();

  /* ── 1. THE UI HALF: layouts really filter, and on the server ───────────────────────── */
  const notFiltering = MODULE_DIRS.filter((m) => !codeOnly(readSrc(layoutPath(m))).includes("tabsFor("));
  record("sekiz modül layout'unun HEPSİ sekmeleri tabsFor() ile filtreliyor",
    notFiltering.length === 0,
    notFiltering.join(", ") || `${MODULE_DIRS.length}/${MODULE_DIRS.length} — boşluk sidebar'da değil, bir kat altındaydı`);

  const clientLayouts = MODULE_DIRS.filter((m) => /["']use client["']/.test(readSrc(layoutPath(m))));
  record("filtreleme SUNUCUDA yapılıyor (layout'lar client component değil)",
    clientLayouts.length === 0,
    clientLayouts.join(", ") || "gizlenen sekme tarayıcıya hiç gönderilmiyor — CSS ile saklamak erişim kontrolü değildir");

  const notAwaitingSession = MODULE_DIRS.filter((m) => !codeOnly(readSrc(layoutPath(m))).includes("requireSession()"));
  record("her layout oturumu SUNUCUDA çözüyor",
    notAwaitingSession.length === 0, notAwaitingSession.join(", ") || "requireSession() → session.role");

  /* ── 2. NO TIER IS OFFERED A ROUTE IT MAY NOT SEE (enumerated over the REAL tabs) ───── */
  const allTabs = MODULE_DIRS.flatMap((m) => tabHrefs(m).map((href) => ({ module: m, href })));
  record("gerçek sekme listeleri kaynaktan okundu (uydurma liste değil)",
    allTabs.length >= 40, `${allTabs.length} sekme, ${MODULE_DIRS.length} modül`);

  const leaks: string[] = [];
  for (const role of APP_ROLES) {
    for (const { href } of allTabs) {
      const shown = tabsFor(role, [{ href }]).length === 1;
      if (shown && !canSeeRoute(role, href)) leaks.push(`${role} → ${href}`);
    }
  }
  record("HİÇBİR katmana göremeyeceği bir sekme SUNULMUYOR",
    leaks.length === 0,
    leaks.join(", ") || `${APP_ROLES.length} katman × ${allTabs.length} sekme denendi`);

  // Positive control: the gated routes must actually disappear for the tiers that may not see
  // them, or "no leaks" would pass for a filter that hides nothing.
  const viewerHidden = allTabs.filter(({ href }) => tabsFor("viewer", [{ href }]).length === 0);
  const adminHidden = allTabs.filter(({ href }) => tabsFor("admin", [{ href }]).length === 0);
  record("POZİTİF KONTROL: izleyiciden GERÇEKTEN sekme gizleniyor",
    viewerHidden.length > 0,
    viewerHidden.map((t) => t.href).join(", ") || "hiçbir şey gizlenmedi — filtre bir şey yapmıyor olabilir");
  record("POZİTİF KONTROL: yöneticiden hiçbir sekme gizlenmiyor (filtre her şeyi saklamıyor)",
    adminHidden.length === 0, adminHidden.map((t) => t.href).join(", ") || "admin tüm sekmeleri görüyor");

  // The specific promises ROUTE_MIN_TIER makes.
  record("/system/backup ve /system/security yalnız admin'e görünüyor",
    !canSeeRoute("finance_manager", "/system/backup")
      && !canSeeRoute("finance_manager", "/system/security")
      && canSeeRoute("admin", "/system/backup"),
    "yedekleme ve erişim kontrolü finans işi değil, yönetim işi");
  record("/data/approvals izleyici ve operatöre görünmüyor, onaylayıcıya görünüyor",
    !canSeeRoute("viewer", "/data/approvals") && !canSeeRoute("finance_operator", "/data/approvals")
      && canSeeRoute("finance_approver", "/data/approvals"),
    "operatör talep AÇAR ama karar VERMEZ (Faz 24A maker-checker)");
  record("alt rota, kendi girdisi yoksa MODÜLÜNÜN kapısını devralıyor",
    !canSeeRoute("viewer", "/system/jobs") && canSeeRoute("admin", "/system/jobs"),
    "devralma olmasaydı listelenmeyen bir sekme, kimse eklemeyi unuttuğu için görünür kalırdı");

  // Sidebar (Faz 24B's half) must still work — this phase must not have broken it.
  const NAV = [{ href: "/overview" }, { href: "/payments" }, { href: "/system" }];
  record("sidebar filtresi (Faz 24B) hâlâ çalışıyor",
    navigationFor("viewer", NAV).length === 2 && navigationFor("admin", NAV).length === 3
      && !canSeeModule("viewer", "/system"),
    "izleyici /system görmüyor, admin görüyor");

  /* ── 3. in-page capability gates ────────────────────────────────────────────────────── */
  const capNames = Object.keys(UI_CAPABILITIES) as (keyof typeof UI_CAPABILITIES)[];
  const unclassified = capNames.filter((c) => TABLE_CLASS[UI_CAPABILITIES[c].table] == null);
  record("her UI yeteneği SINIFLANDIRILMIŞ bir tabloya bağlı",
    unclassified.length === 0, unclassified.join(", ") || `${capNames.length} yetenek`);
  record("izleyici hiçbir yazma yeteneğine sahip değil",
    capNames.every((c) => !canPerform("viewer", c)),
    "salt-okunur katman gerçekten salt-okunur — bu invariant bir kolaylık için bozulmadı");
  record("POZİTİF KONTROL: yönetici yazma yeteneklerine sahip",
    capNames.every((c) => canPerform("admin", c)), `${capNames.length}/${capNames.length}`);
  record("onaylayıcı onay verebiliyor ama ödeme düzenleyemiyor",
    canPerform("finance_approver", "decide_approval") && !canPerform("finance_approver", "edit_payment"),
    "maker-checker UI tarafında da duruyor");

  /* ── 4. saved_views: personal class, ownership, and the viewer invariant ────────────── */
  record("saved_views 'personal' sınıfında",
    TABLE_CLASS.saved_views === "personal",
    "kişisel tercih, şirket verisi değil — operational finansal kayıtlar için yazılmıştı");
  record("personal sınıfı izleyiciye YAZMA vermiyor",
    CLASS_MATRIX.personal.viewer.length === 1 && CLASS_MATRIX.personal.viewer[0] === "select",
    "ilk sürüm ALL veriyordu; Faz 24B'nin 'izleyici hiçbir tabloya yazamaz' invariant'ı düştü ve geri alındı");

  const lifecycleCols = await pool.query(`
    select column_name from information_schema.columns
    where table_schema='public' and table_name='saved_views'
      and column_name in ('status','state','lifecycle')`);
  record("saved_views'ta yaşam-döngüsü kolonu YOK (CHECK+guard yapısal olarak N/A)",
    lifecycleCols.rowCount === 0,
    "kayıtlı görünüm oluşur, düzenlenir, silinir — arada durumu yoktur");

  const policies = await pool.query(`
    select cmd, coalesce(qual,'') q, coalesce(with_check,'') w from pg_policies
    where schemaname='public' and tablename='saved_views'`);
  const ownerScoped = policies.rows.filter((r) =>
    ["SELECT", "UPDATE", "DELETE"].includes(String(r.cmd))
    && (String(r.q).includes("current_app_user") || String(r.w).includes("current_app_user")));
  record("okuma/güncelleme/silme SAHİPLİK kapsamlı (0058 deseni)",
    ownerScoped.length >= 3, `${ownerScoped.length} sahiplik politikası`);

  /* ── 4b. ownership FKs must point at the table the app actually writes ──────────────── */
  //
  // A real, shipped bug this gate found: four tables (Faz 33 and Faz 35) declared
  // `references auth.users(id)` while auth.users is EMPTY and every session id comes from
  // public.users — making createDocument() and enqueueJob() fail for any real actor. Migration
  // 0085 repoints them.
  //
  // Checked structurally and repo-wide so the NEXT table to make this mistake fails immediately.
  const authUserCount = await pool.query(`select count(*)::int n from auth.users`);
  const authFks = await pool.query(`
    select conrelid::regclass::text as tbl, conname
    from pg_constraint
    where contype = 'f' and confrelid = 'auth.users'::regclass
    order by 1`);
  record("hiçbir sahiplik FK'si BOŞ auth.users'ı göstermiyor",
    Number(authUserCount.rows[0].n) > 0 || authFks.rowCount === 0,
    authFks.rowCount === 0
      ? `auth.users ${authUserCount.rows[0].n} satır, ona bağlı FK yok`
      : `hâlâ bağlı: ${authFks.rows.map((r) => `${r.tbl}.${r.conname}`).join(", ")}`);

  const ownerFks = await pool.query(`
    select conrelid::regclass::text as tbl, confrelid::regclass::text as ref
    from pg_constraint c
    join pg_attribute a on a.attrelid = c.conrelid and a.attnum = any(c.conkey)
    where c.contype = 'f' and a.attname in ('created_by','uploaded_by','requested_by','decided_by')
    order by 1`);
  const wrongTarget = ownerFks.rows.filter((r) => String(r.ref).includes("auth.users"));
  record("created_by/uploaded_by FK'leri public.users'ı gösteriyor",
    wrongTarget.length === 0,
    wrongTarget.map((r) => r.tbl).join(", ")
      || `${ownerFks.rowCount} sahiplik FK'si doğru tabloyu gösteriyor`);

  // Behavioural: the path both earlier gates avoided by passing NULL.
  const probeUser = (await pool.query(`select id from public.users limit 1`)).rows[0]?.id as string | undefined;
  if (probeUser) {
    let docInsertOk = false;
    try {
      await pool.query(
        `insert into public.documents (title, doc_type, created_by) values ($1,'other',$2)`,
        [`${TAG} fk`, probeUser]);
      docInsertOk = true;
      await pool.query(`delete from public.documents where title = $1`, [`${TAG} fk`]);
    } catch { docInsertOk = false; }
    record("GERÇEK bir oturum kullanıcısıyla doküman oluşturulabiliyor",
      docInsertOk,
      "phase33/35 bu yolu actorId=null ile geçmişti — kırık bir FK'yi sağlayan TEK değerle");
  }

  /* ── 5. saved_views behaviour, with a REAL SET ROLE ─────────────────────────────────── */
  const users = await pool.query(`select id from public.users order by created_at limit 2`);
  const userA = users.rows[0]?.id as string | undefined;
  if (!userA) {
    record("saved_views davranış testi için kullanıcı fixture'ı bulundu", false, "users tablosu boş");
  } else {
    await pool.query(
      `insert into public.saved_views (name, module_key, filters, created_by, is_shared)
       values ($1,'payments','{"datePreset":"last_30"}'::jsonb,$2,false) returning id`,
      [`${TAG} özel`, userA]);
    await pool.query(
      `insert into public.saved_views (name, module_key, filters, created_by, is_shared)
       values ($1,'payments','{}'::jsonb,$2,true)`, [`${TAG} paylaşılan`, userA]);
    record("sahip bağlantısı iki fixture görüyor (boş kümede test yok)",
      Number((await pool.query(
        `select count(*)::int n from public.saved_views where name like $1`, [`${TAG}%`])).rows[0].n) === 2,
      "biri özel, biri paylaşılan");

    const url = appUrl();
    if (!url) {
      record("RLS davranış testi çalıştırılabildi (MAS_RADAR_APP_DB_PASSWORD gerekli)",
        false, "parola verilmedi — güvenlik kontrolü SESSİZCE ATLANAMAZ");
    } else {
      const appPool = new Pool({ connectionString: url });
      try {
        const asRole = async <T>(role: AppRole, fn: (c: import("pg").PoolClient) => Promise<T>): Promise<T> => {
          const c = await appPool.connect();
          try { await c.query(`set role ${DB_ROLE[role]}`); return await fn(c); }
          finally { await c.query("reset role").catch(() => undefined); c.release(); }
        };

        // A tier with no app identity set sees only SHARED views — never somebody else's private
        // one. This is the property the whole ownership design exists for.
        const seen = await asRole("finance_operator", async (c) =>
          (await c.query(`select name from public.saved_views where name like $1`, [`${TAG}%`])).rows
            .map((r) => String(r.name)));
        record("BAŞKASININ ÖZEL kayıtlı görünümü diğer katmana görünmüyor",
          seen.length === 1 && seen[0].includes("paylaşılan"),
          `görülen: ${seen.join(", ") || "yok"} — özel olan gizli, paylaşılan görünür`);

        const viewerWrote = await asRole("viewer", async (c) => {
          try {
            await c.query(
              `insert into public.saved_views (name, module_key, filters, created_by)
               values ($1,'payments','{}'::jsonb,$2)`, [`${TAG} izleyici`, userA]);
            return true;
          } catch { return false; }
        });
        record("İZLEYİCİ kayıtlı görünüm YAZAMIYOR (Faz 24B invariant'ı korunuyor)",
          !viewerWrote, "bir kolaylık için güvenlik invariant'ı bozulmadı");

        const operatorWrote = await asRole("finance_operator", async (c) => {
          try {
            await c.query(
              `insert into public.saved_views (name, module_key, filters, created_by)
               values ($1,'payments','{}'::jsonb,$2)`, [`${TAG} operatör`, userA]);
            return true;
          } catch { return false; }
        });
        record("POZİTİF KONTROL: operatör kayıtlı görünüm YAZABİLİYOR",
          operatorWrote, "reddedilen izleyici, 'kimse yazamıyor' yüzünden değil");
      } finally {
        await appPool.end();
      }
    }
  }

  /* ── 6. SAMPLED cross-module UI consistency checklist ───────────────────────────────── */
  //
  // The plan asks for a SAMPLE, not every page, and the sample is chosen rather than convenient:
  // one page per module, and in each module the most DATA-DENSE page — the screen most likely to
  // have a table, an empty state and a loading path, i.e. the one where an inconsistency is worth
  // finding. Checking all ~60 pages would mostly re-verify trivial summary screens and would make
  // the gate slow enough that people stop running it.
  const SAMPLE: Array<{ module: string; page: string; why: string }> = [
    { module: "payments", page: "src/app/(dashboard)/payments/items/page.tsx", why: "en yoğun ödeme tablosu" },
    { module: "finance", page: "src/app/(dashboard)/finance/facilities/page.tsx", why: "çok tablolu finansman ekranı" },
    { module: "cashflow", page: "src/app/(dashboard)/cashflow/budget/page.tsx", why: "bütçe/varyans tablosu" },
    { module: "insights", page: "src/app/(dashboard)/insights/analysis/page.tsx", why: "Faz 34 grafik + tablo karışımı" },
    { module: "data", page: "src/app/(dashboard)/data/documents/page.tsx", why: "Faz 35 doküman tablosu" },
    { module: "system", page: "src/app/(dashboard)/system/jobs/page.tsx", why: "Faz 33 kuyruk tablosu" },
  ];
  const missingSample = SAMPLE.filter((s) => !existsSync(path.join(ROOT, s.page)));
  record("örneklem sayfalarının hepsi var",
    missingSample.length === 0, missingSample.map((s) => s.page).join(", ")
      || `${SAMPLE.length} sayfa — modül başına bir, en veri-yoğun olan`);

  const noHeader = SAMPLE.filter((s) => existsSync(path.join(ROOT, s.page))
    && !readSrc(s.page).includes("PageHeader"));
  record("örneklem: her sayfa ortak PageHeader kullanıyor",
    noHeader.length === 0, noHeader.map((s) => s.module).join(", ") || `${SAMPLE.length}/${SAMPLE.length}`);

  const tableNoShell = SAMPLE.filter((s) => {
    if (!existsSync(path.join(ROOT, s.page))) return false;
    const src = readSrc(s.page);
    return src.includes("<table") && !src.includes("TableShell");
  });
  record("örneklem: her tablo TableShell içinde (yatay kaydırma standardı)",
    tableNoShell.length === 0, tableNoShell.map((s) => s.module).join(", ")
      || "geniş tablo sayfayı yatay kaydırmıyor");

  const tableNoEmpty = SAMPLE.filter((s) => {
    if (!existsSync(path.join(ROOT, s.page))) return false;
    const src = readSrc(s.page);
    return src.includes("<table") && !/EmptyState|ModuleEmptyState/.test(src);
  });
  record("örneklem: tablosu olan her sayfada boş-durum var",
    tableNoEmpty.length === 0, tableNoEmpty.map((s) => s.module).join(", ")
      || "boş tablo, sessiz bir sayfa değil açık bir cümle");

  const modulesWithoutLoading = MODULE_DIRS.filter(
    (m) => !existsSync(path.join(ROOT, `src/app/(dashboard)/${m}/loading.tsx`)));
  record("her modülün bir loading.tsx'i var",
    modulesWithoutLoading.length === 0, modulesWithoutLoading.join(", ") || `${MODULE_DIRS.length} modül`);

  // Accessibility: the sample must not ship a table without a caption/label route, and the
  // palette must be reachable. Checked structurally rather than claimed.
  const shellSrc = readSrc("src/components/ui/shell.tsx");
  record("TableShell erişilebilir bir bölge olarak işaretli",
    /role="region"/.test(shellSrc) && /aria-label/.test(shellSrc) && /tabIndex/.test(shellSrc),
    "klavyeyle kaydırılabilir, ekran okuyucuya adı var");
  const paletteSrc = readSrc("src/components/search/command-palette.tsx");
  record("komut paleti klavyeyle açılıyor ve dialog olarak işaretli",
    /metaKey|ctrlKey/.test(paletteSrc) && /role="dialog"/.test(paletteSrc)
      && /aria-modal/.test(paletteSrc) && /Escape/.test(paletteSrc),
    "⌘K açar, Esc kapatır");
  const moduleTabsSrc = readSrc("src/components/ui/module-tabs.tsx");
  record("modül sekmeleri aria-current ile aktif sekmeyi bildiriyor",
    /aria-current/.test(moduleTabsSrc) && /aria-label/.test(moduleTabsSrc), "");

  /* ── 7. filters and table standard ──────────────────────────────────────────────────── */
  record("filtreler URL'e yazılıp geri okunuyor (paylaşılabilir görünüm)",
    JSON.stringify(parseFilters(filtersToParams(
      globalFilterSchema.parse({ datePreset: "last_30", currency: "USD", q: "akon" }))))
      === JSON.stringify(globalFilterSchema.parse({ datePreset: "last_30", currency: "USD", q: "akon" })),
    "bellekte tutulan bir filtre adlandırılamaz, paylaşılamaz, bağlantılanamaz");
  record("'tümü' için tarih sınırı NULL, sahte bir tarih değil",
    resolveDateRange(EMPTY_FILTERS, "2026-03-15").from === null,
    "'1970'ten beri' ile 'alt sınır yok' aynı şey değildir");
  record("bozuk tek parametre diğer filtreleri SİLMİYOR",
    parseFilters({ dp: "last_30", cur: "bozuk" }).datePreset === "last_30",
    "paylaşılan bir bağlantıdaki tek hata, gönderenin diğer seçimlerini yok etmemeli");
  record("geçersiz entity id sorguya GEÇMİYOR",
    parseFilters({ cp: "1; drop table invoices" }).counterpartyId === null, "uuid değilse null");
  record("export/başlık için filtre CÜMLESİ üretiliyor",
    describeFilters(globalFilterSchema.parse({ datePreset: "last_7" }), "2026-03-15").includes("Son 7 gün")
      && activeFilterCount(EMPTY_FILTERS) === 0,
    "filtrelendiğini söylemeyen bir export, yanlış toplamı dolaştırmanın en kolay yolu");

  record("sıralama anahtarı BEYAZ LİSTEDEN geçiyor",
    orderByClause({ ...DEFAULT_TABLE_STATE, sortKey: "x; drop table t" }, { due: "due_date" })
      === "order by id desc",
    "sıralama anahtarı query string'den gelir — tanınmayan reddedilir, kaçırılmaz");
  record("sıralamaya her zaman eşitlik bozucu ekleniyor",
    orderByClause({ ...DEFAULT_TABLE_STATE, sortKey: "due" }, { due: "due_date" }).includes(", id desc"),
    "yoksa sayfa 2, sayfa 1'in gösterdiği satırı tekrar edebilir");
  record("null değerler her iki yönde de SONA",
    ["asc", "desc"].every((d) => orderByClause(
      { ...DEFAULT_TABLE_STATE, sortKey: "a", sortDir: d as "asc" | "desc" }, { a: "amount" })
      .includes("nulls last")),
    "bilinmeyen tutar, en küçük tutar değildir");
  record("sayfa boyutu üst sınırı var",
    pageBounds({ ...DEFAULT_TABLE_STATE, pageSize: 250 }).limit <= MAX_ROWS_PER_REQUEST
      && parseTableState({ ps: "99999" }).pageSize === DEFAULT_TABLE_STATE.pageSize,
    `${MAX_ROWS_PER_REQUEST} satır — sınırsız tablo, zaman aşımına uğrayan bir ekrandır`);
  record("BİLİNMEYEN toplam null kalıyor, 0 sayılmıyor",
    buildPage([1], DEFAULT_TABLE_STATE, null).totalPages === null
      && selectionSize({ ids: [], allMatching: true }, null) === null,
    "sayılmamış bir toplam, sıfır değildir");
  record("toplu işlem onayı KAPSAMI açıkça söylüyor",
    describeSelection({ ids: [], allMatching: true }, 40000).includes("40000")
      && describeSelection({ ids: [], allMatching: true }, null).includes("bilinmiyor"),
    "12 görünen satır ile 40.000 görülmemiş satır farklı kararlardır");

  /* ── 8. export standard reuses Faz 34, no second mechanism ──────────────────────────── */
  const exportRoutes = readdirSync(path.join(ROOT, "src/app/api"), { withFileTypes: true })
    .filter((d) => d.isDirectory()).map((d) => d.name);
  record("ikinci bir export mekanizması icat edilmedi",
    existsSync(path.join(ROOT, "src/app/api/analytics/export/route.ts"))
      && !exportRoutes.includes("export"),
    "Faz 34'ün analytics/export rotası tek export yolu");
  record("Faz 34'ün export modülü hâlâ tek kaynak",
    /export function toXlsxBuffer/.test(readSrc("src/lib/analytics/export.ts")),
    "XLSX/CSV/SVG üretimi tek yerde");

  /* ── 9. house rules ─────────────────────────────────────────────────────────────────── */
  const pureModules = ["src/lib/ui/filters.ts", "src/lib/ui/table.ts"];
  const impure = pureModules.filter((f) => /from\s+["']pg["']|@\/lib\/db|@\/lib\/ai/.test(codeOnly(readSrc(f))));
  record("filtre/tablo standardı SAF (veritabanı yok, LLM yok)",
    impure.length === 0, impure.join(", ") || `${pureModules.length} modül`);
  const FLOAT_CAST = new RegExp("::" + "float8");
  const newSources = [...pureModules, "src/lib/ui/saved-views.ts",
    "supabase/migrations/0084_saved_views.sql"];
  record("yeni kaynakların hiçbirinde float8 cast'i yok",
    newSources.filter((f) => FLOAT_CAST.test(codeOnly(readSrc(f)))).length === 0,
    `${newSources.length} dosya temiz`);
  record("saved-views motoru audit() ve Zod sınırı taşıyor",
    /audit\(/.test(codeOnly(readSrc("src/lib/ui/saved-views.ts")))
      && /saveViewSchema\s*=\s*z\.object/.test(readSrc("src/lib/ui/saved-views.ts")), "");
  record("saved-views motoru KENDİ bağlantısını almıyor",
    !/new\s+Pool\s*\(|getPool\s*\(|getRawPool\s*\(|runAsSystem\s*\(/.test(
      codeOnly(readSrc("src/lib/ui/saved-views.ts"))),
    "görünürlük kararı RLS'te, uygulama katmanında ikinci bir WHERE'de değil");
  const migrateSrc = readSrc("scripts/db/migrate.ts");
  record("ANCHORS'a dokunulmadı",
    !migrateSrc.slice(migrateSrc.indexOf("const ANCHORS")).slice(0, 4000).includes("0084"),
    "yalnız 0001-0019 legacy tespiti için");
  record("GATED_ROUTES kaydı gerçekten dolu",
    GATED_ROUTES.length >= 9, `${GATED_ROUTES.length} kapılı rota`);

  await purge();

  const failed = checks.filter((c) => !c.pass);
  console.log(`\n${checks.length - failed.length}/${checks.length} kontrol geçti.`);
  if (failed.length) {
    console.log(`PHASE36 VERIFY FAIL — ${failed.length} kontrol başarısız:`);
    for (const f of failed) console.log(`  - ${f.name}: ${f.detail}`);
    await pool.end();
    process.exit(1);
  }
  console.log("PHASE36 VERIFY: ALL PASS");
  await pool.end();
}

main().catch(async (e) => {
  console.error(messageOf(e));
  await purge();
  await pool.end().catch(() => undefined);
  process.exit(1);
});
