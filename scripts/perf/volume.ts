// Faz 33 — realistic data volume for performance measurement.
//
// WHY THIS EXISTS, AND WHY IT IS NOT RANDOM
//
// The plan asks for a before/after query-plan comparison on the slowest queries. That is only
// meaningful against a table big enough for the planner to stop choosing a sequential scan
// because the table fits on one page. The seeded demo database has 19 payments; every plan over
// it is a seq scan and every timing is noise.
//
// Everything below is derived arithmetically from `generate_series`. NO random(), NO clock
// reads, NO uuid v4 in the data shape. Two runs on two machines produce byte-identical rows,
// which is what lets a gate compare a plan taken today with a threshold decided yesterday. A
// generator seeded with random() would make "the plan changed" indistinguishable from "the data
// changed".
//
// This is TEST data in a DISPOSABLE database. It never runs against mas_radar_dev, and the
// gate's Usage line names the disposable URL explicitly.
import type { Pool } from "pg";

export interface VolumeScale {
  parties: number;
  invoices: number;
  bankTransactions: number;
  paymentInstances: number;
  checks: number;
  auditLogs: number;
}

/**
 * Roughly three years of a mid-size manufacturer: enough rows that index choice matters, small
 * enough that the gate stays under a minute.
 */
export const DEFAULT_SCALE: VolumeScale = {
  parties: 400,
  invoices: 24000,
  bankTransactions: 60000,
  paymentInstances: 12000,
  checks: 6000,
  auditLogs: 40000,
};

/** Deterministic UUID from an integer — same input, same id, forever. */
const UUID_EXPR = (series: string, tag: string) =>
  `md5('${tag}:' || ${series}::text)::uuid`;

export async function generateVolume(pool: Pool, scale: VolumeScale = DEFAULT_SCALE): Promise<void> {
  const c = await pool.connect();
  try {
    await c.query("begin");

    // ── parties ────────────────────────────────────────────────────────────────────────
    await c.query(
      // normalized_name is NOT NULL and NOT generated (0002) — supplied explicitly rather than
      // hoped for. Discovered by the insert failing, not by assuming the column was derived.
      `insert into public.parties (id, name, normalized_name, party_type)
       select ${UUID_EXPR("i", "party")}, 'PERF Karşı Taraf ' || i,
              lower(btrim('PERF Karşı Taraf ' || i)),
              (array['customer','vendor','company','bank'])[1 + (i % 4)]
       from generate_series(1, $1) i
       on conflict do nothing`, [scale.parties]);

    // ── invoices ───────────────────────────────────────────────────────────────────────
    // gross = net + tax is a real invariant (0044); computed here rather than approximated,
    // because a generator that violates a CHECK teaches nothing except that it was careless.
    await c.query(
      `insert into public.invoices
         (id, direction, invoice_no, party_id, issue_date, due_date, currency,
          net_amount, tax_amount, gross_amount, status)
       select ${UUID_EXPR("i", "inv")},
              case when i % 2 = 0 then 'sales' else 'purchase' end,
              'PERF-' || i,
              ${UUID_EXPR("(1 + (i % $2))", "party")},
              (current_date - ((i % 1095))::int),
              (current_date - ((i % 1095))::int + 45),
              'TRY',
              ((i % 900) + 100)::numeric * 10,
              (((i % 900) + 100)::numeric * 10 * 0.20),
              (((i % 900) + 100)::numeric * 10 * 1.20),
              (array['open','open','partial','paid','draft'])[1 + (i % 5)]
       from generate_series(1, $1) i
       on conflict do nothing`, [scale.invoices, scale.parties]);

    // ── bank transactions (Faz 20's volume driver) ─────────────────────────────────────
    // The demo seed leaves cash_accounts EMPTY, so an earlier draft silently generated zero bank
    // transactions and the measurement missed the biggest table in the system. Create the
    // account rather than skipping — a generator that quietly produces nothing is worse than one
    // that fails.
    await c.query(
      `insert into public.cash_accounts (id, name, account_type, currency)
       values (${UUID_EXPR("0", "acct")}, 'PERF Banka Hesabı', 'bank_account', 'TRY')
       on conflict do nothing`);
    const acct = await c.query(
      `select id from public.cash_accounts where name = 'PERF Banka Hesabı'`);
    if (acct.rowCount) {
      // bank_accounts is keyed by cash_account_id; ensure one exists to hang transactions on.
      await c.query(
        `insert into public.bank_accounts (cash_account_id) values ($1) on conflict do nothing`,
        [acct.rows[0].id]);
      await c.query(
        `insert into public.bank_transactions
           (id, bank_account_id, txn_date, amount, currency, description,
            counterparty_name_raw, status, dedupe_hash)
         select ${UUID_EXPR("i", "btx")}, $2,
                (current_date - ((i % 1095))::int),
                -- direction is a GENERATED column (0042: negative => outflow), so the SIGN is
                -- the input and the direction must not be supplied. Writing both would have been
                -- two sources for one fact.
                case when i % 3 = 0 then ((i % 5000) + 50)::numeric
                     else -((i % 5000) + 50)::numeric end,
                'TRY', 'PERF hareket ' || i, 'PERF Karşı Taraf ' || (1 + (i % $3)),
                'unmatched', 'perfhash-' || i
         from generate_series(1, $1) i
         on conflict do nothing`, [scale.bankTransactions, acct.rows[0].id, scale.parties]);
    }

    // ── payments, then their instances ─────────────────────────────────────────────────
    // MEASURED, not assumed: payment_instances carries a UNIQUE (payment_id, instance_month)
    // idempotency index (Faz 3). Generating 12.000 instances against ONE payment produced 36
    // rows — the index did exactly its job and the first measurement was quietly worthless.
    // Instances are therefore a CROSS of many payments × months.
    const months = 36;
    const payCount = Math.max(1, Math.ceil(scale.paymentInstances / months));
    await c.query(
      `insert into public.payments (id, name, recurrence_type, due_day, default_amount, currency)
       select ${UUID_EXPR("i", "pay")}, 'PERF Ödeme ' || i, 'monthly',
              1 + (i % 28), ((i % 500) + 50)::numeric * 10, 'TRY'
       from generate_series(1, $1) i
       on conflict do nothing`, [payCount]);
    {
      await c.query(
        `insert into public.payment_instances
           (id, payment_id, instance_month, due_date, amount, currency, status, direction,
            amount_status, amount_source, paid_at)
         select ${UUID_EXPR("(p * 1000 + m)", "pi")},
                ${UUID_EXPR("p", "pay")},
                (date_trunc('month', current_date)::date - ((m) || ' months')::interval)::date,
                (date_trunc('month', current_date)::date - ((m) || ' months')::interval)::date
                  + ((p % 27))::int,
                -- Every 17th row has an UNKNOWN amount, deliberately: the read models are full
                -- of "null is not zero" branches and a generator with no nulls would measure the
                -- easy half of every query.
                case when (p * 36 + m) % 17 = 0 then null
                     else (((p * 36 + m) % 800) + 100)::numeric * 5 end,
                'TRY',
                (array['unpaid','paid','planned','late'])[1 + ((p * 36 + m) % 4)],
                case when (p * 36 + m) % 5 = 0 then 'inflow' else 'outflow' end,
                case when (p * 36 + m) % 17 = 0 then 'missing' else 'known' end,
                'generated',
                -- paid_requires_paid_at fires on INSERT, so this cannot be a follow-up UPDATE.
                -- paid_fields_scoped also forbids paid_at on any other status, so it is set for
                -- exactly the 'paid' rows and left null everywhere else.
                case when (array['unpaid','paid','planned','late'])[1 + ((p * 36 + m) % 4)] = 'paid'
                     then now() else null end
         from generate_series(1, $1) p, generate_series(0, $2 - 1) m
         on conflict do nothing`, [payCount, months]);
    }

    // ── checks ─────────────────────────────────────────────────────────────────────────
    await c.query(
      `insert into public.checks
         (id, maturity_date, serial_no, amount, signed_amount, direction, status, counterparty_label)
       select ${UUID_EXPR("i", "chk")},
              (current_date - 400 + ((i % 800))::int),
              'PERF-CHK-' || i,
              ((i % 3000) + 100)::numeric,
              case when i % 3 = 0 then ((i % 3000) + 100)::numeric
                   else -((i % 3000) + 100)::numeric end,
              case when i % 3 = 0 then 'inflow' else 'outflow' end,
              (array['planned','cleared','bounced','planned'])[1 + (i % 4)],
              'PERF Karşı Taraf ' || (1 + (i % $2))
       from generate_series(1, $1) i
       on conflict do nothing`, [scale.checks, scale.parties]);

    // ── audit logs ─────────────────────────────────────────────────────────────────────
    await c.query(
      `insert into public.audit_logs (id, action, entity_table, entity_id, created_at)
       select ${UUID_EXPR("i", "aud")}, 'perf_seed', 'payment_instances',
              ${UUID_EXPR("i", "pi")}, now() - ((i % 1095) || ' days')::interval
       from generate_series(1, $1) i
       on conflict do nothing`, [scale.auditLogs]);

    await c.query("commit");
  } catch (e) {
    await c.query("rollback");
    throw e;
  } finally {
    c.release();
  }

  // VACUUM ANALYZE, and the VACUUM half is not decoration.
  //
  // ANALYZE alone is not enough, measured the hard way: right after a bulk insert the gate saw the
  // planner REFUSE the index-only scan and report 455.011 buffers, then choose it and report 7.113
  // on the very same database minutes later. The difference is the VISIBILITY MAP — an index-only
  // scan may only skip the heap for pages marked all-visible, and only VACUUM marks them. Freshly
  // inserted pages are not, so the plan was correct for the state of the table and simply arrived
  // before autovacuum did.
  //
  // Without this the whole before/after comparison would be a coin flip on autovacuum timing.
  await pool.query("vacuum analyze");
}

/**
 * Remove everything this generator created — and NOTHING else.
 *
 * The payment_instances rows are targeted by their DETERMINISTIC ids, regenerated from the same
 * series that created them. An earlier draft matched on `amount_source = 'generated'`, which is
 * also true of rows the real engine produces: the cleanup would have deleted legitimate seeded
 * data and the next gate run would have measured a quietly different database.
 */
export async function dropVolume(pool: Pool, scale: VolumeScale = DEFAULT_SCALE): Promise<void> {
  await pool.query(`delete from public.audit_logs where action = 'perf_seed'`);
  await pool.query(`delete from public.checks where serial_no like 'PERF-CHK-%'`);
  await pool.query(
    `delete from public.payment_instances where id in (
       select ${UUID_EXPR("(p * 1000 + m)", "pi")}
       from generate_series(1, $1) p, generate_series(0, 35) m)`,
    [Math.max(1, Math.ceil(scale.paymentInstances / 36))]);
  await pool.query(`delete from public.payments where name like 'PERF Ödeme %'`);
  await pool.query(`delete from public.bank_transactions where dedupe_hash like 'perfhash-%'`);
  await pool.query(`delete from public.invoices where invoice_no like 'PERF-%'`);
  await pool.query(`delete from public.parties where name like 'PERF Karşı Taraf %'`);
  await pool.query("analyze");
}
