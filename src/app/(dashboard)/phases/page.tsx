import Link from "next/link";
import { FEATURE_REGISTRY } from "@/lib/feature-registry";
import { Badge } from "@/components/ui/badge";
import { Panel } from "@/components/ui/panel";
import { PageHeader, TableShell } from "@/components/ui/shell";

export default function FeaturesPage() {
  return (
    <>
      <PageHeader
        title="Faz ve Özellik Haritası"
        subtitle="Hangi yetenek hangi rotada yaşıyor ve hangi gate onu kanıtlıyor"
        meta={<Badge tone="neutral">{FEATURE_REGISTRY.length} kayıt</Badge>}
      />
      <Panel title="Özellik kayıtları">
        <p className="mb-3 text-[12px] text-tone-3">
          Bu tablo <strong className="text-tone-2">elle tutulan bir envanterdir; canlı test sonucu değildir.</strong>{" "}
          &quot;Motor&quot; ve &quot;Arayüz&quot; sütunları koda göre güncellenen beyanlardır. Bir özelliğin gerçekten
          çalıştığını görmek için &quot;Kanıtlayan gate&quot; sütunundaki script&apos;i çalıştırın; birim testler için{" "}
          <code className="font-mono text-[11px] text-tone-2">pnpm test</code>.
        </p>
        <TableShell>
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-tone-3">
                <th>No</th>
                <th>Özellik</th>
                <th>Motor</th>
                <th>Arayüz</th>
                <th>Kanıtlayan gate</th>
                <th>Kanonik rota</th>
              </tr>
            </thead>
            <tbody>
              {FEATURE_REGISTRY.map((f) => (
                <tr key={f.id} className="border-t border-line-faint">
                  <td className="py-2 font-mono text-[11px] text-tone-3">{f.id}</td>
                  <td>{f.title}</td>
                  <td>
                    <Badge tone={f.implemented ? "green" : "amber"}>{f.implemented ? "hazır" : "bekliyor"}</Badge>
                  </td>
                  <td>
                    <Badge tone={f.uiVisible ? "green" : "amber"}>{f.uiVisible ? "görünür" : "gizli"}</Badge>
                  </td>
                  <td>
                    <span className="flex flex-wrap gap-1">
                      {f.verifiedBy.map((gate) => (
                        <code key={gate} className="font-mono text-[10px] text-tone-2">
                          pnpm {gate}
                        </code>
                      ))}
                    </span>
                  </td>
                  <td>
                    <Link className="text-info" href={f.canonicalRoute}>
                      {f.canonicalRoute} →
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableShell>
      </Panel>
    </>
  );
}
