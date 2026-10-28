import { describe, expect, it, vi, beforeEach } from "vitest";

vi.hoisted(() => {
  process.env.DATABASE_URL = "postgres://postgres:postgres@localhost:5432/mas_radar_test";
});

import { changeOwnPassword, forcePasswordChange, resetUserPassword } from "./engine";
import { hashPassword } from "@/lib/auth";

describe("Password Rotation and must_change_password enforcement", () => {
  let mockClient: any;
  let mockPool: any;

  beforeEach(() => {
    mockClient = {
      query: vi.fn(),
      release: vi.fn(),
    };
    mockPool = {
      connect: vi.fn().mockResolvedValue(mockClient),
    };
  });

  describe("forcePasswordChange", () => {
    it("sets must_change_password = true and records audit event", async () => {
      mockPool.connect = vi.fn().mockResolvedValue(mockClient);
      mockClient.query
        .mockResolvedValueOnce({}) // begin
        .mockResolvedValueOnce({ rowCount: 1, rows: [{ username: "testuser" }] }) // assertNotReserved
        .mockResolvedValueOnce({ rowCount: 1, rows: [{ username: "testuser", display_name: "Test", role: "operator", is_active: true }] }) // loadForAudit
        .mockResolvedValueOnce({ rowCount: 1 }) // update must_change_password = true
        .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: "audit-1" }] }) // audit log
        .mockResolvedValueOnce({}); // commit

      await forcePasswordChange(mockPool, "user-uuid-1", "admin-uuid");

      expect(mockClient.query).toHaveBeenCalledWith(
        expect.stringContaining("update public.users set must_change_password=true where id=$1"),
        ["user-uuid-1"],
      );
    });
  });

  describe("changeOwnPassword", () => {
    it("rejects password shorter than 12 characters", async () => {
      await expect(
        changeOwnPassword(mockPool, "user-uuid-1", "OldPass123456!", "Short1!"),
      ).rejects.toThrow("Parola en az 12 karakter olmalı.");
    });

    it("rejects password if same as username", async () => {
      mockPool.connect = vi.fn().mockResolvedValue(mockClient);
      const oldHash = await hashPassword("OldPass123456!");
      mockClient.query
        .mockResolvedValueOnce({}) // begin
        .mockResolvedValueOnce({
          rowCount: 1,
          rows: [{ id: "user-uuid-1", username: "validuser", password_hash: oldHash }],
        });

      await expect(
        changeOwnPassword(mockPool, "user-uuid-1", "OldPass123456!", "validuser"),
      ).rejects.toThrow();
    });

    it("rejects password if old password does not match", async () => {
      mockPool.connect = vi.fn().mockResolvedValue(mockClient);
      const realOldHash = await hashPassword("RealOldPassword123!");
      mockClient.query
        .mockResolvedValueOnce({}) // begin
        .mockResolvedValueOnce({
          rowCount: 1,
          rows: [{ id: "user-uuid-1", username: "johndoe", password_hash: realOldHash }],
        });

      await expect(
        changeOwnPassword(mockPool, "user-uuid-1", "WrongOldPassword123!", "NewSecretPassword2026!"),
      ).rejects.toThrow("Mevcut parola hatalı.");
    });

    it("rejects password if new password equals old password", async () => {
      mockPool.connect = vi.fn().mockResolvedValue(mockClient);
      const realOldHash = await hashPassword("SameOldPassword123!");
      mockClient.query
        .mockResolvedValueOnce({}) // begin
        .mockResolvedValueOnce({
          rowCount: 1,
          rows: [{ id: "user-uuid-1", username: "johndoe", password_hash: realOldHash }],
        });

      await expect(
        changeOwnPassword(mockPool, "user-uuid-1", "SameOldPassword123!", "SameOldPassword123!"),
      ).rejects.toThrow("Yeni parola eski parolayla aynı olamaz.");
    });

    it("successfully changes password, sets must_change_password=false, and audits", async () => {
      mockPool.connect = vi.fn().mockResolvedValue(mockClient);
      const realOldHash = await hashPassword("ValidOldPassword123!");
      mockClient.query
        .mockResolvedValueOnce({}) // begin
        .mockResolvedValueOnce({
          rowCount: 1,
          rows: [{ id: "user-uuid-1", username: "johndoe", password_hash: realOldHash }],
        })
        .mockResolvedValueOnce({ rowCount: 1 }) // update
        .mockResolvedValueOnce({
          rowCount: 1,
          rows: [{ username: "johndoe", display_name: "John", role: "operator", is_active: true }],
        }) // loadForAudit
        .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: "audit-2" }] }) // audit
        .mockResolvedValueOnce({}); // commit

      await changeOwnPassword(mockPool, "user-uuid-1", "ValidOldPassword123!", "BrandNewSecurePass2026!");

      expect(mockClient.query).toHaveBeenCalledWith(
        expect.stringContaining("set password_hash = $2, must_change_password = false"),
        expect.arrayContaining(["user-uuid-1"]),
      );
    });
  });

  describe("resetUserPassword", () => {
    it("sets must_change_password to true on reset by default", async () => {
      mockPool.connect = vi.fn().mockResolvedValue(mockClient);
      mockClient.query
        .mockResolvedValueOnce({}) // begin
        .mockResolvedValueOnce({ rowCount: 1, rows: [{ username: "alice" }] }) // assertNotReserved
        .mockResolvedValueOnce({
          rowCount: 1,
          rows: [{ username: "alice", display_name: "Alice", role: "operator", is_active: true }],
        }) // loadForAudit
        .mockResolvedValueOnce({ rowCount: 1 }) // update
        .mockResolvedValueOnce({ rowCount: 2 }) // revoked sessions
        .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: "audit-3" }] }) // audit
        .mockResolvedValueOnce({}); // commit

      await resetUserPassword(mockPool, "user-uuid-2", "NewAdminGeneratedPassword123!", "admin-actor-id");

      expect(mockClient.query).toHaveBeenCalledWith(
        expect.stringContaining("update public.users set password_hash=$2, must_change_password=$3"),
        expect.arrayContaining(["user-uuid-2", true]),
      );
    });
  });
});
