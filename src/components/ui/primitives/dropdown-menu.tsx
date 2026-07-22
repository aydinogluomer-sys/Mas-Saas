"use client";

// Radix DropdownMenu, restyled to MAS dark tokens. Used to build the row ActionMenu.
// IMPORTANT: menu items that navigate must render a real <Link>/<a> (caught by the
// global instant-navigation click interceptor); mutations must submit a <form action={serverAction}>.
import * as DropdownMenuPrimitive from "@radix-ui/react-dropdown-menu";
import { cn } from "@/lib/utils";

// Inline check glyph — the project ships no icon library (all icons are inline SVG).
function CheckGlyph() {
  return (
    <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M3.5 8.5l3 3 6-7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export const DropdownMenu = DropdownMenuPrimitive.Root;
export const DropdownMenuTrigger = DropdownMenuPrimitive.Trigger;
export const DropdownMenuGroup = DropdownMenuPrimitive.Group;
export const DropdownMenuPortal = DropdownMenuPrimitive.Portal;

const panelStyle: React.CSSProperties = {
  background: "var(--surface-overlay)",
  border: "1px solid var(--line-strong)",
  borderRadius: "var(--radius-md)",
  boxShadow: "var(--shadow-overlay)",
  color: "var(--text-1)",
};

export function DropdownMenuContent({
  className,
  sideOffset = 4,
  align = "end",
  ...props
}: React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Content>) {
  return (
    <DropdownMenuPrimitive.Portal>
      <DropdownMenuPrimitive.Content
        sideOffset={sideOffset}
        align={align}
        className={cn("z-50 min-w-40 overflow-hidden p-1 text-sm data-[state=open]:animate-fade", className)}
        style={panelStyle}
        {...props}
      />
    </DropdownMenuPrimitive.Portal>
  );
}

export function DropdownMenuItem({
  className,
  inset,
  ...props
}: React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Item> & { inset?: boolean }) {
  return (
    <DropdownMenuPrimitive.Item
      className={cn(
        "relative flex w-full cursor-pointer select-none items-center gap-2 rounded-[var(--radius-sm)] px-2 py-1.5 outline-none",
        "focus:bg-[var(--surface-hover)] data-[highlighted]:bg-[var(--surface-hover)]",
        "data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
        inset && "pl-7",
        className,
      )}
      {...props}
    />
  );
}

export function DropdownMenuCheckboxItem({
  className,
  children,
  checked,
  ...props
}: React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.CheckboxItem>) {
  return (
    <DropdownMenuPrimitive.CheckboxItem
      checked={checked}
      className={cn(
        "relative flex w-full cursor-pointer select-none items-center gap-2 rounded-[var(--radius-sm)] py-1.5 pl-7 pr-2 outline-none",
        "focus:bg-[var(--surface-hover)] data-[highlighted]:bg-[var(--surface-hover)]",
        "data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
        className,
      )}
      {...props}
    >
      <span className="absolute left-2 flex h-3.5 w-3.5 items-center justify-center">
        <DropdownMenuPrimitive.ItemIndicator>
          <CheckGlyph />
        </DropdownMenuPrimitive.ItemIndicator>
      </span>
      {children}
    </DropdownMenuPrimitive.CheckboxItem>
  );
}

export function DropdownMenuLabel({
  className,
  ...props
}: React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Label>) {
  return (
    <DropdownMenuPrimitive.Label
      className={cn("px-2 py-1.5 font-mono text-[10px] uppercase tracking-wider text-tone-3", className)}
      {...props}
    />
  );
}

export function DropdownMenuSeparator({
  className,
  ...props
}: React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Separator>) {
  return <DropdownMenuPrimitive.Separator className={cn("my-1 h-px bg-[var(--line)]", className)} {...props} />;
}

/** Row action menu: a "⋯" trigger + a menu panel. Children are DropdownMenuItem entries —
 *  navigations must be real <Link>, mutations a <form action={serverAction}> submit button. */
export function ActionMenu({ label = "İşlemler", children }: { label?: string; children: React.ReactNode }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger className="button-ghost px-2 py-1" aria-label={label} title={label}>
        <span aria-hidden>⋯</span>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">{children}</DropdownMenuContent>
    </DropdownMenu>
  );
}
