/**
 * `scripts/ops/schedule-windows.ts` — zamanlanmış görevlerin SAF parçaları.
 *
 * Görev kaydı kalıcı bir sistem değişikliği olduğu için bu testler hiçbir şey KAYDETMEZ: yalnız
 * üretilen komutları ve ayar sertleştirmesini sınar. Ölçülen kusur: `schtasks /Create` görevi
 * StartWhenAvailable=False ve 72 saatlik süre sınırıyla kaydediyordu — 03:00'te uyuyan makinede
 * kaçırılan yedek hiç telafi edilmiyor, takılan bir koşu sonraki geceleri bloke ediyordu.
 */
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildScheduleSpec, buildSettingsCommand, buildStatusDetailCommand, positionalArgs,
} from "../scripts/ops/schedule-windows";

const ROOT = "C:\\Users\\Trade Bilisim\\Mas Saas";

describe("buildScheduleSpec", () => {
  it("günlük yedek: her gün 03:00, LIMITED, /F, tırnaklı sarmalayıcı yolu", () => {
    const spec = buildScheduleSpec(ROOT);
    expect(spec.taskName).toBe("MAS-Nakit-Radar-Gunluk-Yedek");
    expect(spec.wrapperPath).toBe(path.join(ROOT, "scripts", "ops", "mas-daily-backup.cmd"));
    const a = spec.createArgs;
    expect(a.slice(a.indexOf("/SC"), a.indexOf("/SC") + 2)).toEqual(["/SC", "DAILY"]);
    expect(a.slice(a.indexOf("/ST"), a.indexOf("/ST") + 2)).toEqual(["/ST", "03:00"]);
    expect(a.slice(a.indexOf("/RL"), a.indexOf("/RL") + 2)).toEqual(["/RL", "LIMITED"]);
    expect(a).toContain("/F");
    expect(a[a.indexOf("/TR") + 1]).toBe(`"${spec.wrapperPath}"`);
  });

  it("telemetri gözetimi: 07:00'den itibaren 6 saatte bir", () => {
    const spec = buildScheduleSpec(ROOT, undefined, undefined, "telemetry");
    expect(spec.taskName).toBe("MAS-Nakit-Radar-Telemetri-Gozetim");
    expect(spec.wrapperPath.endsWith("mas-telemetry-watch.cmd")).toBe(true);
    const a = spec.createArgs;
    expect(a.slice(a.indexOf("/SC"), a.indexOf("/SC") + 4)).toEqual(["/SC", "HOURLY", "/MO", "6"]);
    expect(a.slice(a.indexOf("/ST"), a.indexOf("/ST") + 2)).toEqual(["/ST", "07:00"]);
    expect(a.slice(a.indexOf("/RL"), a.indexOf("/RL") + 2)).toEqual(["/RL", "LIMITED"]);
  });

  it("geçersiz --at ve bilinmeyen iş reddedilir", () => {
    expect(() => buildScheduleSpec(ROOT, undefined, "3:00")).toThrow(/HH:MM/);
    expect(() => buildScheduleSpec(ROOT, undefined, undefined, "reboot")).toThrow(/--job bilinmiyor/);
  });
});

describe("buildSettingsCommand — kayıttan sonra uygulanan sertleştirme", () => {
  it("StartWhenAvailable, 2 saatlik süre sınırı, IgnoreNew, pilde başla/durma", () => {
    const args = buildSettingsCommand("MAS-Nakit-Radar-Gunluk-Yedek");
    expect(args.slice(0, 3)).toEqual(["-NoProfile", "-NonInteractive", "-Command"]);
    const script = args[3];
    expect(script).toContain("-StartWhenAvailable");
    expect(script).toContain("-ExecutionTimeLimit (New-TimeSpan -Hours 2)");
    expect(script).toContain("-MultipleInstances IgnoreNew");
    expect(script).toContain("-AllowStartIfOnBatteries");
    expect(script).toContain("-DontStopIfGoingOnBatteries");
    expect(script).toContain("Set-ScheduledTask -TaskName 'MAS-Nakit-Radar-Gunluk-Yedek' -Settings $s");
  });

  it.each(["x'; Unregister-ScheduledTask -TaskName y", "a;b", "a b", "", "a".repeat(65)])(
    "komuta dönüşebilecek görev adı reddedilir: %s",
    (name) => {
      expect(() => buildSettingsCommand(name)).toThrow(/kabul edilmiyor/);
      expect(() => buildStatusDetailCommand(name)).toThrow(/kabul edilmiyor/);
    },
  );

  it("status ayrıntısı SALT-OKUR: hiçbir görevi değiştirmez", () => {
    const script = buildStatusDetailCommand("MAS-Nakit-Radar-Telemetri-Gozetim")[3];
    expect(script).toContain("Get-ScheduledTask -TaskName 'MAS-Nakit-Radar-Telemetri-Gozetim'");
    expect(script).toContain("Get-ScheduledTaskInfo");
    expect(script).toContain("StartWhenAvailable");
    expect(script).toContain("LastTaskResult");
    for (const verb of ["Set-ScheduledTask", "Register-ScheduledTask", "Unregister-ScheduledTask", "Disable-ScheduledTask"]) {
      expect(script).not.toContain(verb);
    }
  });
});

describe("positionalArgs", () => {
  it("değer alan bayraklar ve salt bayraklar atlanır; geriye eylem kalır", () => {
    expect(positionalArgs(["node", "x", "--job", "telemetry", "status"])).toEqual(["status"]);
    expect(positionalArgs(["node", "x", "install", "--apply", "--at", "03:00"])).toEqual(["install"]);
    expect(positionalArgs(["node", "x", "--name", "Gorev", "--apply"])).toEqual([]);
  });
});
