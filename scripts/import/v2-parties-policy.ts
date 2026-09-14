// CI-3 (PRE-PHASE8 CI CLOSURE) — Standart Import V2 → `public.parties` YAZMA POLİTİKASI KANITI.
//
// Phase 19'un statik kuralı ("src/ içinde parties'e yalnız counterparties/engine.ts yazar") V2
// öncesi sözleşmeyi anlatıyordu. V2 mapper'ı (`resolveParty`) da parties'e yazar — ama YALNIZ
// kullanıcının ONAYLA eylemiyle açılan tek transaction içinde (`confirmImport` → `begin` →
// `mapWorkbook(dryRun:false)` → FAMILY_WRITERS → resolveParty → `commit`). Bir dosya yolunu
// allowlist'e eklemek bunu kanıtlamaz; bu dosya gerçek çağrı yolunu bir VERİTABANINA karşı kanıtlar:
//
//   1. parse           → DB'ye hiç gitmez (saf fonksiyon; burada sayılmaz, tip düzeyinde bellidir)
//   2. preview         → parties'e (ve hiçbir tabloya) yazma YOK
//   3. review          → preview raporunun ekranda okunmasıdır; sunucu adımı yoktur → yazma YOK
//   4. ONAYLA öncesi   → parties'e ulaşan tek yol FAMILY_WRITERS; dryRun dalı onlara girmeden döner
//   5. confirm         → yetkili katman için parties GERÇEKTEN yazılır (sayı fixture'dan bilinir)
//   6. yetkisiz confirm→ (a) katman matrisi: FORBIDDEN_SHEETS, DB'ye gitmeden; (b) DB rolü: RLS/grant
//                        reddi → WRITE_FAILED + ROLLBACK; (c) canPerform('viewer','import_workbook_v2')=false
//   7. başarısız tx    → bayat bağlama (STALE_BINDING) sonra gelen bir sayfada patlar; ÖNCE yaratılan
//                        banka/tedarikçi parties satırları ROLLBACK ile gider — yetim parti YOK
//   8. replay          → aynı dosya ikinci kez ONAYLA: parties sayısı değişmez (mükerrer yok)
//
// GÜVENLİK: yalnız harcanabilir hedef (requireDisposableOwnerDatabaseUrl). parties/categories ve
// import tabloları TRUNCATE edilir — bu yüzden gerçek DB'de asla koşmaz.

import { Pool, type PoolClient } from "pg";
import { buildFixtureWorkbook } from "../../src/lib/importers/v2/fixture";
import { confirmImport, previewImport } from "../../src/lib/importers/v2/service";
import { canPerform, DB_ROLE } from "../../src/lib/authz/matrix";
import { requireDisposableOwnerDatabaseUrl } from "../db/owner-url";

export interface PolicyCheck { name: string; pass: boolean; detail: string }

const RESET = [
  "import_external_keys", "mapping_reviews", "import_rows", "source_cells", "source_sheets",
  "payments", "checks", "loan_installments", "loans", "cashflow_lines", "cashflow_months",
  "bank_transactions", "bank_accounts", "cash_accounts", "invoices", "orders", "products", "projects",
  "budget_lines", "budgets", "fx_positions", "production_parts", "machine_assets", "source_workbooks",
];

/** Tüm public tabloların satır sayısı — "hiçbir tabloya yazılmadı" iddiası için. */
async function rowCounts(q: Pick<PoolClient, "query">): Promise<Record<string, number>> {
  const tabs = (await q.query<{ t: string }>(
    "select table_name t from information_schema.tables where table_schema='public' and table_type='BASE TABLE' order by 1",
  )).rows;
  const out: Record<string, number> = {};
  for (const { t } of tabs) out[t] = Number((await q.query<{ c: string }>(`select count(*) c from public."${t}"`)).rows[0].c);
  return out;
}
function diffCounts(a: Record<string, number>, b: Record<string, number>): string[] {
  return Object.keys(a).filter((k) => a[k] !== b[k]).map((k) => `${k}: ${a[k]}→${b[k]}`);
}

export async function runPartiesPolicyProof(ownerUrl: string): Promise<PolicyCheck[]> {
  const checks: PolicyCheck[] = [];
  const record = (name: string, pass: boolean, detail = ""): void => {
    checks.push({ name, pass, detail });
    console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  };
  const owner = new Pool({ connectionString: ownerUrl, max: 4 });
  const wipe = async (): Promise<void> => {
    await owner.query(`truncate ${RESET.map((t) => `public.${t}`).join(", ")} cascade`);
    await owner.query("truncate public.parties, public.categories cascade");
  };
  const partiesCount = async (): Promise<number> =>
    Number((await owner.query<{ c: string }>("select count(*) c from public.parties")).rows[0].c);
  const partiesInserted = async (): Promise<number> =>
    Number((await owner.query<{ n: string }>("select coalesce(n_tup_ins,0)::text n from pg_stat_user_tables where schemaname='public' and relname='parties'")).rows[0]?.n ?? "0");

  try {
    const actor = (await owner.query<{ id: string }>(
      `insert into public.users (username, password_hash, display_name, role)
       values ('v2-parties-policy', 'DISABLED-NOT-A-CREDENTIAL', 'V2 parties politikası', 'admin')
       on conflict (username) do update set display_name = excluded.display_name returning id`)).rows[0].id;
    const wb = await buildFixtureWorkbook();
    const buf = Buffer.from(await wb.xlsx.writeBuffer());
    const filename = "parties-policy-fixture.xlsx";

    /* ── 2/3/4: preview + review = hiçbir yazma ───────────────────────────────────────── */
    await wipe();
    const before = await rowCounts(owner);
    const insBefore = await partiesInserted();
    const client = await owner.connect();
    let preview: Awaited<ReturnType<typeof previewImport>>;
    try {
      preview = await previewImport(client, buf, filename, actor, { role: "finance_manager" });
    } finally {
      client.release();
    }
    const afterPreview = await rowCounts(owner);
    record("preview: rapor üretildi (ok)", preview.ok, preview.ok ? `sayfa=${preview.report.sheets.length}` : JSON.stringify(preview.rejection).slice(0, 120));
    record("preview: parties'e yazılmadı (satır 0 → 0, n_tup_ins değişmedi)", (await partiesCount()) === 0 && (await partiesInserted()) === insBefore, `n_tup_ins=${insBefore}`);
    record("preview: HİÇBİR public tabloya yazılmadı", diffCounts(before, afterPreview).length === 0, diffCounts(before, afterPreview).join(", ") || "tüm sayımlar aynı");
    // review: önizleme ile ONAYLA arasında sunucuya giden bir adım yok — aynı sayımlar korunur.
    const afterReview = await rowCounts(owner);
    record("review (önizleme→ONAYLA arası): yazma yok", diffCounts(afterPreview, afterReview).length === 0);

    /* ── 6c: katman yetkisi (UI kapısı) ───────────────────────────────────────────────── */
    record("yetki: canPerform('viewer','import_workbook_v2') = false", !canPerform("viewer", "import_workbook_v2"));
    record("yetki: canPerform('finance_approver','import_workbook_v2') = false", !canPerform("finance_approver", "import_workbook_v2"));
    record("yetki: canPerform('finance_operator','import_workbook_v2') = true (referans sayfaları ayrıca kısıtlı)", canPerform("finance_operator", "import_workbook_v2"));

    /* ── 6a: yetkisiz confirm — katman matrisi (referans sayfaları) → DB'ye gitmeden red ── */
    const sha = preview.ok ? preview.report.sha256 : "";
    const opBefore = await rowCounts(owner);
    const op = await confirmImport(owner, buf, filename, actor, sha, { role: "finance_operator" });
    const opAfter = await rowCounts(owner);
    record("yetkisiz confirm (operator, referans sayfalı dosya): FORBIDDEN_SHEETS ile reddedildi", !op.ok && op.rejection.code === "FORBIDDEN_SHEETS", op.ok ? "KABUL EDİLDİ!" : op.rejection.code);
    record("yetkisiz confirm (operator): parties dahil hiçbir tablo değişmedi", diffCounts(opBefore, opAfter).length === 0 && (await partiesCount()) === 0);

    /* ── 6b: yetkisiz confirm — DB rolü (viewer) → RLS/grant reddi + ROLLBACK ─────────── */
    const viewerPool = new Pool({ connectionString: ownerUrl, max: 2, options: `-c role=${DB_ROLE.viewer}` });
    try {
      const vBefore = await rowCounts(owner);
      const v = await confirmImport(viewerPool, buf, filename, actor, sha, { role: "finance_manager" });
      const vAfter = await rowCounts(owner);
      record("yetkisiz confirm (DB rolü viewer, katman matrisi atlatılsa bile): WRITE_FAILED — veritabanı reddetti", !v.ok && v.rejection.code === "WRITE_FAILED", v.ok ? "KABUL EDİLDİ!" : `${v.rejection.code}: ${v.rejection.detail?.slice(0, 80)}`);
      record("yetkisiz confirm (DB rolü viewer): ROLLBACK — parties dahil hiçbir tablo değişmedi", diffCounts(vBefore, vAfter).length === 0 && (await partiesCount()) === 0);
    } finally {
      await viewerPool.end();
    }

    /* ── 5: yetkili confirm → parties yazılır ─────────────────────────────────────────── */
    const ok1 = await confirmImport(owner, buf, filename, actor, sha, { role: "finance_manager" });
    const partiesAfter1 = await partiesCount();
    record("confirm (finance_manager, ONAYLA): kabul edildi ve tek transaction commit oldu", ok1.ok, ok1.ok ? `workbook=${ok1.outcome.workbookId.slice(0, 8)}…` : JSON.stringify(ok1.rejection).slice(0, 160));
    record("confirm: parties GERÇEKTEN yazıldı (banka/tedarikçi/müşteri tarafları)", partiesAfter1 > 0, `parties=${partiesAfter1}`);
    const distinctParties = (await owner.query<{ c: string }>("select count(*) c from (select distinct normalized_name, party_type from public.parties) x")).rows[0].c;
    record("confirm: parties (normalized_name, party_type) tekil — aynı ad iki kez yaratılmadı", Number(distinctParties) === partiesAfter1, `distinct=${distinctParties}`);

    /* ── 8: replay → mükerrer yok ─────────────────────────────────────────────────────── */
    const ok2 = await confirmImport(owner, buf, filename, actor, sha, { role: "finance_manager" });
    const partiesAfter2 = await partiesCount();
    record("replay: aynı dosya ikinci ONAYLA kabul edildi (güncelleme yolu)", ok2.ok);
    record("replay: parties sayısı DEĞİŞMEDİ (mükerrer taraf yok)", partiesAfter2 === partiesAfter1, `${partiesAfter1} → ${partiesAfter2}`);

    /* ── 7: başarısız transaction → yetim parti yok ───────────────────────────────────── */
    // Bayat bağlama: bir ödemenin defter kaydı kalsın, kaydın kendisi silinsin. 01_ODEMELER,
    // yazma sırasında 06_BANKA_HESAPLARI ve 03_KREDILER'den SONRA gelir; o sayfalar bu transaction
    // içinde banka partilerini yaratır, sonra 01_ODEMELER STALE_BINDING ile patlar → hepsi geri alınır.
    const bound = (await owner.query<{ entity_id: string }>(
      "select entity_id from public.import_external_keys where entity_table='payments' limit 1")).rows[0]?.entity_id;
    record("başarısız tx hazırlığı: bağlı bir ödeme kaydı bulundu", typeof bound === "string");
    if (bound) {
      await owner.query("delete from public.payments where id = $1", [bound]);
      await owner.query("truncate public.parties cascade"); // yetim kalırsa görünsün diye sıfırdan başla
      const fBefore = await rowCounts(owner);
      const failed = await confirmImport(owner, buf, filename, actor, sha, { role: "finance_manager" });
      const fAfter = await rowCounts(owner);
      record("başarısız tx: STALE_BINDING ile reddedildi (sessiz başarı yok)", !failed.ok && failed.rejection.code === "STALE_BINDING", failed.ok ? "KABUL EDİLDİ!" : failed.rejection.code);
      record("başarısız tx: önce yaratılan banka/tedarikçi partileri ROLLBACK ile gitti — yetim parti 0", (await partiesCount()) === 0 && diffCounts(fBefore, fAfter).length === 0, diffCounts(fBefore, fAfter).join(", ") || "tüm sayımlar aynı");
    }
  } finally {
    await wipe().catch(() => undefined);
    await owner.end();
  }
  return checks;
}

const isDirectRun = (() => {
  try { return process.argv[1] !== undefined && /v2-parties-policy\.ts$/.test(process.argv[1]); } catch { return false; }
})();

if (isDirectRun) {
  const url = requireDisposableOwnerDatabaseUrl("import:parties-policy:v2");
  runPartiesPolicyProof(url)
    .then((checks) => {
      const failed = checks.filter((c) => !c.pass);
      console.log(`\n${checks.length - failed.length}/${checks.length} kontrol geçti.`);
      console.log(failed.length === 0 ? "V2 PARTIES POLICY: ALL PASS" : "V2 PARTIES POLICY: FAIL");
      process.exit(failed.length === 0 ? 0 : 1);
    })
    .catch((e) => {
      console.error("v2-parties-policy beklenmedik hata:", e instanceof Error ? e.message : e);
      process.exit(1);
    });
}
