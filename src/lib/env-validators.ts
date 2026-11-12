// Pure environment & hostname validators with zero runtime side effects.
// Safe to import from standalone CLI preflight scripts (`scripts/check-env.ts`)
// without triggering eager `process.env` schema validation in `src/lib/env.ts`.

export function isLoopbackHostname(hostname: string): boolean {
  const h = hostname.trim().toLowerCase().replace(/^\[|\]$/g, "");
  return h === "127.0.0.1" || h === "localhost" || h === "::1";
}

/**
 * Extracts the hostname from a single HTTP `Host` / `X-Forwarded-Host` hop
 * (supporting IPv4, `localhost`, and bracketed IPv6 `[::1]:3000`).
 * Returns `""` when empty, or `null` when malformed / containing userinfo or path segments.
 */
export function extractHostHeaderHostname(rawHost: string): string | null {
  const first = rawHost.split(",")[0]?.trim() ?? "";
  if (!first) return "";
  if (first === "::1") return "::1";
  if (/[/?#@\\\s]/.test(first)) return null;
  try {
    const parsed = new URL(`http://${first}`);
    if (parsed.username || parsed.password || parsed.pathname !== "/") return null;
    return parsed.hostname;
  } catch {
    return null;
  }
}

export function isPrivateOrLoopbackHost(hostname: string): boolean {
  const h = hostname.trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (!h) return true;
  if (
    h === "localhost" ||
    h === "0.0.0.0" ||
    h === "::1" ||
    h.endsWith(".localhost") ||
    h.endsWith(".local") ||
    h.endsWith(".internal")
  ) {
    return true;
  }
  if (/^127\./.test(h) || /^10\./.test(h) || /^192\.168\./.test(h) || /^169\.254\./.test(h)) {
    return true;
  }
  const m172 = h.match(/^172\.(\d{1,3})\./);
  if (m172) {
    const second = Number(m172[1]);
    if (second >= 16 && second <= 31) return true;
  }
  if (/^(fc|fd|fe80):/i.test(h)) return true;
  return false;
}

export function validateEmailApiUrl(
  rawUrl: string | undefined,
  allowedHostsCsv: string | undefined,
): string | null {
  if (!rawUrl) return null;
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(rawUrl);
  } catch {
    return "EMAIL_API_URL geçerli bir HTTPS URL olmalı.";
  }
  if (parsedUrl.protocol !== "https:") {
    return "EMAIL_API_URL yalnız 'https://' protokolünü kullanabilir.";
  }
  if (parsedUrl.username || parsedUrl.password) {
    return "EMAIL_API_URL kullanıcı adı veya parola içeremez.";
  }
  const host = parsedUrl.hostname.toLowerCase();
  if (isPrivateOrLoopbackHost(host)) {
    return "EMAIL_API_URL yerel veya özel ağ adresine (SSRF) işaret edemez.";
  }
  const allowed = (allowedHostsCsv ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (allowed.length > 0 && !allowed.includes(host)) {
    return `EMAIL_API_URL alan adı (${host}) MAS_ALLOWED_EMAIL_HOSTS beyaz listesinde değil.`;
  }
  return null;
}
