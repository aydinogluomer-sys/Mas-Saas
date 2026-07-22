// Server-compatible (no "use client") styled button over the existing global
// .button-* chrome, with cva variants. Usable in both server pages and client islands
// with zero client-JS cost when rendered on the server.
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const button = cva("inline-flex items-center justify-center gap-1", {
  variants: {
    variant: { accent: "button-accent", ghost: "button-ghost", primary: "button-primary" },
    size: { sm: "px-2 py-1", md: "px-3 py-2" },
  },
  defaultVariants: { variant: "ghost", size: "sm" },
});

export type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & VariantProps<typeof button>;

export function Button({ className, variant, size, type = "button", ...props }: ButtonProps) {
  return <button type={type} className={cn(button({ variant, size }), className)} {...props} />;
}

export { button as buttonVariants };
