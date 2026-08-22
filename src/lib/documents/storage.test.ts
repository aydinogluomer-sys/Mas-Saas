import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  DocumentIntegrityError, readStored, sha256, storagePathFor, storeFile, verifyStored,
} from "./storage";

let root: string;
const original = process.env.MAS_DOCUMENT_ROOT;

beforeAll(() => {
  root = mkdtempSync(path.join(tmpdir(), "mas-docs-"));
  process.env.MAS_DOCUMENT_ROOT = root;
});
afterAll(() => {
  if (original == null) delete process.env.MAS_DOCUMENT_ROOT;
  else process.env.MAS_DOCUMENT_ROOT = original;
  rmSync(root, { recursive: true, force: true });
});

describe("storagePathFor", () => {
  it("fans out by the first two byte pairs", () => {
    const hash = "a".repeat(64);
    expect(storagePathFor(hash)).toBe(path.join("aa", "aa", hash));
  });

  it("REFUSES anything that is not a sha256", () => {
    // The path contains no user text by construction; this makes that structural rather than
    // a convention someone could break later.
    expect(() => storagePathFor("../../etc/passwd")).toThrow();
    expect(() => storagePathFor("")).toThrow();
    expect(() => storagePathFor("A".repeat(64))).toThrow(); // uppercase is not our format
  });
});

describe("storeFile", () => {
  it("returns the hash, relative path and size", () => {
    const bytes = Buffer.from("merhaba dünya");
    const stored = storeFile(bytes);
    expect(stored.sha256).toBe(sha256(bytes));
    expect(stored.byteSize).toBe(bytes.byteLength);
    expect(stored.storagePath).toContain(stored.sha256);
  });

  it("is content-addressed: identical bytes store once", () => {
    const a = storeFile(Buffer.from("aynı içerik"));
    const b = storeFile(Buffer.from("aynı içerik"));
    expect(a.storagePath).toBe(b.storagePath);
    expect(a.sha256).toBe(b.sha256);
  });

  it("different bytes land in different places", () => {
    const a = storeFile(Buffer.from("bir"));
    const b = storeFile(Buffer.from("iki"));
    expect(a.storagePath).not.toBe(b.storagePath);
  });

  it("handles empty content without inventing a size", () => {
    const stored = storeFile(Buffer.alloc(0));
    expect(stored.byteSize).toBe(0);
  });
});

describe("readStored", () => {
  it("returns the original bytes", () => {
    const bytes = Buffer.from("fatura içeriği");
    const stored = storeFile(bytes);
    expect(readStored(stored.storagePath, stored.sha256).equals(bytes)).toBe(true);
  });

  it("REFUSES to serve bytes whose hash does not match", () => {
    // A document centre that serves silently-corrupted files is worse than one that is down:
    // the corruption gets filed, mailed and relied upon.
    const stored = storeFile(Buffer.from("orijinal"));
    expect(() => readStored(stored.storagePath, "b".repeat(64)))
      .toThrow(DocumentIntegrityError);
  });

  it("reports a missing file rather than returning empty bytes", () => {
    expect(() => readStored(path.join("00", "11", "0".repeat(64)), "0".repeat(64)))
      .toThrow(DocumentIntegrityError);
  });
});

describe("verifyStored", () => {
  it("passes for an intact file", () => {
    const bytes = Buffer.from("sağlam dosya");
    const stored = storeFile(bytes);
    const report = verifyStored(stored.storagePath, stored.sha256, stored.byteSize);
    expect(report).toEqual({
      storagePath: stored.storagePath, present: true, sizeMatches: true, hashMatches: true,
    });
  });

  it("detects a missing file", () => {
    const report = verifyStored(path.join("aa", "bb", "c".repeat(64)), "c".repeat(64), 10);
    expect(report.present).toBe(false);
    expect(report.hashMatches).toBeNull();
  });

  it("detects a size mismatch without reading the whole file", () => {
    const stored = storeFile(Buffer.from("on iki bayt"));
    const report = verifyStored(stored.storagePath, stored.sha256, stored.byteSize + 999);
    expect(report.sizeMatches).toBe(false);
    expect(report.hashMatches).toBeNull();
  });

  it("detects corruption when the size still matches", () => {
    // The failure mode that actually matters: same length, different content.
    const bytes = Buffer.from("1234567890");
    const stored = storeFile(bytes);
    const absolute = path.join(root, stored.storagePath);
    mkdirSync(path.dirname(absolute), { recursive: true });
    writeFileSync(absolute, Buffer.from("0987654321"));
    const report = verifyStored(stored.storagePath, stored.sha256, stored.byteSize);
    expect(report.present).toBe(true);
    expect(report.sizeMatches).toBe(true);
    expect(report.hashMatches).toBe(false);
  });
});
