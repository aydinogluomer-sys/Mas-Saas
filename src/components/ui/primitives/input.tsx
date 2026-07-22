// Server-compatible styled input/select over the existing .field-control chrome.
// No "use client" — zero client-JS cost when rendered on the server.
import { cn } from "@/lib/utils";

export function Input({ className, ...props }: React.InputHTMLAttributes<HTMLInputElement>) {
  return <input className={cn("field-control px-2 py-1 text-sm", className)} {...props} />;
}

export function Select({ className, children, ...props }: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select className={cn("field-control px-2 py-1 text-sm", className)} {...props}>
      {children}
    </select>
  );
}

export function Skeleton({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("skeleton-block", className)} {...props} />;
}
