"use client";

import { usePathname } from "next/navigation";
import { setExecutiveLocaleAction } from "@/app/(dashboard)/collab-actions";
import Link from "@/components/ui/app-link";
import type { MentionNotificationRow } from "@/lib/collaboration/comments";

export type ExecutiveLocale = "tr" | "en";

export interface HeaderCollabBarProps {
  mentions: MentionNotificationRow[];
  locale: ExecutiveLocale;
}

function formatShortTimestamp(iso: string, locale: ExecutiveLocale): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso.slice(0, 10);
  return new Intl.DateTimeFormat(locale === "en" ? "en-GB" : "tr-TR", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Europe/Istanbul",
  }).format(d);
}

export function HeaderCollabBar({ mentions, locale }: HeaderCollabBarProps) {
  const pathname = usePathname() || "/";
  const count = mentions.length;
  const isEn = locale === "en";

  return (
    <div className="inline-flex items-center gap-2">
      {/* @mention Notification Bell */}
      <details className="group relative">
        <summary
          className="inline-flex cursor-pointer list-none items-center gap-1.5 rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--surface-1)] px-2 py-1 text-[11px] font-medium text-[var(--ink-2)] transition-colors hover:border-[var(--border-strong)] hover:bg-[var(--surface-2)] [&::-webkit-details-marker]:hidden"
          aria-label={
            isEn
              ? `Mentions (${count})`
              : `Bahsetme bildirimleri (${count})`
          }
        >
          <svg
            width="13"
            height="13"
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
            className="text-[var(--ink-2)]"
          >
            <path d="M8 2a4 4 0 0 0-4 4v2.6c0 .6-.24 1.17-.66 1.6L2.5 11h11l-.84-.8a2.26 2.26 0 0 1-.66-1.6V6a4 4 0 0 0-4-4Z" />
            <path d="M6.4 12.5a1.8 1.8 0 0 0 3.2 0" />
          </svg>
          <span className="hidden md:inline">
            {isEn ? "Mentions" : "Bildirimler"}
          </span>
          <span
            className={`inline-flex min-w-[18px] items-center justify-center rounded-full px-1.5 py-0.2 text-[10px] font-semibold tabular-nums ${
              count > 0
                ? "border border-[var(--info-border)] bg-[var(--info-bg)] text-[var(--info)]"
                : "bg-[var(--surface-2)] text-[var(--muted)]"
            }`}
          >
            {count}
          </span>
        </summary>

        <div className="absolute right-0 top-full z-50 mt-1.5 w-[min(22rem,calc(100vw-2rem))] rounded-[var(--radius-md)] border border-[var(--border-strong)] bg-[var(--surface-1)] p-3 shadow-[var(--shadow-lg)]">
          <div className="mb-2 flex items-center justify-between border-b border-[var(--border)] pb-2">
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-[0.06em] text-[var(--ink)]">
                {isEn ? "Recent @Mentions" : "Son @Bahsetmeler"}
              </p>
              <p className="text-[11px] text-[var(--muted)]">
                {isEn
                  ? "Direct audit & collaboration tags"
                  : "Kayıt üstü işbirliği ve denetim etiketleri"}
              </p>
            </div>
            <span className="rounded border border-[var(--border)] bg-[var(--surface-2)] px-1.5 py-0.5 font-mono text-[10px] font-medium tabular-nums text-[var(--ink-2)]">
              {count}
            </span>
          </div>

          {count === 0 ? (
            <p className="py-3 text-center text-[12px] text-[var(--muted)]">
              {isEn
                ? "No recent @mentions for your account."
                : "Hesabınız için yeni @mention bildirimi yok."}
            </p>
          ) : (
            <ul className="max-h-72 divide-y divide-[var(--border)] overflow-y-auto">
              {mentions.map((m) => (
                <li key={m.id} className="py-2 first:pt-0.5 last:pb-0.5">
                  <Link
                    href={m.targetHref}
                    className="block rounded-[var(--radius-sm)] px-2 py-1.5 transition-colors hover:bg-[var(--surface-2)]"
                  >
                    <div className="flex items-center justify-between gap-2 text-[11px]">
                      <span className="font-semibold text-[var(--ink)]">
                        {m.authorDisplayName}
                        {m.authorUsername ? (
                          <span className="ml-1 font-mono text-[10px] font-normal text-[var(--info)]">
                            @{m.authorUsername}
                          </span>
                        ) : null}
                      </span>
                      <span className="shrink-0 font-mono text-[10px] tabular-nums text-[var(--muted)]">
                        {formatShortTimestamp(m.createdAt, locale)}
                      </span>
                    </div>
                    <p className="mt-0.5 line-clamp-2 text-[12px] leading-snug text-[var(--ink-2)]">
                      {m.bodyPreview}
                    </p>
                    <span className="mt-1 inline-block font-mono text-[10px] uppercase tracking-[0.04em] text-[var(--muted)]">
                      {m.entityTable} · {m.entityId.slice(0, 18)}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
      </details>

      {/* Executive TR / EN Locale Switcher */}
      <form
        action={setExecutiveLocaleAction}
        className="inline-flex items-center rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--surface-1)] p-0.5"
        aria-label={isEn ? "Workspace language" : "Çalışma alanı dili"}
      >
        <input type="hidden" name="returnTo" value={pathname} />
        <button
          type="submit"
          name="locale"
          value="tr"
          aria-pressed={!isEn}
          title="Türkçe çalışma alanı"
          className={`rounded-[4px] px-1.5 py-0.5 font-mono text-[10px] font-semibold tracking-[0.04em] transition-colors ${
            !isEn
              ? "bg-[var(--surface-3)] text-[var(--ink)] shadow-[var(--shadow-xs)]"
              : "text-[var(--muted)] hover:text-[var(--ink-2)]"
          }`}
        >
          TR
        </button>
        <button
          type="submit"
          name="locale"
          value="en"
          aria-pressed={isEn}
          title="English executive chrome"
          className={`rounded-[4px] px-1.5 py-0.5 font-mono text-[10px] font-semibold tracking-[0.04em] transition-colors ${
            isEn
              ? "bg-[var(--surface-3)] text-[var(--ink)] shadow-[var(--shadow-xs)]"
              : "text-[var(--muted)] hover:text-[var(--ink-2)]"
          }`}
        >
          EN
        </button>
      </form>
    </div>
  );
}

