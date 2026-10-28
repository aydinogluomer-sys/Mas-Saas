"use client";

import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Panel } from "@/components/ui/panel";
import { getAgentScriptSnippet, getSampleErpPayload } from "@/lib/erp/bridge";
import type { ErpVendor, ErpVendorStatus } from "@/lib/erp/types";

interface Props {
  initialVendors: ErpVendorStatus[];
  recentLogs: Array<{
    id: string;
    vendor: string;
    action: string;
    imported: number;
    skipped: number;
    createdAt: string;
  }>;
}

export function ErpBridgeHub({ initialVendors, recentLogs }: Props) {
  const [selectedVendor, setSelectedVendor] = useState<ErpVendor>("logo");
  const [isRunningTest, setIsRunningTest] = useState(false);
  const [testResult, setTestResult] = useState<{
    ok: boolean;
    imported: number;
    skipped: number;
    error?: string;
  } | null>(null);
  const [copiedKey, setCopiedKey] = useState(false);
  const [copiedUrl, setCopiedUrl] = useState(false);
  const [activeScriptTab, setActiveScriptTab] = useState<"powershell" | "python">("powershell");

  const apiKey = "erp_mas_default_live_key_2026";
  const webhookUrl =
    typeof window !== "undefined"
      ? `${window.location.origin}/api/erp/webhook`
      : "http://localhost:3000/api/erp/webhook";

  const activeVendorConfig =
    initialVendors.find((v) => v.vendor === selectedVendor) ?? initialVendors[0];
  const samplePayload = getSampleErpPayload(selectedVendor);
  const scripts = getAgentScriptSnippet(webhookUrl.replace(/\/api\/erp\/webhook$/, ""), apiKey);

  const handleCopyKey = () => {
    navigator.clipboard.writeText(apiKey);
    setCopiedKey(true);
    setTimeout(() => setCopiedKey(false), 2000);
  };

  const handleCopyUrl = () => {
    navigator.clipboard.writeText(webhookUrl);
    setCopiedUrl(true);
    setTimeout(() => setCopiedUrl(false), 2000);
  };

  const handleTriggerTest = async () => {
    setIsRunningTest(true);
    setTestResult(null);
    try {
      const res = await fetch("/api/erp/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ vendor: selectedVendor, sample: true }),
      });
      const data = await res.json();
      if (data.ok && data.result) {
        setTestResult({
          ok: true,
          imported: data.result.imported ?? 0,
          skipped: data.result.skipped ?? 0,
        });
      } else {
        setTestResult({
          ok: false,
          imported: 0,
          skipped: 0,
          error: data.error || "Aktarım başarısız oldu",
        });
      }
    } catch (e) {
      setTestResult({
        ok: false,
        imported: 0,
        skipped: 0,
        error: (e as Error).message,
      });
    } finally {
      setIsRunningTest(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* Vendor Cards Grid */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {initialVendors.map((v) => {
          const isSelected = selectedVendor === v.vendor;
          return (
            <div
              key={v.vendor}
              onClick={() => {
                setSelectedVendor(v.vendor);
                setTestResult(null);
              }}
              className={`cursor-pointer rounded-xl border p-4 transition-all duration-150 ${
                isSelected
                  ? "border-sky-500 bg-sky-500/10 shadow-lg shadow-sky-500/5 ring-1 ring-sky-500/30"
                  : "border-line bg-surface hover:border-line-strong hover:bg-surface-elevated"
              }`}
            >
              <div className="flex items-start justify-between">
                <div>
                  <div className="flex items-center gap-2">
                    <span className="font-semibold text-tone-1">{v.name}</span>
                  </div>
                  <div className="mt-1 text-xs text-tone-3">{v.description}</div>
                </div>
                <Badge tone={v.status === "connected" ? "green" : "neutral"}>
                  {v.status === "connected" ? "Bağlı" : "Hazır"}
                </Badge>
              </div>

              <div className="mt-3 flex items-center justify-between border-t border-line-faint pt-2 text-[11px] text-tone-2">
                <span>Aktarılan: <strong className="text-tone-1">{v.totalImportedInvoices} fatura</strong></span>
                <span>{v.lastSyncAt ? `Son: ${v.lastSyncAt}` : "Henüz veri yok"}</span>
              </div>
            </div>
          );
        })}
      </div>

      {/* Integration Control Center */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        {/* Left: Webhook & Local Agent Credentials */}
        <Panel
          title="Otomasyon & Webhook Bağlantı Bilgileri"
          subtitle="Muhasebe yazılımınız veya yerel SQL aktarım ajanı bu adrese veri iletir."
        >
          <div className="space-y-4 text-xs">
            <div>
              <label className="mb-1 block font-medium text-tone-2">Canlı Webhook Endpoint (POST)</label>
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  readOnly
                  value={webhookUrl}
                  className="flex-1 rounded-md border border-line bg-surface-muted px-3 py-2 font-mono text-xs text-tone-1 focus:outline-none"
                />
                <button
                  onClick={handleCopyUrl}
                  className="rounded-md border border-line bg-surface px-3 py-2 font-medium text-tone-1 hover:bg-surface-elevated transition-colors"
                >
                  {copiedUrl ? "Kopyalandı!" : "Kopyala"}
                </button>
              </div>
            </div>

            <div>
              <label className="mb-1 block font-medium text-tone-2">X-ERP-API-Key (Kimlik Doğrulama)</label>
              <div className="flex items-center gap-2">
                <input
                  type="password"
                  readOnly
                  value={apiKey}
                  className="flex-1 rounded-md border border-line bg-surface-muted px-3 py-2 font-mono text-xs text-tone-1 focus:outline-none"
                />
                <button
                  onClick={handleCopyKey}
                  className="rounded-md border border-line bg-surface px-3 py-2 font-medium text-tone-1 hover:bg-surface-elevated transition-colors"
                >
                  {copiedKey ? "Kopyalandı!" : "Kopyala"}
                </button>
              </div>
              <p className="mt-1 text-[11px] text-tone-3">
                İstek başlığına <code className="text-sky-400">X-ERP-API-Key: {apiKey.slice(0, 12)}...</code> veya <code className="text-sky-400">Authorization: Bearer ...</code> ekleyiniz.
              </p>
            </div>

            <div className="rounded-lg border border-line-faint bg-surface-muted p-3">
              <div className="flex items-center justify-between pb-2 border-b border-line-faint">
                <span className="font-semibold text-tone-1">Yerel Ajan Scripti (Zamanlanmış Görev)</span>
                <div className="flex gap-1">
                  <button
                    onClick={() => setActiveScriptTab("powershell")}
                    className={`px-2 py-1 rounded text-[11px] font-medium transition-colors ${
                      activeScriptTab === "powershell"
                        ? "bg-sky-500/20 text-sky-400 font-bold"
                        : "text-tone-3 hover:text-tone-1"
                    }`}
                  >
                    PowerShell (Windows)
                  </button>
                  <button
                    onClick={() => setActiveScriptTab("python")}
                    className={`px-2 py-1 rounded text-[11px] font-medium transition-colors ${
                      activeScriptTab === "python"
                        ? "bg-sky-500/20 text-sky-400 font-bold"
                        : "text-tone-3 hover:text-tone-1"
                    }`}
                  >
                    Python (Çapraz Platform)
                  </button>
                </div>
              </div>
              <pre className="mt-2 max-h-[140px] overflow-auto font-mono text-[10px] text-tone-2 leading-relaxed">
                {activeScriptTab === "powershell" ? scripts.powershell : scripts.python}
              </pre>
            </div>
          </div>
        </Panel>

        {/* Right: Interactive Live Test / Sandbox */}
        <Panel
          title={`${activeVendorConfig.name} — Test & Canlı Aktarım`}
          subtitle="Aşağıdaki örnek ERP yükünü tek tıkla doğrudan MAS SaaS veritabanına aktarın."
        >
          <div className="space-y-3 text-xs">
            <div className="flex items-center justify-between">
              <span className="font-medium text-tone-2">Örnek Fatura Verisi (JSON Payı)</span>
              <Badge tone="blue">{samplePayload.data.length} kayıt hazır</Badge>
            </div>

            <pre className="max-h-[180px] overflow-auto rounded-md border border-line bg-surface-muted p-3 font-mono text-[11px] text-tone-1">
              {JSON.stringify(samplePayload.data, null, 2)}
            </pre>

            <div className="flex items-center justify-between pt-2">
              <div className="text-[11px] text-tone-3">
                Çift aktarım koruması (deduplication) aktiftir; mükerrer satırlar otomatik atlanır.
              </div>
              <button
                disabled={isRunningTest}
                onClick={handleTriggerTest}
                className="inline-flex items-center gap-2 rounded-lg bg-sky-600 px-4 py-2 font-medium text-white hover:bg-sky-500 disabled:opacity-50 transition-colors shadow-sm"
              >
                {isRunningTest ? (
                  <>
                    <span className="inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-white border-t-transparent" />
                    İşleniyor...
                  </>
                ) : (
                  <>
                    <span>⚡</span>
                    Sisteme Aktar (Test Eşitleme)
                  </>
                )}
              </button>
            </div>

            {testResult && (
              <div
                className={`mt-3 rounded-lg border p-3 text-xs ${
                  testResult.ok
                    ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-300"
                    : "border-rose-500/30 bg-rose-500/10 text-rose-300"
                }`}
              >
                {testResult.ok ? (
                  <div className="flex items-center justify-between">
                    <div>
                      <strong>Başarılı!</strong> {selectedVendor.toUpperCase()} verisi MAS Nakit Radar sistemine aktarıldı.
                    </div>
                    <div className="flex gap-2">
                      <span className="rounded bg-emerald-500/20 px-2 py-0.5 text-[11px] font-bold">
                        +{testResult.imported} Yeni Fatura
                      </span>
                      {testResult.skipped > 0 && (
                        <span className="rounded bg-surface px-2 py-0.5 text-[11px] text-tone-3">
                          {testResult.skipped} Atlandı (Mükerrer)
                        </span>
                      )}
                    </div>
                  </div>
                ) : (
                  <div>
                    <strong>Hata:</strong> {testResult.error}
                  </div>
                )}
              </div>
            )}
          </div>
        </Panel>
      </div>

      {/* Recent Sync Audit Log */}
      <Panel
        title="Son ERP Senkronizasyon Olayları"
        subtitle="Veritabanı denetim izinden (audit log) okunan son entegrasyon hareketleri."
        right={<Badge tone="neutral">{recentLogs.length} işlem</Badge>}
      >
        {recentLogs.length === 0 ? (
          <div className="py-6 text-center text-xs text-tone-3">
            Henüz ERP senkronizasyon kaydı bulunmuyor. Yukarıdaki panelden ilk test aktarımını gerçekleştirebilirsiniz.
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line text-left font-sans text-[11px] font-semibold text-tone-3">
                <th className="py-2 pr-3">Yazılım (Vendor)</th>
                <th className="py-2 pr-3">Eylem</th>
                <th className="py-2 pr-3">İçe Aktarılan</th>
                <th className="py-2 pr-3">Atlanan</th>
                <th className="py-2 text-right">Zaman</th>
              </tr>
            </thead>
            <tbody>
              {recentLogs.map((log) => (
                <tr key={log.id} className="border-b border-line-faint text-xs">
                  <td className="py-2.5 pr-3 font-semibold uppercase text-sky-400">
                    {log.vendor}
                  </td>
                  <td className="py-2.5 pr-3 text-tone-2 font-mono text-[11px]">
                    {log.action}
                  </td>
                  <td className="py-2.5 pr-3">
                    <Badge tone="green">+{log.imported} fatura</Badge>
                  </td>
                  <td className="py-2.5 pr-3 text-tone-3">
                    {log.skipped > 0 ? `${log.skipped} atlandı` : "0"}
                  </td>
                  <td className="py-2.5 text-right font-sans text-tone-3">
                    {log.createdAt}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>
    </div>
  );
}
