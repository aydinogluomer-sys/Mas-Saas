"use client";

import type { ButtonHTMLAttributes, ReactNode } from "react";
import { useFormStatus } from "react-dom";

export interface SubmitButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  pendingLabel?: ReactNode;
  pendingText?: ReactNode;
  children: ReactNode;
}

/**
 * Merkezi sunucu formu gönderim düğmesi (F-64):
 * `useFormStatus()` ile form gönderimi sürerken düğmeyi otomatik kilitler (`disabled`),
 * çift tıklamayla mükerrer kayıt/ödeme oluşmasını önler ve `aria-busy` durumunu yayınlar.
 */
export function SubmitButton({
  pendingLabel,
  pendingText,
  disabled,
  children,
  type = "submit",
  ...rest
}: SubmitButtonProps) {
  const { pending } = useFormStatus();
  const isDisabled = Boolean(disabled || pending);

  return (
    <button
      {...rest}
      type={type}
      disabled={isDisabled}
      aria-busy={pending || undefined}
      data-submitting={pending ? "true" : undefined}
    >
      {pending ? (pendingLabel ?? pendingText ?? "İşleniyor…") : children}
    </button>
  );
}

