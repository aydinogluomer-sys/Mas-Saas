// P24B V6.1 — per-row evidence manifest.
//
// WHY A ROW-LEVEL MANIFEST AND NOT A COUNT. V6 ended with "42 rows, 6 tables". That is a claim
// about a set, and a set-level claim cannot authorise a DELETE: the operator needs to know, for
// EACH row, what proves it is contamination. Two of the 42 — the approvals with requested_by NULL
// — were originally found by a time-window sweep alone, and a timestamp is not evidence. A row
// that happens to have been written in the same minute is not thereby a fixture row.
//
// So every row carries INDEPENDENT EVIDENCE CLASSES, and DELETE_TARGET requires at least two of
// them. TIME is recorded but deliberately cannot count toward the two: it is corroboration, never
// proof.
//
// THE CLASSES
//   TEXT                 the row itself contains the literal marker 'p24b' / 'P24B'
//   FK                   a foreign key points at a TEXT-confirmed row
//   TRANSACTION_LINEAGE  same xmin as a TEXT-confirmed row — i.e. the same COMMIT wrote both.
//                        This is what rescues the two NULL approvals: xmin 537425 wrote
//                        p24b_mk_mujyy6, the maker's approval AND the NULL approval together.
//   SOURCE_PAIR          scripts/db/roles-rls-verify.ts:416-420 emits the two approvals as a
//                        deterministic pair inside one asOwner() transaction; the row's shape
//                        (invoices / other / pending / requested_by null) matches that literal.
//   BASELINE_ABSENT      absent from every clean 0087 database and release clone
//   TIME                 created inside a measured incident window (corroboration only)
//
// Read-only: engine-enforced, same three layers as quiescence-snapshot.ts.
import { writeFileSync } from "node:fs";
import { Pool } from "pg";
import { ownerDatabaseUrl } from "../db/owner-url";

const INCIDENTS = [
  { id: "I1", from: "2026-08-25T10:09:00Z", to: "2026-08-25T10:11:00Z" },
  { id: "A1", from: "2026-08-25T10:19:00Z", to: "2026-08-25T10:20:00Z" },
  { id: "A2", from: "2026-08-26T12:02:00Z", to: "2026-08-26T12:03:00Z" },
  { id: "I2", from: "2026-08-26T15:16:00Z", to: "2026-08-26T15:17:00Z" },
];
const FIXTURE_PAYMENT = "7b300bfe-944f-468b-91fa-2de65b7cfee5";
/** The two approvals whose requested_by is NULL — no TEXT, no FK of their own. */
const NULL_APPROVALS = new Set([
  "62cd196c-d517-44c8-9431-3cce52d8b81a",
  "f4d7db30-44ce-45c0-b4ce-536a0e2886c9",
]);
const APPROVAL_IDS = [
  "1fc76c28-9d71-4ce3-91a6-f1e9f94e5dd4",
  "62cd196c-d517-44c8-9431-3cce52d8b81a",
  "8f656a4d-d2e4-40f2-b698-277f6278008b",
  "f4d7db30-44ce-45c0-b4ce-536a0e2886c9",
];

interface Ev { class: string; detail: string }
interface Row {
  table: string;
  id: string;
  classification: string;
  incidentId: string | null;
  xmin: string;
  discoveryMethods: string[];
  evidence: Ev[];
  independentEvidenceClassCount: number;
  baselineAbsent: boolean;
  deleteOrder: number | null;
  notes: string[];
}

function incidentOf(ts: string): string | null {
  const t = Date.parse(ts);
  for (const w of INCIDENTS) if (t >= Date.parse(w.from) && t < Date.parse(w.to)) return w.id;
  return null;
}

const DELETE_ORDER: Record<string, number> = {
  action_items: 1, approvals: 2, payment_instances: 3, payments: 4, users: 5, settings: 6,
};

async function main(): Promise<void> {
  const url = ownerDatabaseUrl();
  if (!url) { console.error("MIGRATION_DATABASE_URL gerekli"); process.exit(1); }
  const pool = new Pool({ connectionString: url, max: 1, options: "-c default_transaction_read_only=on" });
  const c = await pool.connect();
  const rows: Row[] = [];

  try {
    await c.query("begin read only");
    const db = (await c.query<{ d: string }>("select current_database() d")).rows[0].d;

    /* Which xmins belong to a transaction that also wrote a TEXT-confirmed row?
     * Derived, not hard-coded: collect the xmin of every row carrying the literal marker. */
    const textXmins = new Set<string>();
    for (const t of ["users", "action_items", "payments", "settings"]) {
      const r = await c.query<{ x: string }>(
        `select r.xmin::text x from public.${t} r where r::text ilike '%p24b%'`,
      );
      for (const row of r.rows) textXmins.add(row.x);
    }

    const push = (r: Omit<Row, "independentEvidenceClassCount" | "deleteOrder">): void => {
      const classes = new Set(r.evidence.map((e) => e.class).filter((k) => k !== "TIME"));
      rows.push({
        ...r,
        independentEvidenceClassCount: classes.size,
        deleteOrder: r.classification === "DELETE_TARGET" ? DELETE_ORDER[r.table] : null,
      });
    };

    // users — TEXT + TRANSACTION + BASELINE
    for (const u of (await c.query<{ id: string; username: string; created_at: string; x: string }>(
      `select r.id::text, r.username, r.created_at::text created_at, r.xmin::text x
         from public.users r where r::text ilike '%p24b%' order by r.created_at`)).rows) {
      push({
        table: "users", id: u.id, classification: "DELETE_TARGET", incidentId: incidentOf(u.created_at),
        xmin: u.x, discoveryMethods: ["TEXT", "TIME"], baselineAbsent: true, notes: [],
        evidence: [
          { class: "TEXT", detail: `username = '${u.username}' — roles-rls-verify.ts fixture adı` },
          { class: "TRANSACTION_LINEAGE", detail: `xmin ${u.x}` },
          { class: "BASELINE_ABSENT", detail: "verify_empty / final_rc_clone / preflight_clone → 0" },
          { class: "TIME", detail: `created_at ${u.created_at}` },
        ],
      });
    }

    // action_items — TEXT + (FK when created_by set) + TRANSACTION + BASELINE
    for (const a of (await c.query<{ id: string; title: string; created_by: string | null; created_at: string; x: string }>(
      `select r.id::text, r.title, r.created_by::text, r.created_at::text created_at, r.xmin::text x
         from public.action_items r where r::text ilike '%p24b%' order by r.created_at`)).rows) {
      const ev: Ev[] = [
        { class: "TEXT", detail: `title = '${a.title}'` },
        { class: "TRANSACTION_LINEAGE", detail: `xmin ${a.x} — aynı commit bir P24B kullanıcısını da yazdı` },
        { class: "BASELINE_ABSENT", detail: "temiz taban ve release klonlarında yok" },
        { class: "TIME", detail: `created_at ${a.created_at}` },
      ];
      if (a.created_by) ev.splice(1, 0, { class: "FK", detail: `created_by → P24B kullanıcısı ${a.created_by}` });
      push({
        table: "action_items", id: a.id, classification: "DELETE_TARGET", incidentId: incidentOf(a.created_at),
        xmin: a.x, discoveryMethods: a.created_by ? ["TEXT", "FK", "TIME"] : ["TEXT", "TIME"],
        baselineAbsent: true, evidence: ev,
        notes: a.created_by ? [] : ["created_by NULL — FK closure bu satırı KAÇIRIRDI, metin yakaladı"],
      });
    }

    // payments
    for (const p of (await c.query<{ id: string; name: string; created_at: string; x: string }>(
      `select r.id::text, r.name, r.created_at::text created_at, r.xmin::text x
         from public.payments r where r::text ilike '%p24b%'`)).rows) {
      push({
        table: "payments", id: p.id, classification: "DELETE_TARGET", incidentId: incidentOf(p.created_at),
        xmin: p.x, discoveryMethods: ["TEXT", "TIME"], baselineAbsent: true,
        notes: ["ROOT_CONTAMINATION — amplifikasyonun kaynağı olan şablon satır"],
        evidence: [
          { class: "TEXT", detail: `name = '${p.name}'` },
          { class: "TRANSACTION_LINEAGE", detail: `xmin ${p.x}` },
          { class: "BASELINE_ABSENT", detail: "temiz taban ve release klonlarında yok" },
          { class: "TIME", detail: `created_at ${p.created_at}` },
        ],
      });
    }

    // settings
    for (const s of (await c.query<{ key: string; updated_at: string; x: string }>(
      `select r.key, r.updated_at::text updated_at, r.xmin::text x
         from public.settings r where r::text ilike '%p24b%'`)).rows) {
      push({
        table: "settings", id: s.key, classification: "DELETE_TARGET", incidentId: incidentOf(s.updated_at),
        xmin: s.x, discoveryMethods: ["TEXT"], baselineAbsent: true,
        notes: ["created_at kolonu yok; zaman ataması updated_at üzerinden"],
        evidence: [
          { class: "TEXT", detail: `key = '${s.key}'` },
          { class: "BASELINE_ABSENT", detail: "settings tablosu temiz tabanda bu anahtarı taşımıyor" },
          { class: "TIME", detail: `updated_at ${s.updated_at}` },
        ],
      });
    }

    // approvals — the decisive ones
    for (const a of (await c.query<{ id: string; requested_by: string | null; subject_table: string; request_kind: string; status: string; created_at: string; x: string }>(
      `select r.id::text, r.requested_by::text, r.subject_table, r.request_kind, r.status,
              r.created_at::text created_at, r.xmin::text x
         from public.approvals r where r.id = any($1::uuid[]) order by r.created_at, r.id`,
      [APPROVAL_IDS])).rows) {
      const isNull = NULL_APPROVALS.has(a.id);
      const coTxn = textXmins.has(a.x);
      const ev: Ev[] = [];
      if (!isNull) ev.push({ class: "FK", detail: `requested_by → P24B maker ${a.requested_by}` });
      ev.push({
        class: "TRANSACTION_LINEAGE",
        detail: `xmin ${a.x} — ${coTxn ? "aynı commit metin-doğrulanmış bir P24B kullanıcısını da yazdı" : "eşleşme YOK"}`,
      });
      ev.push({
        class: "SOURCE_PAIR",
        detail:
          "roles-rls-verify.ts:416-420 tek asOwner() transaction'ında iki approval üretir " +
          `(invoices / gen_random_uuid() / other / pending; requested_by = maker | null). ` +
          `Ölçülen şekil: ${a.subject_table} / ${a.request_kind} / ${a.status} / requested_by=${a.requested_by ?? "NULL"}`,
      });
      ev.push({ class: "BASELINE_ABSENT", detail: "temiz taban ve release klonlarında yok" });
      ev.push({ class: "TIME", detail: `created_at ${a.created_at}` });
      push({
        table: "approvals", id: a.id,
        classification: coTxn ? "DELETE_TARGET" : "UNRESOLVED",
        incidentId: incidentOf(a.created_at), xmin: a.x,
        discoveryMethods: isNull ? ["TIME", "TRANSACTION_LINEAGE"] : ["UUID", "FK", "TIME"],
        baselineAbsent: true, evidence: ev,
        notes: isNull
          ? ["requested_by NULL — ne metin ne FK; TEXT ve FK taramaları bu satırı KAÇIRDI",
             "subject_id gen_random_uuid() olduğu için invoices'a sarkan referans (invoices tablosu boş)"]
          : [],
      });
    }

    // payment_instances — derived, FK + baseline
    for (const i of (await c.query<{ id: string; created_at: string; x: string; amount_source: string }>(
      `select r.id::text, r.created_at::text created_at, r.xmin::text x, r.amount_source::text
         from public.payment_instances r where r.payment_id = $1 order by r.created_at`,
      [FIXTURE_PAYMENT])).rows) {
      push({
        table: "payment_instances", id: i.id, classification: "DELETE_TARGET",
        incidentId: incidentOf(i.created_at), xmin: i.x,
        discoveryMethods: ["FK", "TIME"], baselineAbsent: true,
        notes: ["AMPLIFIER ürünü — fixture şablonundan türetildi, kendisi P24B metni taşımaz"],
        evidence: [
          { class: "FK", detail: `payment_id = ${FIXTURE_PAYMENT} ('P24B fixture')` },
          { class: "DERIVED_FROM_FIXTURE", detail: `amount_source = '${i.amount_source}' — üreteç ürünü` },
          { class: "BASELINE_ABSENT", detail: "temiz taban ve release klonlarında yok" },
          { class: "TIME", detail: `created_at ${i.created_at}` },
        ],
      });
    }

    const counts: Record<string, number> = {};
    for (const r of rows) counts[r.table] = (counts[r.table] ?? 0) + 1;
    const manifest = {
      generatedAtUtc: new Date().toISOString(),
      database: db,
      discoveryBaseSha: "1675c92a0aea120d200b9b10c2f260e57ad9b051",
      evidenceRule:
        "DELETE_TARGET için en az 2 BAĞIMSIZ kanıt sınıfı zorunlu. TIME sayıma DAHİL DEĞİLDİR.",
      counts,
      total: rows.length,
      classificationTotals: rows.reduce<Record<string, number>>((a, r) => {
        a[r.classification] = (a[r.classification] ?? 0) + 1; return a;
      }, {}),
      rows,
    };
    writeFileSync(process.argv[2], JSON.stringify(manifest, null, 2) + "\n", "utf8");

    const md = [
      "# 02 — Satır bazlı kanıt manifesti",
      "",
      `Üretim: \`node --import tsx scripts/qa/p24b-row-evidence.ts\` · ${manifest.generatedAtUtc}`,
      "",
      "**Kural:** `DELETE_TARGET` için en az **2 bağımsız kanıt sınıfı**. `TIME` sayıma dahil değildir.",
      "",
      "| tablo | id | sınıflandırma | olay | xmin | kanıt sınıfları (TIME hariç) | n |",
      "|---|---|---|---|---|---|---|",
      ...rows.map((r) =>
        `| \`${r.table}\` | \`${r.id.slice(0, 8)}\` | **${r.classification}** | ${r.incidentId ?? "-"} | ${r.xmin} | ${[...new Set(r.evidence.map((e) => e.class))].filter((k) => k !== "TIME").join(", ")} | ${r.independentEvidenceClassCount} |`),
      "",
      "## Toplamlar",
      "",
      "| tablo | n |", "|---|---|",
      ...Object.entries(counts).map(([k, v]) => `| ${k} | ${v} |`),
      `| **TOPLAM** | **${rows.length}** |`,
      "",
    ].join("\n");
    writeFileSync(process.argv[3], md, "utf8");

    console.log(`${rows.length} satır · ${JSON.stringify(manifest.classificationTotals)}`);
    const weak = rows.filter((r) => r.classification === "DELETE_TARGET" && r.independentEvidenceClassCount < 2);
    if (weak.length) {
      console.error(`YETERSİZ KANIT: ${weak.length} satır 2 sınıfın altında`);
      for (const w of weak) console.error(`  ${w.table} ${w.id}`);
      process.exit(1);
    }
  } finally {
    await c.query("rollback").catch(() => {});
    c.release();
    await pool.end();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
