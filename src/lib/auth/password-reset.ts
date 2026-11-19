// Faz 61 (0121) — Self-Servis Parola Sıfırlama (CSPRNG + SHA-256 + 30 dk TTL) ve Kurumsal SSO/OIDC Sağlayıcı Kayıtları.
//
// Güvenlik Kuralları:
//   * Ham sıfırlama jetonu (32 bayt CSPRNG hex) veritabanına veya denetim izine ASLA yazılmaz;
//     yalnız `sha256(rawToken)` özeti saklanır.
//   * `requestPasswordReset` kullanıcı/e-posta varlığını dışarı sızdırmaz (`{ accepted: true }`).
//   * Parola özeti `src/lib/auth.ts` ile birebir aynı OWASP Argon2id parametreleriyle üretilir.
//   * Ağ çıkışı yalnız `@/lib/reminders/transport` (`transportFor("email")` / `telegramTransport`) üzerinden yapılır.

import { createHash, randomBytes } from "node:crypto";
import { hash as argon2Hash } from "@node-rs/argon2";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { audit } from "@/lib/audit";
import { DomainError } from "@/lib/domain-error";
import { telegramTransport, transportFor, type Transport } from "@/lib/reminders/transport";
import {
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  passwordSchema,
} from "@/lib/users/password-policy";
import { parseOrThrow } from "@/lib/validation";

/** Mirrors `ARGON2_OPTIONS` in `src/lib/auth.ts` (Algorithm.Argon2id = 2, 19 MiB, t=2, p=1). */
const ARGON2_OPTIONS = {
  algorithm: 2,
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
} as const;

export const PASSWORD_RESET_TTL_MINUTES = 30;
export const PASSWORD_RESET_TTL_MS = PASSWORD_RESET_TTL_MINUTES * 60 * 1000;

const RESERVED_USERNAMES = ["system", "testsprite-qa"] as const;

export const SSO_PROVIDER_KEYS = [
  "entra_id",
  "google_workspace",
  "custom_oidc",
  "webauthn_passkey",
] as const;
export type SsoProviderKey = (typeof SSO_PROVIDER_KEYS)[number];

export interface SsoIdentityProviderRow {
  id: string;
  providerKey: SsoProviderKey;
  displayName: string;
  issuerUrl: string | null;
  clientId: string | null;
  allowedDomains: string[];
  isEnabled: boolean;
  updatedBy: string | null;
  updatedAt: string;
}

export const upsertSsoProviderSchema = z
  .object({
    providerKey: z.enum(SSO_PROVIDER_KEYS),
    displayName: z.string().trim().min(2, "Sağlayıcı görünen adı en az 2 karakter olmalı.").max(120),
    issuerUrl: z
      .string()
      .trim()
      .max(500)
      .optional()
      .nullable()
      .transform((v) => (v && v.length > 0 ? v : null)),
    clientId: z
      .string()
      .trim()
      .max(240)
      .optional()
      .nullable()
      .transform((v) => (v && v.length > 0 ? v : null)),
    allowedDomains: z
      .array(z.string().trim().toLowerCase().min(1).max(120))
      .max(50)
      .default([]),
    isEnabled: z.coerce.boolean().default(false),
  })
  .superRefine((val, ctx) => {
    if (val.issuerUrl && !/^https:\/\//i.test(val.issuerUrl)) {
      ctx.addIssue({
        code: "custom",
        path: ["issuerUrl"],
        message: "OIDC Issuer URL güvenli `https://` ile başlamalıdır.",
      });
    }
    if (val.isEnabled && val.providerKey !== "webauthn_passkey") {
      if (!val.issuerUrl) {
        ctx.addIssue({
          code: "custom",
          path: ["issuerUrl"],
          message: "Aktif OIDC sağlayıcısı için Issuer URL zorunludur.",
        });
      }
      if (!val.clientId) {
        ctx.addIssue({
          code: "custom",
          path: ["clientId"],
          message: "Aktif OIDC sağlayıcısı için Client ID zorunludur.",
        });
      }
    }
  });

export type UpsertSsoProviderInput = z.input<typeof upsertSsoProviderSchema>;

/** Computes the lowercase hex SHA-256 digest of a raw password-reset token. */
export function hashResetToken(rawToken: string): string {
  return createHash("sha256").update(rawToken.trim(), "utf8").digest("hex");
}

/** Mints a 32-byte (64-hex-char) CSPRNG reset token, its SHA-256 digest, and 30-minute expiry ISO timestamp. */
export function generatePasswordResetToken(nowMs: number = Date.now()): {
  rawToken: string;
  tokenSha256: string;
  expiresAt: string;
} {
  const rawToken = randomBytes(32).toString("hex");
  const tokenSha256 = hashResetToken(rawToken);
  const expiresAt = new Date(nowMs + PASSWORD_RESET_TTL_MS).toISOString();
  return { rawToken, tokenSha256, expiresAt };
}

/** Pure usability predicate for unit & runtime checks: unconsumed and strictly before `expiresAt`. */
export function isResetTokenUsable(
  row: { expiresAt: string | Date; consumedAt?: string | Date | null },
  nowMs: number = Date.now(),
): boolean {
  if (row.consumedAt !== null && row.consumedAt !== undefined) return false;
  const expMs =
    row.expiresAt instanceof Date ? row.expiresAt.getTime() : new Date(row.expiresAt).getTime();
  if (!Number.isFinite(expMs)) return false;
  return expMs > nowMs;
}

/**
 * Ensures transaction-local access to `users` / `sessions` / `password_reset_tokens` when
 * invoked via `getPool()` on an unauthenticated `/login` action (`session_user = 'mas_radar_app'`).
 */
async function ensureAuthRuntimeRoleInTx(client: PoolClient): Promise<{
  sessionUser: string;
  currentRole: string;
}> {
  const who = await client.query<{ sess_usr: string; curr_usr: string }>(
    `select session_user as sess_usr, current_user as curr_usr`,
  );
  const sessionUser = who.rows[0]?.sess_usr ?? "";
  let currentRole = who.rows[0]?.curr_usr ?? "";

  if (
    sessionUser === "mas_radar_app" &&
    currentRole !== "mas_radar_app" &&
    currentRole !== "mas_radar_admin"
  ) {
    await client.query("set local role none");
    currentRole = "mas_radar_app";
  }

  return { sessionUser, currentRole };
}

async function elevateForAuditIfRuntimeRole(
  client: PoolClient,
  roleState: { sessionUser: string; currentRole: string },
): Promise<void> {
  if (roleState.sessionUser === "mas_radar_app" && roleState.currentRole === "mas_radar_app") {
    await client.query("set local role mas_radar_finance_manager");
  }
}

export interface RequestPasswordResetOptions {
  transportOverride?: Transport;
  resetBaseUrl?: string;
}

/**
 * Initiates a self-service password reset without revealing whether `usernameOrEmail` exists.
 * Stores ONLY `sha256(token)` with a 30-minute TTL and dispatches the reset link via configured
 * reminder transports (`email`, falling back to `telegram` when email is unconfigured).
 */
export async function requestPasswordReset(
  pool: Pool,
  usernameOrEmail: string,
  requestedIp?: string | null,
  opts?: RequestPasswordResetOptions,
): Promise<{ accepted: true }> {
  const lookup = (usernameOrEmail ?? "").trim().toLowerCase();
  const generated = generatePasswordResetToken();
  if (!lookup || lookup.length > 180) {
    return { accepted: true };
  }

  const cleanIp = requestedIp?.trim() ? requestedIp.trim().slice(0, 120) : null;
  let dispatchPayload: { username: string; displayName: string; rawToken: string; expiresAt: string } | null =
    null;

  const client = await pool.connect();
  try {
    await client.query("begin");
    const roleState = await ensureAuthRuntimeRoleInTx(client);

    const userRes = await client.query<{
      id: string;
      username: string;
      display_name: string;
      is_active: boolean;
    }>(
      `select id::text, username, display_name, is_active
         from public.users
        where username <> all($2::text[])
          and (lower(username) = $1 or lower(coalesce(email, '')) = $1)
        order by (lower(username) = $1) desc, created_at asc
        limit 1
        for update`,
      [lookup, RESERVED_USERNAMES],
    );

    const user = userRes.rowCount === 1 ? userRes.rows[0] : null;
    if (!user || !user.is_active) {
      await client.query("commit");
      return { accepted: true };
    }

    // Supersede any prior unconsumed reset tokens for this user so at most one token is live
    await client.query(
      `update public.password_reset_tokens
          set consumed_at = now()
        where user_id = $1
          and consumed_at is null`,
      [user.id],
    );

    const ins = await client.query<{ id: string }>(
      `insert into public.password_reset_tokens
         (user_id, token_sha256, expires_at, requested_ip)
       values ($1, $2, $3::timestamptz, $4)
       returning id::text`,
      [user.id, generated.tokenSha256, generated.expiresAt, cleanIp],
    );
    if (ins.rowCount !== 1) {
      throw new DomainError("Parola sıfırlama kaydı oluşturulamadı.");
    }
    const tokenRowId = ins.rows[0].id;

    await elevateForAuditIfRuntimeRole(client, roleState);
    await audit(client, {
      actor: user.id,
      action: "request_password_reset",
      entityTable: "password_reset_tokens",
      entityId: tokenRowId,
      after: {
        userId: user.id,
        username: user.username,
        expiresAt: generated.expiresAt,
        requestedIp: cleanIp,
      },
    });

    await client.query("commit");
    dispatchPayload = {
      username: user.username,
      displayName: user.display_name,
      rawToken: generated.rawToken,
      expiresAt: generated.expiresAt,
    };
  } catch (e) {
    await client.query("rollback").catch(() => undefined);
    throw e;
  } finally {
    client.release();
  }

  if (dispatchPayload) {
    const base = (opts?.resetBaseUrl ?? "/login").replace(/\/$/, "");
    const resetLink = `${base}?mode=reset&token=${encodeURIComponent(dispatchPayload.rawToken)}`;
    const message = [
      "MAS Nakit Radar — Parola Sıfırlama İsteği",
      `Hesap: ${dispatchPayload.displayName} (@${dispatchPayload.username})`,
      `Geçerlilik: ${PASSWORD_RESET_TTL_MINUTES} dakika`,
      `Sıfırlama Bağlantısı / Kodu: ${resetLink}`,
      "Bu isteği siz yapmadıysanız bu mesajı dikkate almayınız.",
    ].join("\n");

    try {
      if (opts?.transportOverride) {
        await opts.transportOverride.send(message);
      } else {
        const emailRes = await transportFor("email").send(message);
        if (!emailRes.ok && emailRes.skippedUnconfigured) {
          await telegramTransport().send(message);
        }
      }
    } catch {
      // Never surface transport errors to caller — prevents side-channel user enumeration
    }
  }

  return { accepted: true };
}

/**
 * Atomically verifies and consumes a raw password-reset token, enforces the 12-char password policy,
 * hashes the new password with Argon2id, revokes all active sessions, resets lockout counters,
 * and appends an `audit()` record.
 */
export async function completePasswordReset(
  pool: Pool,
  rawToken: string,
  newPassword: string,
): Promise<{
  ok: true;
  userId: string;
  username: string;
  sessionsRevoked: number;
}> {
  const cleanToken = (rawToken ?? "").trim();
  if (!/^[a-fA-F0-9]{64}$/.test(cleanToken)) {
    throw new DomainError(
      "VALIDATION",
      "Parola sıfırlama bağlantısı geçersiz veya süresi dolmuş.",
    );
  }

  if ((newPassword ?? "").length > PASSWORD_MAX_LENGTH) {
    throw new DomainError(
      "VALIDATION",
      `Yeni parola en fazla ${PASSWORD_MAX_LENGTH} karakter olabilir.`,
    );
  }
  if (!passwordSchema.safeParse(newPassword).success) {
    throw new DomainError(
      "VALIDATION",
      `Yeni parola en az ${PASSWORD_MIN_LENGTH} karakter olmalı.`,
    );
  }

  const tokenSha256 = hashResetToken(cleanToken);
  const newPasswordHash = await argon2Hash(newPassword, ARGON2_OPTIONS);

  const client = await pool.connect();
  try {
    await client.query("begin");
    const roleState = await ensureAuthRuntimeRoleInTx(client);

    const consumed = await client.query<{
      id: string;
      user_id: string;
    }>(
      `update public.password_reset_tokens
          set consumed_at = now()
        where token_sha256 = $1
          and consumed_at is null
          and expires_at > now()
        returning id::text, user_id::text`,
      [tokenSha256],
    );

    if (consumed.rowCount !== 1) {
      throw new DomainError(
        "VALIDATION",
        "Parola sıfırlama bağlantısı geçersiz, daha önce kullanılmış veya süresi dolmuş.",
      );
    }

    const tokenRow = consumed.rows[0];
    const userRes = await client.query<{
      id: string;
      username: string;
      is_active: boolean;
      failed_login_count: number;
      must_change_password: boolean;
    }>(
      `select id::text, username, is_active, failed_login_count, must_change_password
         from public.users
        where id = $1
        for update`,
      [tokenRow.user_id],
    );

    const user = userRes.rowCount === 1 ? userRes.rows[0] : null;
    if (!user || !user.is_active) {
      throw new DomainError("FORBIDDEN", "Hesap aktif olmadığı için parola sıfırlanamadı.");
    }

    if (newPassword.toLowerCase() === user.username.toLowerCase()) {
      throw new DomainError("VALIDATION", "Yeni parola kullanıcı adıyla aynı olamaz.");
    }

    const updUser = await client.query(
      `update public.users
          set password_hash = $2,
              must_change_password = false,
              failed_login_count = 0,
              locked_until = null
        where id = $1`,
      [user.id, newPasswordHash],
    );
    if (updUser.rowCount !== 1) {
      throw new DomainError("Kullanıcı parolası güncellenemedi.");
    }

    const revoked = await client.query(
      `update public.sessions
          set revoked_at = now()
        where user_id = $1
          and revoked_at is null`,
      [user.id],
    );
    const sessionsRevoked = revoked.rowCount ?? 0;

    await elevateForAuditIfRuntimeRole(client, roleState);
    await audit(client, {
      actor: user.id,
      action: "complete_password_reset",
      entityTable: "users",
      entityId: user.id,
      before: {
        username: user.username,
        failed_login_count: user.failed_login_count,
        must_change_password: user.must_change_password,
      },
      after: {
        username: user.username,
        password_changed: true,
        reset_token_id: tokenRow.id,
        failed_login_count: 0,
        must_change_password: false,
        sessions_revoked: sessionsRevoked,
      },
    });

    await client.query("commit");
    return {
      ok: true,
      userId: user.id,
      username: user.username,
      sessionsRevoked,
    };
  } catch (e) {
    await client.query("rollback").catch(() => undefined);
    throw e;
  } finally {
    client.release();
  }
}

function mapSsoRow(r: {
  id: string;
  provider_key: SsoProviderKey;
  display_name: string;
  issuer_url: string | null;
  client_id: string | null;
  allowed_domains: string[] | null;
  is_enabled: boolean;
  updated_by: string | null;
  updated_at: Date | string;
}): SsoIdentityProviderRow {
  return {
    id: r.id,
    providerKey: r.provider_key,
    displayName: r.display_name,
    issuerUrl: r.issuer_url,
    clientId: r.client_id,
    allowedDomains: Array.isArray(r.allowed_domains) ? r.allowed_domains : [],
    isEnabled: Boolean(r.is_enabled),
    updatedBy: r.updated_by,
    updatedAt: typeof r.updated_at === "string" ? r.updated_at : r.updated_at.toISOString(),
  };
}

export async function listSsoProviders(pool: Pool): Promise<SsoIdentityProviderRow[]> {
  try {
    const res = await pool.query<{
      id: string;
      provider_key: SsoProviderKey;
      display_name: string;
      issuer_url: string | null;
      client_id: string | null;
      allowed_domains: string[] | null;
      is_enabled: boolean;
      updated_by: string | null;
      updated_at: Date | string;
    }>(
      `select id::text,
              provider_key,
              display_name,
              issuer_url,
              client_id,
              allowed_domains,
              is_enabled,
              updated_by::text,
              updated_at
         from public.sso_identity_providers
        order by case provider_key
          when 'entra_id' then 1
          when 'google_workspace' then 2
          when 'custom_oidc' then 3
          when 'webauthn_passkey' then 4
          else 5
        end`,
    );
    return res.rows.map(mapSsoRow);
  } catch (err) {
    const pgCode = (err as { code?: string })?.code;
    if (pgCode === "42P01") return [];
    throw err;
  }
}

export async function upsertSsoProvider(
  pool: Pool,
  rawInput: UpsertSsoProviderInput,
  actorId: string,
): Promise<SsoIdentityProviderRow> {
  const input = parseOrThrow(upsertSsoProviderSchema, rawInput, "SSO kimlik sağlayıcısı");
  const validActorId = parseOrThrow(z.string().uuid(), actorId, "Yönetici kimliği");
  const uniqueDomains = [...new Set(input.allowedDomains.map((d) => d.replace(/^@/, "")))];

  const client = await pool.connect();
  try {
    await client.query("begin");
    const prevRes = await client.query<{
      id: string;
      provider_key: SsoProviderKey;
      display_name: string;
      issuer_url: string | null;
      client_id: string | null;
      allowed_domains: string[] | null;
      is_enabled: boolean;
    }>(
      `select id::text, provider_key, display_name, issuer_url, client_id, allowed_domains, is_enabled
         from public.sso_identity_providers
        where provider_key = $1
        for update`,
      [input.providerKey],
    );
    const before = prevRes.rowCount === 1 ? prevRes.rows[0] : null;

    const upserted = await client.query<{
      id: string;
      provider_key: SsoProviderKey;
      display_name: string;
      issuer_url: string | null;
      client_id: string | null;
      allowed_domains: string[] | null;
      is_enabled: boolean;
      updated_by: string | null;
      updated_at: Date | string;
    }>(
      `insert into public.sso_identity_providers
         (provider_key, display_name, issuer_url, client_id, allowed_domains, is_enabled, updated_by, updated_at)
       values ($1, $2, $3, $4, $5::text[], $6, $7, now())
       on conflict (provider_key) do update
          set display_name = excluded.display_name,
              issuer_url = excluded.issuer_url,
              client_id = excluded.client_id,
              allowed_domains = excluded.allowed_domains,
              is_enabled = excluded.is_enabled,
              updated_by = excluded.updated_by,
              updated_at = now()
       returning id::text, provider_key, display_name, issuer_url, client_id,
                 allowed_domains, is_enabled, updated_by::text, updated_at`,
      [
        input.providerKey,
        input.displayName,
        input.issuerUrl,
        input.clientId,
        uniqueDomains,
        input.isEnabled,
        validActorId,
      ],
    );

    if (upserted.rowCount !== 1) {
      throw new DomainError("FORBIDDEN", "SSO kimlik sağlayıcısı güncellenemedi.");
    }
    const row = mapSsoRow(upserted.rows[0]);

    await audit(client, {
      actor: validActorId,
      action: "upsert_sso_provider",
      entityTable: "sso_identity_providers",
      entityId: row.id,
      before,
      after: {
        providerKey: row.providerKey,
        displayName: row.displayName,
        issuerUrl: row.issuerUrl,
        clientId: row.clientId,
        allowedDomains: row.allowedDomains,
        isEnabled: row.isEnabled,
      },
    });

    await client.query("commit");
    return row;
  } catch (e) {
    await client.query("rollback").catch(() => undefined);
    throw e;
  } finally {
    client.release();
  }
}
