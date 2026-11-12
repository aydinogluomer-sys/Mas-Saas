import type { ReactNode } from "react";
import { Panel } from "@/components/ui/panel";

/**
 * Faz 6 — Suspense streaming fallback that preserves Panel chrome and geometry
 * while below-the-fold async Server Components resolve.
 */
export function PanelSkeleton({
  title,
  subtitle,
  rows = 3,
  className = "",
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  rows?: number;
  className?: string;
}) {
  const count = Math.max(1, Math.min(8, rows));
  return (
    <div aria-busy="true" aria-live="polite" data-testid="panel-skeleton" className={className}>
      <Panel title={title} subtitle={subtitle}>
        <div className="space-y-2 py-1">
          {Array.from({ length: count }, (_, idx) => (
            <div
              key={idx}
              className="h-4 animate-pulse rounded"
              style={{
                width: idx === count - 1 ? "62%" : idx % 2 === 0 ? "92%" : "78%",
                background: "var(--surface-2)",
              }}
            />
          ))}
        </div>
      </Panel>
    </div>
  );
}

