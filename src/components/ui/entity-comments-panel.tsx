import type { ReactNode } from "react";
import { addEntityCommentAction } from "@/app/(dashboard)/collab-actions";
import { Badge } from "@/components/ui/badge";
import { Panel } from "@/components/ui/panel";
import { Button } from "@/components/ui/primitives/button";
import type { EntityCommentRow } from "@/lib/collaboration/comments";

export interface EntityCommentsPanelProps {
  entityType: string;
  entityId: string;
  comments: EntityCommentRow[];
  returnTo: string;
  canComment?: boolean;
  title?: string;
  description?: string;
}

function formatCommentDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat("tr-TR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Europe/Istanbul",
  }).format(d);
}

function renderHighlightedBody(body: string): ReactNode[] {
  const parts: ReactNode[] = [];
  const re = /(^|[\s([{"',;:])@([a-zA-Z0-9_.-]{3,32})/g;
  let lastIdx = 0;
  let match: RegExpExecArray | null;

  while ((match = re.exec(body)) !== null) {
    const prefix = match[1] ?? "";
    const rawUser = match[2] ?? "";
    const cleanUser = rawUser.replace(/[.-]+$/, "");
    const trailingPunct = rawUser.slice(cleanUser.length);
    const tokenStart = match.index + prefix.length;

    if (tokenStart > lastIdx) {
      parts.push(body.slice(lastIdx, tokenStart));
    }

    if (/^[a-zA-Z0-9_.-]{3,32}$/.test(cleanUser)) {
      parts.push(
        <span
          key={`${tokenStart}-${cleanUser}`}
          className="inline-flex items-center rounded border border-[var(--info-border)] bg-[var(--info-bg)] px-1.5 py-0.5 font-mono text-[11px] font-medium text-[var(--info)]"
        >
          @{cleanUser.toLowerCase()}
        </span>,
      );
      if (trailingPunct) {
        parts.push(trailingPunct);
      }
    } else {
      parts.push(`@${rawUser}`);
    }

    lastIdx = match.index + match[0].length;
  }

  if (lastIdx < body.length) {
    parts.push(body.slice(lastIdx));
  }

  return parts;
}

export function EntityCommentsPanel({
  entityType,
  entityId,
  comments,
  returnTo,
  canComment = true,
  title = "Kayıt Üstü İşbirliği & İnceleme Notları",
  description = "Ekip üyelerini @kullanıcıadı ile etiketleyerek denetim izli inceleme notu bırakın; etiketlenen kişilerin üst bildirim çanına anında düşer.",
}: EntityCommentsPanelProps) {
  return (
    <Panel
      title={title}
      subtitle={description}
      right={
        <Badge tone={comments.length > 0 ? "blue" : "neutral"}>
          <span className="tabular-nums">{comments.length}</span> yorum
        </Badge>
      }
    >
      <div className="space-y-4">
        {comments.length === 0 ? (
          <div className="rounded-[var(--radius-sm)] border border-dashed border-[var(--border)] bg-[var(--surface-2)]/60 px-3.5 py-4 text-[12.5px] text-[var(--muted)]">
            Bu kapsam için henüz inceleme notu girilmedi. İlk denetim veya mutabakat notunu{" "}
            <span className="font-mono text-[11.5px] text-[var(--ink-2)]">@kullanıcı</span>{" "}
            etiketiyle paylaşabilirsiniz.
          </div>
        ) : (
          <ul className="divide-y divide-[var(--border)] rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--surface-2)]/40">
            {comments.map((c) => (
              <li key={c.id} className="px-3.5 py-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <span className="text-[12.5px] font-semibold text-[var(--ink)]">
                      {c.authorDisplayName}
                    </span>
                    {c.authorUsername ? (
                      <span className="font-mono text-[11px] text-[var(--muted)]">
                        @{c.authorUsername}
                      </span>
                    ) : null}
                    {c.mentionedUsernames.length > 0 ? (
                      <Badge tone="blue" dot>
                        <span className="tabular-nums">{c.mentionedUsernames.length}</span> etiket
                      </Badge>
                    ) : null}
                  </div>
                  <time
                    dateTime={c.createdAt}
                    className="font-mono text-[11px] tabular-nums text-[var(--muted)]"
                  >
                    {formatCommentDate(c.createdAt)}
                  </time>
                </div>
                <p className="mt-1.5 whitespace-pre-wrap text-[13px] leading-relaxed text-[var(--ink-2)]">
                  {renderHighlightedBody(c.body)}
                </p>
              </li>
            ))}
          </ul>
        )}

        {canComment ? (
          <form
            action={addEntityCommentAction}
            className="space-y-2.5 rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--surface-1)] p-3"
          >
            <input type="hidden" name="entityTable" value={entityType.toLowerCase()} />
            <input type="hidden" name="entityId" value={entityId} />
            <input type="hidden" name="returnTo" value={returnTo} />
            <label className="block space-y-1">
              <span className="text-[11px] font-semibold uppercase tracking-[0.05em] text-[var(--muted)]">
                Yorum Ekle (@kullanıcı)
              </span>
              <textarea
                name="body"
                rows={2}
                required
                maxLength={4000}
                placeholder="İnceleme veya aksiyon notu yazın... (Örn: @admin iç kontrol mutabakatı doğrulandı)"
                className="w-full rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--surface-2)]/50 px-3 py-2 text-base text-[var(--ink)] placeholder:text-[var(--muted)] focus:border-[var(--accent)] focus:outline-none sm:text-[13px]"
              />
            </label>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-[11px] text-[var(--muted)]">
                Kapsam anahtarı:{" "}
                <code className="font-mono text-[10.5px] text-[var(--ink-2)]">
                  {entityType.toLowerCase()}:{entityId}
                </code>
              </span>
              <Button type="submit" size="sm" variant="accent">
                Yorum Ekle (@kullanıcı)
              </Button>
            </div>
          </form>
        ) : (
          <p className="text-[11.5px] text-[var(--muted)]">
            Görüntüleme rolündesiniz; yeni yorum ekleme yetkisi operatör ve üzeri rollerde açıktır.
          </p>
        )}
      </div>
    </Panel>
  );
}
