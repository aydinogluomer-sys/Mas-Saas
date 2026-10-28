/**
 * MAS Nakit Radar — Kilit Taşı 3: Kapalı Devre İç Kontrol ve Onay Kilidi
 * (Control Gatekeeper & Self-Healing Approval Lock)
 * 
 * control_alerts ↔ action_items ↔ approvals
 * 
 * Bir işlem (ödeme, fatura, cari) üzerinde aktif, çözülmemiş
 * kritik veya uyarı seviyesinde bir iç kontrol anomalisi varsa
 * o işlemin onaylanmasını (approvals) matematiksel olarak kilitler.
 */

import type { PoolClient } from "pg";
import { DomainError } from "@/lib/domain-error";

export interface BlockingAlert {
  id: string;
  checkCode: string;
  severity: string;
  title: string;
  status: string;
  actionItemId: string | null;
}

/**
 * Verilen subject_table ve subject_id üzerinde blokaj koyan açık bir kontrol uyarısı olup olmadığını sorgular.
 */
export async function getBlockingControlAlerts(
  client: PoolClient,
  subjectTable: string,
  subjectId: string,
): Promise<BlockingAlert[]> {
  const res = await client.query<{
    id: string;
    check_code: string;
    severity: string;
    title: string;
    status: string;
    action_item_id: string | null;
  }>(`
    select 
      ca.id,
      ca.check_code,
      ca.severity,
      ca.title,
      ca.status,
      ai.id as action_item_id
    from public.control_alerts ca
    left join public.action_items ai 
      on ai.related_entity_table = 'control_alerts' and ai.related_entity_id = ca.id
    where ca.subject_table = $1 
      and ca.subject_id = $2
      and ca.status in ('open', 'acknowledged')
      and ca.severity in ('warning', 'critical')
    order by case when ca.severity = 'critical' then 1 else 2 end, ca.created_at asc
  `, [subjectTable, subjectId]);

  return res.rows.map((r) => ({
    id: r.id,
    checkCode: r.check_code,
    severity: r.severity,
    title: r.title,
    status: r.status,
    actionItemId: r.action_item_id,
  }));
}

/**
 * Onay öncesi kilit denetimi. Eğer açık bir anomali varsa DomainError fırlatarak onayı durdurur.
 */
export async function assertNoBlockingControlAlerts(
  client: PoolClient,
  subjectTable: string,
  subjectId: string,
): Promise<void> {
  const blocking = await getBlockingControlAlerts(client, subjectTable, subjectId);
  if (blocking.length > 0) {
    const top = blocking[0];
    const taskInfo = top.actionItemId ? ` (Görev ID: ${top.actionItemId})` : "";
    throw new DomainError(
      `İç Kontrol Kilidi: Bu ${subjectTable} kaydı üzerinde çözülmemiş ${top.severity.toUpperCase()} seviyesinde bir alarm var: ` +
      `[${top.checkCode}] ${top.title}${taskInfo}. İlgili anomali çözümlenmeden onay verilemez.`,
    );
  }
}
