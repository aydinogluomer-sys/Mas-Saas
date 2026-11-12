import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const revalidatePath = vi.fn();
  const redirect = vi.fn((url: string): never => {
    throw new Error(`REDIRECT:${url}`);
  });
  const requireActionPermission = vi.fn(async () => ({
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    username: "finans.muduru",
    displayName: "Finans Müdürü",
    role: "finance_manager" as const,
  }));
  const queries: Array<{ text: string; values?: unknown[] }> = [];
  const client = {
    query: vi.fn(async (text: string, values?: unknown[]) => {
      queries.push({ text, values });
      if (text.includes("insert into public.external_assumptions")) {
        return { rowCount: 1, rows: [{ id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" }] };
      }
      if (text.includes("select id, review_status, source_kind from public.external_assumptions")) {
        return {
          rowCount: 1,
          rows: [{ id: values?.[0], review_status: "pending_review", source_kind: "manual" }],
        };
      }
      if (text.includes("update public.external_assumptions")) {
        return { rowCount: 1, rows: [] };
      }
      if (text.includes("insert into public.audit_logs")) {
        return { rowCount: 1, rows: [{ id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" }] };
      }
      return { rowCount: 0, rows: [] };
    }),
    release: vi.fn(),
  };
  const pool = {
    connect: vi.fn(async () => client),
  };
  return { revalidatePath, redirect, requireActionPermission, queries, client, pool };
});

vi.mock("next/cache", () => ({
  revalidatePath: mocks.revalidatePath,
}));
vi.mock("next/navigation", () => ({
  redirect: mocks.redirect,
}));
vi.mock("@/lib/auth", () => ({
  requireActionPermission: mocks.requireActionPermission,
}));
vi.mock("@/lib/db", () => ({
  getPool: () => mocks.pool,
}));

import {
  createExternalAssumptionAction,
  setExternalAssumptionReviewStatusAction,
} from "@/app/(dashboard)/data/assumptions/actions";

function buildValidForm(overrides: Record<string, string | null> = {}): FormData {
  const fd = new FormData();
  const defaults: Record<string, string> = {
    assumptionType: "interest_rate",
    label: "TCMB politika faizi",
    valueNumeric: "45",
    unit: "yüzde",
    currency: "TRY",
    sourceKind: "manual",
    sourceName: "TCMB",
    sourceDate: "2026-11-01",
    notes: "PPK kararı",
  };
  for (const [k, v] of Object.entries(defaults)) {
    if (k in overrides) {
      const ov = overrides[k];
      if (ov !== null) fd.set(k, ov);
    } else {
      fd.set(k, v);
    }
  }
  for (const [k, v] of Object.entries(overrides)) {
    if (!(k in defaults) && v !== null) {
      fd.set(k, v);
    }
  }
  return fd;
}

describe("Bulgu #10 — dış varsayım server action doğrulaması (sessiz veri kaybı önleme)", () => {
  beforeEach(() => {
    mocks.revalidatePath.mockClear();
    mocks.redirect.mockClear();
    mocks.requireActionPermission.mockClear();
    mocks.pool.connect.mockClear();
    mocks.client.query.mockClear();
    mocks.client.release.mockClear();
    mocks.queries.length = 0;
  });

  it("valueNumeric boş, boşluk veya sayısal değilse ?error=assumption-fields-required ile yönlendirir; asla ?result=created dönmez", async () => {
    for (const badVal of [null, "", "   ", "NaN-degil"]) {
      const fd = buildValidForm({ valueNumeric: badVal });
      await expect(createExternalAssumptionAction(fd)).rejects.toThrow(
        "REDIRECT:/data/assumptions?error=assumption-fields-required",
      );
    }
    expect(mocks.pool.connect).not.toHaveBeenCalled();
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });

  it("unit, sourceDate, label veya sourceName eksik olduğunda motor null döner ve action ?error=assumption-fields-required ile yönlendirir", async () => {
    for (const missingField of ["unit", "sourceDate", "label", "sourceName"] as const) {
      for (const emptyVal of ["", "   ", null]) {
        const fd = buildValidForm({ [missingField]: emptyVal });
        await expect(createExternalAssumptionAction(fd)).rejects.toThrow(
          "REDIRECT:/data/assumptions?error=assumption-fields-required",
        );
      }
    }
    expect(mocks.pool.connect).not.toHaveBeenCalled();
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });

  it("internet kaynaklı kayıtta sourceUrl boşsa ?error=internet-source-url-required ile yönlendirir", async () => {
    const fd = buildValidForm({ sourceKind: "internet", sourceUrl: "" });
    await expect(createExternalAssumptionAction(fd)).rejects.toThrow(
      "REDIRECT:/data/assumptions?error=internet-source-url-required",
    );
    expect(mocks.pool.connect).not.toHaveBeenCalled();
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });

  it("tüm zorunlu alanlar geçerliyken kaydı oluşturur, yolları yeniler ve ?result=created ile yönlendirir", async () => {
    const fd = buildValidForm();
    await expect(createExternalAssumptionAction(fd)).rejects.toThrow(
      "REDIRECT:/data/assumptions?result=created",
    );
    expect(mocks.pool.connect).toHaveBeenCalledTimes(1);
    expect(mocks.queries.some((q) => q.text.includes("insert into public.external_assumptions"))).toBe(true);
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/data/assumptions");
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/data/quality");
  });

  it("setExternalAssumptionReviewStatusAction geçersiz id veya reviewStatus için ?error=assumption-review-invalid döner", async () => {
    const missingId = new FormData();
    missingId.set("id", "  ");
    missingId.set("reviewStatus", "approved");
    await expect(setExternalAssumptionReviewStatusAction(missingId)).rejects.toThrow(
      "REDIRECT:/data/assumptions?error=assumption-review-invalid",
    );

    const invalidStatus = new FormData();
    invalidStatus.set("id", "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
    invalidStatus.set("reviewStatus", "bilinmeyen_durum");
    await expect(setExternalAssumptionReviewStatusAction(invalidStatus)).rejects.toThrow(
      "REDIRECT:/data/assumptions?error=assumption-review-invalid",
    );

    expect(mocks.pool.connect).not.toHaveBeenCalled();
    expect(mocks.revalidatePath).not.toHaveBeenCalled();

    const validReview = new FormData();
    validReview.set("id", "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
    validReview.set("reviewStatus", "approved");
    await expect(setExternalAssumptionReviewStatusAction(validReview)).rejects.toThrow(
      "REDIRECT:/data/assumptions?result=reviewed",
    );
    expect(mocks.pool.connect).toHaveBeenCalledTimes(1);
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/data/assumptions");
  });
});
