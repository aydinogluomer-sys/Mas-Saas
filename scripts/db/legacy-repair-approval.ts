// P0-B Slice 5 — produces an approval manifest from an immutable inventory manifest,
// driven ENTIRELY by explicit CLI arguments. Never edited by hand: every reason and
// every timestamp confirmation must be typed by the operator on this exact invocation —
// nothing is silently copied from the inventory's own (merely advisory) proposals.
// This script never touches the database.
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  ApprovalManifestSchema,
  CANONICALIZATION_VERSION,
  InventoryManifestSchema,
  fileSha256,
  payloadSha256,
  sortApprovalsDeterministically,
  writeExclusiveDurable,
  type ApprovalEntry,
  type InventoryTarget,
} from "./legacy-repair-types";

interface Args {
  inventory: string;
  expectedInventorySha256: string;
  approveArchiveInstances: string[];
  confirmArchiveReason?: string;
  confirmArchiveTimestampPolicy?: string;
  approveMetadataInstance?: string;
  metadataReason?: string;
  confirmTimestamp?: string;
  out: string;
}

function parseArgs(argv: string[]): Args {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i === -1 ? undefined : argv[i + 1];
  };
  const getAll = (flag: string): string[] => {
    const out: string[] = [];
    for (let i = 0; i < argv.length; i++) if (argv[i] === flag) out.push(argv[i + 1]);
    return out;
  };
  const inventory = get("--inventory");
  const expectedInventorySha256 = get("--expected-inventory-sha256");
  const out = get("--out");
  if (!inventory) throw new Error("--inventory zorunlu.");
  if (!expectedInventorySha256) throw new Error("--expected-inventory-sha256 zorunlu.");
  if (!out) throw new Error("--out zorunlu.");
  return {
    inventory,
    expectedInventorySha256,
    approveArchiveInstances: getAll("--approve-archive-instance"),
    confirmArchiveReason: get("--confirm-archive-reason"),
    confirmArchiveTimestampPolicy: get("--confirm-archive-timestamp-policy"),
    approveMetadataInstance: get("--approve-metadata-instance"),
    metadataReason: get("--reason"),
    confirmTimestamp: get("--confirm-timestamp"),
    out,
  };
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));

  const inventoryBytes = readFileSync(args.inventory);
  const realInventoryFileSha256 = fileSha256(inventoryBytes);
  if (realInventoryFileSha256 !== args.expectedInventorySha256) {
    fail(
      `Inventory dosyasının gerçek byte SHA-256'sı ('${realInventoryFileSha256}') --expected-inventory-sha256 ('${args.expectedInventorySha256}') ile eşleşmiyor. Çıkış.`,
    );
  }

  const inventoryJson = JSON.parse(inventoryBytes.toString("utf8"));
  const inventoryParsed = InventoryManifestSchema.safeParse(inventoryJson);
  if (!inventoryParsed.success) {
    fail(`Inventory dosyası strict şemadan geçemedi:\n${inventoryParsed.error.message}`);
  }
  const inventory = inventoryParsed.data;

  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- deliberately stripped before hashing
  const { generatedAt: _generatedAt, inventoryPayloadSha256: _hash, durability: _durability, ...rest } = inventory;
  const recomputed = payloadSha256(rest);
  if (recomputed !== inventory.inventoryPayloadSha256) {
    fail(
      `Inventory dosyasının iç inventoryPayloadSha256'sı tutarsız (dosya elle değiştirilmiş olabilir) — beklenen ${inventory.inventoryPayloadSha256}, yeniden hesaplanan ${recomputed}. Çıkış.`,
    );
  }

  const targetByKey = new Map<string, InventoryTarget>();
  for (const t of inventory.targets) targetByKey.set(`${t.instanceId}|${t.kind}`, t);

  const unresolvedMetadataTargets = inventory.targets.filter(
    (t) => t.kind === "cancellation_metadata_repair" && t.classification === "unresolved",
  );
  if (unresolvedMetadataTargets.length > 1 && args.approveMetadataInstance) {
    fail(
      `Inventory'de birden fazla (${unresolvedMetadataTargets.length}) unresolved metadata hedefi var — düz CLI bayrakları UUID-reason eşleşmesini belirsizleştirir. Bu araç bu durumda flat-bayrak modunu reddeder (yapılandırılmış --targets-file girdisi gerekir, bu Slice'ta yazılmadı).`,
    );
  }

  const approvals: ApprovalEntry[] = [];
  const approvedIds = new Set<string>();

  if (args.approveArchiveInstances.length > 0) {
    if (!args.confirmArchiveReason || args.confirmArchiveReason.trim() === "") {
      fail("--approve-archive-instance verildiğinde --confirm-archive-reason zorunlu ve boş olamaz.");
    }
    if (args.confirmArchiveTimestampPolicy !== "apply_transaction_timestamp") {
      fail("--approve-archive-instance verildiğinde --confirm-archive-timestamp-policy tam olarak 'apply_transaction_timestamp' olmalı.");
    }
    const reason = args.confirmArchiveReason.trim();
    for (const instanceId of args.approveArchiveInstances) {
      if (approvedIds.has(instanceId)) fail(`Aynı UUID iki kez onaylanamaz: ${instanceId}`);
      const target = targetByKey.get(`${instanceId}|archive_cascade_repair`);
      if (!target) fail(`UUID inventory'de archive_cascade_repair hedefi olarak bulunamadı: ${instanceId}`);
      if (target.classification !== "candidate") {
        fail(`UUID '${instanceId}' classification='${target.classification}' — yalnız 'candidate' hedefler archive onayı alabilir.`);
      }
      approvedIds.add(instanceId);
      approvals.push({
        instanceId,
        kind: "archive_cascade_repair",
        approvedCancelledAt: null,
        approvedCancelReason: reason,
        reasonSource: "user_supplied",
      });
    }
  }

  if (args.approveMetadataInstance) {
    const instanceId = args.approveMetadataInstance;
    if (approvedIds.has(instanceId)) fail(`Aynı UUID iki kez onaylanamaz: ${instanceId}`);
    if (!args.metadataReason || args.metadataReason.trim() === "") {
      fail("--approve-metadata-instance verildiğinde --reason zorunlu ve boş olamaz.");
    }
    if (!args.confirmTimestamp) {
      fail("--approve-metadata-instance verildiğinde --confirm-timestamp zorunlu.");
    }
    const target = targetByKey.get(`${instanceId}|cancellation_metadata_repair`);
    if (!target) fail(`UUID inventory'de cancellation_metadata_repair hedefi olarak bulunamadı: ${instanceId}`);
    if (target.classification !== "unresolved") {
      fail(`UUID '${instanceId}' classification='${target.classification}' — yalnız 'unresolved' hedefler metadata onayı alabilir.`);
    }
    if (args.confirmTimestamp !== target.proposedCancelledAt) {
      fail(
        `--confirm-timestamp ('${args.confirmTimestamp}') inventory'nin proposedCancelledAt'iyle ('${target.proposedCancelledAt}') birebir eşleşmiyor.`,
      );
    }
    approvedIds.add(instanceId);
    approvals.push({
      instanceId,
      kind: "cancellation_metadata_repair",
      approvedCancelledAt: args.confirmTimestamp,
      approvedCancelReason: args.metadataReason.trim(),
      reasonSource: "user_supplied",
    });
  }

  if (approvals.length === 0) {
    fail("Sıfır onaylı hedefle approval manifest üretilmez. En az bir --approve-archive-instance veya --approve-metadata-instance verin.");
  }

  const sortedApprovals = sortApprovalsDeterministically(approvals);
  const hasArchiveApproval = sortedApprovals.some((a) => a.kind === "archive_cascade_repair");

  // canonicalizationVersion is part of the semantic payload hash scope; durability is
  // transport/file-write metadata, deliberately excluded — same policy as inventory's
  // inventoryPayloadSha256, see legacy-repair-inventory.ts's matching comment.
  const manifestWithoutHash = {
    canonicalizationVersion: CANONICALIZATION_VERSION,
    inventoryFileSha256: realInventoryFileSha256,
    approvals: sortedApprovals,
    archiveCascadePolicy: hasArchiveApproval ? { cancelledAtPolicy: "apply_transaction_timestamp" as const } : null,
  };
  const approvalPayloadSha256 = payloadSha256(manifestWithoutHash);

  const manifestWithoutDurability = {
    approvedAt: new Date().toISOString(),
    ...manifestWithoutHash,
    approvalPayloadSha256,
  };

  const confirmedDurability = writeExclusiveDurable(
    args.out,
    (durability) => {
      const manifest = { ...manifestWithoutDurability, durability };
      const parsed = ApprovalManifestSchema.safeParse(manifest);
      if (!parsed.success) {
        throw new Error(`Üretilen approval manifest kendi şemasından geçemedi (programlama hatası): ${parsed.error.message}`);
      }
      return JSON.stringify(parsed.data, null, 2);
    },
    (text) => {
      const parsed = ApprovalManifestSchema.safeParse(JSON.parse(text));
      if (!parsed.success) throw new Error(`approval manifest kendi şemasından geçemedi: ${parsed.error.message}`);
    },
  );

  const finalBytes = readFileSync(args.out);
  const sha256 = fileSha256(finalBytes);

  console.log(`Approval manifest yazıldı: ${path.resolve(args.out)}`);
  console.log(`  bytes: ${finalBytes.length}`);
  console.log(`  fileSha256: ${sha256}`);
  console.log(`  approvalPayloadSha256: ${approvalPayloadSha256}`);
  console.log(`  durability: ${JSON.stringify(confirmedDurability)}`);
  console.log(`  onaylı hedef sayısı: ${sortedApprovals.length}`);
}

main();
