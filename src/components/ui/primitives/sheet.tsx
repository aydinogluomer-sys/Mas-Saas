"use client";

// Right-side sheet built on Radix Dialog, restyled to MAS dark tokens.
// Gains focus-trap, scroll-lock, Esc/backdrop close and full a11y wiring over the
// previous bespoke drawer. Presentation only.
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { cn } from "@/lib/utils";

export const Sheet = DialogPrimitive.Root;
export const SheetTrigger = DialogPrimitive.Trigger;
export const SheetClose = DialogPrimitive.Close;
export const SheetTitle = DialogPrimitive.Title;
export const SheetDescription = DialogPrimitive.Description;

export function SheetContent({
  className,
  children,
  ...props
}: React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content>) {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay
        className="fixed inset-0 z-40 data-[state=open]:animate-fade"
        style={{ background: "var(--scrim)" }}
      />
      <DialogPrimitive.Content
        className={cn(
          "fixed right-0 top-0 z-50 flex h-full w-[min(560px,92vw)] flex-col overflow-y-auto p-5",
          "outline-none data-[state=open]:animate-fade",
          className,
        )}
        style={{
          background: "var(--surface-1)",
          borderLeft: "1px solid var(--line-strong)",
          boxShadow: "var(--shadow-overlay)",
        }}
        {...props}
      >
        {children}
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}
