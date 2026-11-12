import { createCheckAction } from "../../actions";
import { Panel } from "@/components/ui/panel";
import { PageHeader } from "@/components/ui/shell";
import { requireRouteAccess } from "@/lib/authz/route-guard";

const field = "field-control mt-1 w-full p-2";

export default async function NewCheck() {
  const denied = await requireRouteAccess("/finance/checks/new");
  if (denied) return denied;
  return (
    <>
      <PageHeader
        title="Yeni çek / senet"
        subtitle="Manuel kıymetli evrak kaydı; kaynak bağlantılı kayıtların yerine geçmez."
      />
      <Panel title="Çek / senet bilgileri">
        <form action={createCheckAction} className="grid gap-3 sm:grid-cols-2">
          <label className="text-xs">
            Evrak türü
            <select name="instrumentType" defaultValue="check" className={field}>
              <option value="check">Çek</option>
              <option value="promissory_note">Senet (Bono)</option>
            </select>
          </label>
          <label className="text-xs">
            Yön
            <select name="direction" defaultValue="outflow" className={field}>
              <option value="outflow">Ödenecek (Keşide Borç Çeki/Senedi)</option>
              <option value="inflow">Tahsil edilecek (Müşteri Portföy Çeki/Senedi)</option>
              <option value="unknown">Belirsiz</option>
            </select>
          </label>
          <label className="text-xs">
            Vade tarihi
            <input required name="maturityDate" type="date" className={field} />
          </label>
          <div className="grid grid-cols-3 gap-2">
            <label className="col-span-2 text-xs">
              Tutar
              <input name="amount" type="number" step="0.01" min="0" className={field} />
            </label>
            <label className="text-xs">
              Para birimi
              <select name="currency" defaultValue="TRY" className={field}>
                <option value="TRY">TRY</option>
                <option value="USD">USD</option>
                <option value="EUR">EUR</option>
                <option value="GBP">GBP</option>
              </select>
            </label>
          </div>
          <label className="text-xs">
            Seri numarası
            <input name="serial" className={field} />
          </label>
          <label className="text-xs">
            Karşı taraf
            <input name="counterparty" className={field} />
          </label>
          <label className="text-xs sm:col-span-2">
            Not
            <input name="notes" className={field} />
          </label>
          <div className="sm:col-span-2">
            <button className="button-accent px-3 py-2">Çeki kaydet</button>
          </div>
        </form>
      </Panel>
    </>
  );
}
