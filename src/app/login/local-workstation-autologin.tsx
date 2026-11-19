"use client";

import { useEffect, useRef } from "react";
import { localWorkstationAutoLoginAction } from "./actions";

export function LocalWorkstationAutoLogin({ next }: { next: string }) {
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void localWorkstationAutoLoginAction(next);
  }, [next]);

  return (
    <div className="flex min-h-screen items-center justify-center bg-surface-0 p-4 text-tone-1">
      <div className="font-mono text-[11px] uppercase tracking-[0.14em] text-tone-3">
        MAS Nakit Radar açılıyor…
      </div>
    </div>
  );
}

