"use client";

// Radix Tooltip, restyled to MAS dark tokens. Presentation-only.
import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import { cn } from "@/lib/utils";

export const TooltipProvider = TooltipPrimitive.Provider;
export const Tooltip = TooltipPrimitive.Root;
export const TooltipTrigger = TooltipPrimitive.Trigger;

export function TooltipContent({
  className,
  sideOffset = 6,
  children,
  ...props
}: React.ComponentPropsWithoutRef<typeof TooltipPrimitive.Content>) {
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Content
        sideOffset={sideOffset}
        className={cn(
          "z-50 max-w-xs px-2 py-1 text-xs leading-snug",
          "data-[state=delayed-open]:animate-fade",
          className,
        )}
        style={{
          background: "var(--surface-overlay)",
          border: "1px solid var(--line-strong)",
          borderRadius: "var(--radius-md)",
          color: "var(--text-1)",
          boxShadow: "var(--shadow-overlay)",
        }}
        {...props}
      >
        {children}
      </TooltipPrimitive.Content>
    </TooltipPrimitive.Portal>
  );
}
