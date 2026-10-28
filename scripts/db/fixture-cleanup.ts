// RETIRED — this script must never run again. It refuses to.
//
// It was written against an early, INCOMPLETE map of the P24B contamination and its numbers were
// wrong in a way that would have left the database half-cleaned while reporting success:
//
//   it expected   users = 4        measured footprint: 6
//                 payment_instances = 3                26
//                 settings          — unknown to it     1
//                 approvals         — unknown to it     4
//
// Four of the six p24b users, both settings and approvals rows, and 23 of the 26 generated
// payment_instances were outside its scope entirely. Its hard-coded username list also pinned the
// random suffixes of ONE run (`p24b_mk_mujyy6`, `p24b_op_9bcmx5`), so the second incident's users
// could never have matched it.
//
// The measured footprint is 42 rows across 6 tables, established by V6/V6.1 and recorded with
// per-row evidence in:
//   docs/release-evidence/final-production-readiness/p24b-v6/02-row-evidence-manifest.json
//
// REPLACEMENT:  scripts/db/p24b-fixture-cleanup.ts
//   · takes its scope from that manifest, with the manifest's SHA256 pinned
//   · re-reads and fingerprint-checks all 42 rows before deleting anything
//   · exact primary identity only — no LIKE, no timestamp range, no heuristic
//   · three independent locks before real execution, and a rehearsal path that cannot touch
//     a protected database
//
// Not deleted, because the incident history explains why the replacement is shaped the way it is;
// but every legacy count is gone from this file and it cannot execute.
console.error(
  [
    "Bu script EMEKLİ EDİLDİ ve çalıştırılamaz.",
    "",
    "Eski kapsamı EKSİKTİ: 6 p24b kullanıcısından 4'ünü tanıyordu, 26 payment_instances yerine 3",
    "bekliyordu, settings ve approvals satırlarını hiç bilmiyordu. Çalıştırılsaydı veritabanını",
    "yarım temizleyip 'başarılı' raporlardı.",
    "",
    "Yerine: scripts/db/p24b-fixture-cleanup.ts",
    "Kapsam kaynağı: docs/release-evidence/final-production-readiness/p24b-v6/02-row-evidence-manifest.json",
  ].join("\n"),
);
process.exit(1);
