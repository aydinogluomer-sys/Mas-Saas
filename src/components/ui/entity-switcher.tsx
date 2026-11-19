"use client";

import { usePathname } from "next/navigation";
import { Building2, Check, ChevronDown, GitBranch, Layers, Settings2 } from "lucide-react";
import Link from "@/components/ui/app-link";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/primitives/dropdown-menu";
import { switchActiveEntityAction } from "@/lib/entities/actions";
import type { BranchRecord, LegalEntityRecord } from "@/lib/entities/engine";

export interface EntitySwitcherScope {
  mode: "consolidated" | "entity";
  legalEntityId: string | null;
  branchId: string | null;
  activeEntity: LegalEntityRecord | null;
  activeBranch: BranchRecord | null;
  entities: LegalEntityRecord[];
  branches: BranchRecord[];
}

/**
 * Top-Bar Group Entity / Branch / Consolidated Switcher (M-01).
 * Displays: Konsolide Grup | Active Legal Entity (MAS-HQ + VKN) | Branch (MERKEZ)
 * with instant Radix/CSS menu & Server Action switch.
 */
export function EntitySwitcher({ scope }: { scope: EntitySwitcherScope }) {
  const pathname = usePathname() || "/";
  const isConsolidated = scope.mode === "consolidated";
  const primaryEntity = scope.activeEntity ?? scope.entities.find((e) => e.isDefault) ?? scope.entities[0] ?? null;
  const displayEntityCode = primaryEntity?.code ?? "MAS-HQ";
  const displayVkn = scope.activeEntity?.taxIdVkn ?? primaryEntity?.taxIdVkn ?? null;
  const displayBranchCode = scope.activeBranch?.code ?? (scope.branches.find((b) => b.isHeadquarters)?.code ?? "MERKEZ");

  return (
    <div
      className="inline-flex flex-wrap items-center gap-1 rounded-[var(--radius-md)] border p-0.5"
      style={{
        background: "var(--surface-1)",
        borderColor: "var(--line-card)",
        boxShadow: "var(--shadow-card)",
      }}
      role="group"
      aria-label="Aktif grup şirketi ve şube kapsamı"
      data-testid="entity-switcher"
    >
      {/* 1. Konsolide Grup quick toggle */}
      <form action={switchActiveEntityAction} className="inline-flex">
        <input type="hidden" name="legalEntityId" value="consolidated" />
        <input type="hidden" name="branchId" value="" />
        <input type="hidden" name="returnTo" value={pathname} />
        <button
          type="submit"
          aria-pressed={isConsolidated}
          className="inline-flex items-center gap-1.5 rounded-[5px] px-2.5 py-1 text-[12px] font-semibold tracking-[-0.01em] transition-colors"
          style={
            isConsolidated
              ? {
                  background: "color-mix(in srgb, var(--info) 11%, var(--surface-1))",
                  color: "var(--info)",
                }
              : {
                  color: "var(--text-3)",
                }
          }
          title="Tüm grup şirketlerini konsolide görüntüle"
        >
          <Layers size={14} strokeWidth={1.75} aria-hidden />
          <span>Konsolide Grup</span>
        </button>
      </form>

      <span aria-hidden className="h-3.5 w-px" style={{ background: "var(--line)" }} />

      {/* 2. Legal Entity selector (MAS-HQ + VKN badge) */}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className="inline-flex items-center gap-1.5 rounded-[5px] px-2.5 py-1 text-[12px] font-semibold tracking-[-0.01em] transition-colors hover:bg-[var(--surface-hover)]"
            style={
              !isConsolidated
                ? {
                    background: "color-mix(in srgb, var(--pos) 11%, var(--surface-1))",
                    color: "var(--pos)",
                  }
                : { color: "var(--text-2)" }
            }
            aria-label="Tüzel kişilik seçin"
          >
            <Building2 size={14} strokeWidth={1.75} aria-hidden />
            <span>{isConsolidated ? `${displayEntityCode} (Grup)` : scope.activeEntity?.code ?? displayEntityCode}</span>
            {displayVkn && (
              <span
                className="hidden rounded border px-1 py-0.2 font-mono text-[10px] font-medium md:inline-block"
                style={{
                  borderColor: "var(--line)",
                  background: "var(--surface-2)",
                  color: "var(--text-3)",
                }}
              >
                VKN {displayVkn}
              </span>
            )}
            <ChevronDown size={13} strokeWidth={1.75} className="opacity-70" aria-hidden />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-72 p-1.5">
          <DropdownMenuLabel>Grup Şirketi Kapsamı</DropdownMenuLabel>
          <form action={switchActiveEntityAction}>
            <input type="hidden" name="legalEntityId" value="consolidated" />
            <input type="hidden" name="branchId" value="" />
            <input type="hidden" name="returnTo" value={pathname} />
            <button
              type="submit"
              className="flex w-full items-center justify-between gap-2 rounded-[var(--radius-sm)] px-2.5 py-2 text-left text-[12.5px] transition-colors hover:bg-[var(--surface-hover)]"
            >
              <span className="flex items-center gap-2">
                <Layers size={15} strokeWidth={1.75} style={{ color: "var(--info)" }} aria-hidden />
                <span>
                  <strong className="block font-semibold" style={{ color: "var(--text-1)" }}>
                    Konsolide Grup Görünümü
                  </strong>
                  <span className="block text-[11px]" style={{ color: "var(--text-3)" }}>
                    Tüm tüzel kişilikler ve şubeler toplamı
                  </span>
                </span>
              </span>
              {isConsolidated && <Check size={14} strokeWidth={2} style={{ color: "var(--info)" }} aria-hidden />}
            </button>
          </form>

          {scope.entities.length > 0 && <DropdownMenuSeparator />}
          {scope.entities.map((entity) => {
            const selected = !isConsolidated && scope.activeEntity?.id === entity.id;
            return (
              <form key={entity.id} action={switchActiveEntityAction}>
                <input type="hidden" name="legalEntityId" value={entity.id} />
                <input type="hidden" name="branchId" value="" />
                <input type="hidden" name="returnTo" value={pathname} />
                <button
                  type="submit"
                  className="flex w-full items-center justify-between gap-2 rounded-[var(--radius-sm)] px-2.5 py-2 text-left text-[12.5px] transition-colors hover:bg-[var(--surface-hover)]"
                >
                  <span className="min-w-0">
                    <span className="flex items-center gap-1.5">
                      <Building2 size={14} strokeWidth={1.75} style={{ color: "var(--pos)" }} aria-hidden />
                      <strong className="truncate font-semibold" style={{ color: "var(--text-1)" }}>
                        {entity.code}
                      </strong>
                      <span className="font-mono text-[10px]" style={{ color: "var(--text-3)" }}>
                        {entity.baseCurrency}
                      </span>
                    </span>
                    <span className="mt-0.5 block truncate text-[11px]" style={{ color: "var(--text-2)" }}>
                      {entity.name}
                    </span>
                    {entity.taxIdVkn && (
                      <span className="mt-0.5 block font-mono text-[10px]" style={{ color: "var(--text-3)" }}>
                        VKN: {entity.taxIdVkn}
                      </span>
                    )}
                  </span>
                  {selected && <Check size={14} strokeWidth={2} style={{ color: "var(--pos)" }} aria-hidden />}
                </button>
              </form>
            );
          })}

          <DropdownMenuSeparator />
          <Link
            href="/system/features"
            className="flex items-center gap-2 rounded-[var(--radius-sm)] px-2.5 py-1.5 text-[11.5px] font-medium transition-colors hover:bg-[var(--surface-hover)]"
            style={{ color: "var(--text-3)" }}
          >
            <Settings2 size={13} strokeWidth={1.75} aria-hidden />
            <span>Grup şirketleri ve şube ayarları</span>
          </Link>
        </DropdownMenuContent>
      </DropdownMenu>

      <span aria-hidden className="hidden h-3.5 w-px sm:inline-block" style={{ background: "var(--line)" }} />

      {/* 3. Branch selector (MERKEZ / Tüm Şubeler) */}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className="hidden items-center gap-1.5 rounded-[5px] px-2 py-1 text-[12px] font-medium tracking-[-0.005em] transition-colors hover:bg-[var(--surface-hover)] sm:inline-flex"
            style={
              scope.activeBranch
                ? {
                    background: "color-mix(in srgb, var(--warn) 10%, var(--surface-1))",
                    color: "var(--warn)",
                  }
                : { color: "var(--text-3)" }
            }
            aria-label="Şube veya tesis seçin"
          >
            <GitBranch size={13} strokeWidth={1.75} aria-hidden />
            <span>{scope.activeBranch ? scope.activeBranch.code : isConsolidated ? "Tüm Şubeler" : displayBranchCode}</span>
            <ChevronDown size={12} strokeWidth={1.75} className="opacity-70" aria-hidden />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-60 p-1.5">
          <DropdownMenuLabel>Şube / Tesis Kapsamı</DropdownMenuLabel>
          {primaryEntity && (
            <form action={switchActiveEntityAction}>
              <input
                type="hidden"
                name="legalEntityId"
                value={scope.activeEntity?.id ?? (isConsolidated ? "consolidated" : primaryEntity.id)}
              />
              <input type="hidden" name="branchId" value="" />
              <input type="hidden" name="returnTo" value={pathname} />
              <button
                type="submit"
                className="flex w-full items-center justify-between gap-2 rounded-[var(--radius-sm)] px-2.5 py-1.5 text-left text-[12px] transition-colors hover:bg-[var(--surface-hover)]"
              >
                <span className="font-medium" style={{ color: "var(--text-1)" }}>
                  Tüm Şubeler
                </span>
                {!scope.activeBranch && <Check size={13} strokeWidth={2} style={{ color: "var(--info)" }} aria-hidden />}
              </button>
            </form>
          )}
          {scope.branches.length > 0 && <DropdownMenuSeparator />}
          {scope.branches.map((branch) => {
            const selected = scope.activeBranch?.id === branch.id;
            return (
              <form key={branch.id} action={switchActiveEntityAction}>
                <input type="hidden" name="legalEntityId" value={branch.legalEntityId} />
                <input type="hidden" name="branchId" value={branch.id} />
                <input type="hidden" name="returnTo" value={pathname} />
                <button
                  type="submit"
                  className="flex w-full items-center justify-between gap-2 rounded-[var(--radius-sm)] px-2.5 py-1.5 text-left text-[12px] transition-colors hover:bg-[var(--surface-hover)]"
                >
                  <span className="min-w-0">
                    <strong className="block truncate font-semibold" style={{ color: "var(--text-1)" }}>
                      {branch.code} {branch.isHeadquarters ? "· Merkez" : ""}
                    </strong>
                    <span className="block truncate text-[11px]" style={{ color: "var(--text-3)" }}>
                      {branch.name}
                      {branch.city ? ` (${branch.city})` : ""}
                    </span>
                  </span>
                  {selected && <Check size={13} strokeWidth={2} style={{ color: "var(--warn)" }} aria-hidden />}
                </button>
              </form>
            );
          })}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
