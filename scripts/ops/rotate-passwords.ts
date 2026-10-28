#!/usr/bin/env node
/**
 * scripts/ops/rotate-passwords.ts
 *
 * Operational utility for Phase 4: rotates credentials for specified users (default: admin, atilla),
 * generates high-entropy temporary passwords, sets must_change_password = true,
 * revokes all active sessions, and logs audit events.
 *
 * Usage:
 *   pnpm exec tsx scripts/ops/rotate-passwords.ts [--users=admin,atilla]
 *   pnpm exec tsx scripts/ops/rotate-passwords.ts --check
 */
import { loadEnvConfig } from "@next/env";
loadEnvConfig(process.cwd());

import { randomBytes } from "node:crypto";

function generateSecurePassword(): string {
  // Generate a 16-char high entropy string with upper, lower, digits, and safe symbols
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%&*+";
  const bytes = randomBytes(16);
  let pwd = "";
  for (let i = 0; i < 16; i++) {
    pwd += alphabet[bytes[i] % alphabet.length];
  }
  // Ensure at least one upper, one lower, one digit, one symbol
  return pwd + "!1Aa";
}

async function main(): Promise<void> {
  const { getRawPool } = await import("../../src/lib/db");
  const { hashPassword } = await import("../../src/lib/auth");
  const pool = getRawPool();

  const args = process.argv.slice(2);
  const isCheck = args.includes("--check");

  if (isCheck) {
    const res = await pool.query<{
      username: string;
      role: string;
      is_active: boolean;
      must_change_password: boolean;
      locked_until: string | null;
      failed_login_count: number;
    }>(
      `select username, role, is_active, must_change_password, locked_until, failed_login_count
       from public.users
       order by username`,
    );
    console.log("\n=== KULLANICI GÜVENLİK DURUMU ===");
    console.table(res.rows);
    process.exit(0);
  }

  // Parse target users
  const userArg = args.find((a) => a.startsWith("--users="));
  const targetUsers = userArg
    ? userArg.split("=")[1].split(",").map((u) => u.trim().toLowerCase()).filter(Boolean)
    : ["admin", "atilla"];

  console.log(`\n=== ŞİFRE ROTASYONU BAŞLATILIYOR ===`);
  console.log(`Hedef hesaplar: ${targetUsers.join(", ")}`);
  console.log(`Zorunlu şifre değişimi (must_change_password): AKTİF\n`);

  const results: Array<{
    Kullanıcı: string;
    Rol: string;
    "Geçici Parola": string;
    "Zorunlu Değişim": string;
    "Oturumlar İptal": number;
  }> = [];

  const client = await pool.connect();
  try {
    for (const username of targetUsers) {
      await client.query("begin");
      const userRes = await client.query<{ id: string; role: string; is_active: boolean }>(
        `select id, role, is_active from public.users where username = $1 for update`,
        [username],
      );

      if (userRes.rowCount === 0) {
        console.warn(`[UYARI] Kullanıcı bulunamadı: ${username}`);
        await client.query("rollback");
        continue;
      }

      const user = userRes.rows[0];
      const tempPassword = generateSecurePassword();
      const pwdHash = await hashPassword(tempPassword);

      await client.query(
        `update public.users
         set password_hash = $2,
             must_change_password = true,
             failed_login_count = 0,
             locked_until = null
         where id = $1`,
        [user.id, pwdHash],
      );

      // Invalidate all active sessions
      const revokedRes = await client.query(
        `update public.sessions
         set revoked_at = now()
         where user_id = $1 and revoked_at is null`,
        [user.id],
      );

      // Audit log
      await client.query(
        `insert into public.audit_logs (actor, action, entity_table, entity_id, before_data, after_data)
         values ($1, $2, $3, $4, $5, $6)`,
        [
          user.id,
          "rotate_user_password_ops",
          "users",
          user.id,
          JSON.stringify({ username, role: user.role }),
          JSON.stringify({
            username,
            role: user.role,
            password_rotated: true,
            must_change_password: true,
            sessions_revoked: revokedRes.rowCount ?? 0,
          }),
        ],
      );

      await client.query("commit");

      results.push({
        Kullanıcı: username,
        Rol: user.role,
        "Geçici Parola": tempPassword,
        "Zorunlu Değişim": "EVET",
        "Oturumlar İptal": revokedRes.rowCount ?? 0,
      });
    }
  } finally {
    client.release();
  }

  console.log("=== ROTASYON TAMAMLANDI ===");
  console.table(results);
  console.log(
    "\n[ÖNEMLİ] Bu kullanıcılar ilk girişlerinde doğrudan /change-password ekranına yönlendirilecek ve yeni şifre belirlemeden işlem yapamayacaklardır.\n",
  );
  process.exit(0);
}

main().catch((err) => {
  console.error("Şifre rotasyonu hatası:", err);
  process.exit(1);
});
