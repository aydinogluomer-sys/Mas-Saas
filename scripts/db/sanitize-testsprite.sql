-- TestSprite-only anonymization. Run only against mas_radar_testsprite.
-- Removes workbook contents, organization names, financial values, notes, JSON payloads,
-- audit before/after data and generated narrative while preserving relational/UI coverage.

update public.source_workbooks set
  original_filename='synthetic-demo.xlsx', storage_path=null, file_sha256=null,
  imported_by=null, parse_error=null, notes='Synthetic TestSprite fixture';

update public.source_sheets set
  sheet_name='Synthetic Sheet ' || sheet_index,
  sheet_name_normalized='synthetic-sheet-' || sheet_index,
  used_range='A1:J40';

update public.source_cells set
  raw_value=case when inferred_type in ('number','numeric','currency','date') then '100' else 'SYNTHETIC' end,
  normalized_value=case when inferred_type in ('number','numeric','currency') then '100' else 'synthetic' end,
  formula=null, style_json='{}'::jsonb;

update public.import_rows set
  row_json='{"synthetic":true}'::jsonb, row_hash=null,
  notes='Synthetic TestSprite row';

update public.mapping_reviews set
  message='Synthetic review: ' || issue_type,
  suggested_mapping='{"synthetic":true}'::jsonb,
  reviewed_by=null;

update public.parties set
  name='Demo ' || party_type || ' ' || left(id::text,8),
  normalized_name='demo-' || id::text;

update public.cash_accounts set
  name='Demo account ' || left(id::text,8);

with ranked as (select id,row_number() over(order by created_at,id) n from public.payments)
update public.payments p set
  name='Demo Payment ' || ranked.n,
  description='Synthetic recurring payment',
  default_amount=case when ranked.n=1 then 120000 else 10000+ranked.n*1000 end,
  source_notes=null
from ranked where p.id=ranked.id;

with ranked as (select id,row_number() over(order by due_date,id) n from public.payment_instances)
update public.payment_instances p set
  amount=case when ranked.n=1 then 120000 else 10000+(ranked.n%12)*1000 end,
  paid_amount=case when p.paid_amount is null then null else case when ranked.n=1 then 120000 else 10000+(ranked.n%12)*1000 end end,
  note=case when p.note='short_month_adjustment' then p.note else 'Synthetic TestSprite instance' end
from ranked where p.id=ranked.id;

with ranked as (select id,row_number() over(order by month_start) n from public.cashflow_months)
update public.cashflow_months m set
  opening_balance=500000-(ranked.n-1)*25000,
  projected_income=150000,
  projected_expense=175000,
  monthly_delta=-25000,
  closing_balance=500000-ranked.n*25000,
  notes='Synthetic TestSprite cash flow'
from ranked where m.id=ranked.id;

with ranked as (select id,row_number() over(partition by cashflow_month_id order by created_at,id) n from public.cashflow_lines)
update public.cashflow_lines l set
  label='Demo ' || replace(l.line_type,'_',' ') || ' ' || ranked.n,
  amount=case when l.amount is null then null else 5000+(ranked.n%10)*1000 end,
  notes='Synthetic TestSprite cash-flow line'
from ranked where l.id=ranked.id;

update public.cashflow_snapshots set
  total_projected_income=horizon_months*150000,
  total_projected_expense=horizon_months*175000,
  final_projected_balance=500000-horizon_months*25000,
  worst_balance=500000-horizon_months*25000;

with ranked as (select id,row_number() over(order by maturity_date,id) n from public.checks)
update public.checks c set
  serial_no='DEMO-' || lpad(ranked.n::text,3,'0'),
  amount=20000+ranked.n*1000,
  signed_amount=case when c.direction='inflow' then 20000+ranked.n*1000 else -(20000+ranked.n*1000) end,
  counterparty_label='Demo counterparty ' || ranked.n,
  notes='Synthetic TestSprite check'
from ranked where c.id=ranked.id;

update public.check_events set event_note='Synthetic check event', created_by=null;

update public.loans set
  name='Demo Business Loan', principal=120000, term_months=installment_count,
  installment_amount=2500, total_payment=120000, total_finance_cost=20000,
  simple_interest_rate=2.5, applied_interest_rate=2.5, monthly_cost_rate=2.5,
  annual_cost_rate=30, bsmv_rate=5, kkdf_rate=5,
  notes='Synthetic TestSprite loan';

update public.loan_installments set
  amount=2500, principal_component=2000, interest_component=400, tax_component=100;

update public.reminders set name='Demo reminder ' || offset_days || ' days';
update public.reminder_deliveries set
  error=case when status='failed' then 'Synthetic delivery failure' else null end,
  payload='{"synthetic":true}'::jsonb;

update public.reports set
  body_md='# Synthetic finance report\n\nAll values and names in this report are generated for TestSprite.',
  meta='{"synthetic":true}'::jsonb;

with ranked as (select id,row_number() over(order by created_at,id) n from public.machine_assets)
update public.machine_assets m set
  name='Demo Machine ' || ranked.n, purchase_cost=100000+ranked.n*10000,
  notes='Synthetic machine'
from ranked where m.id=ranked.id;

with ranked as (select id,row_number() over(order by created_at,id) n from public.production_parts)
update public.production_parts p set
  part_code='PART-' || lpad(ranked.n::text,3,'0'),
  part_name='Demo Part ' || ranked.n,
  quantity=10+(ranked.n%5), torna_minutes=coalesce(p.torna_minutes,5),
  freze_minutes=coalesce(p.freze_minutes,8)
from ranked where p.id=ranked.id;

update public.capacity_models set
  name='Demo Capacity', freze_rate_tl_per_min=25, torna_rate_tl_per_min=20,
  theoretical_monthly_revenue=500000, theoretical_total_revenue=6000000,
  notes='Synthetic capacity model';

update public.cost_models set
  model_name='Demo Cost Model', food_daily_cost=1000,
  transport_staff_daily_cost=1000, transport_apprentice_daily_cost=500,
  health_insurance_cost=10000, machine_insurance_cost=10000,
  total_fixed_cost=200000, monthly_allocated_cost=200000,
  break_even_torna_tl_per_min=22, break_even_freze_tl_per_min=26,
  break_even_tl_per_min=24, akon_freze_tl_per_min=30, akon_torna_tl_per_min=25;

with ranked as (select id,row_number() over(partition by cost_model_id order by id) n from public.cost_breakdown_lines)
update public.cost_breakdown_lines l set
  label='Demo cost ' || ranked.n, amount=1000+ranked.n*100
from ranked where l.id=ranked.id;

update public.part_profitability_runs set
  estimated_torna_cost=1000, estimated_freze_cost=1200,
  estimated_total_cost=2200, estimated_revenue=3000,
  estimated_margin=800, margin_rate=0.2667;

update public.machine_roi_snapshots set
  revenue=500000, cost=300000, remaining=200000,
  tax=40000, net_after_tax=160000,
  notes='Synthetic ROI; analytics only';

update public.machine_minute_allocations set
  demand_minutes=10000, available_minutes=12000,
  utilization_rate=0.833333, idle_minutes=2000,
  over_capacity_minutes=0, notes='Synthetic allocation';

update public.finance_cost_allocations set
  demand_minutes=10000, allocation_ratio=1,
  total_finance_cost=20000, allocated_finance_cost=20000,
  finance_cost_per_minute=2, finance_cost_per_machine=5000,
  notes='Synthetic finance allocation';

update public.scenarios set
  name='Demo Scenario', description='Synthetic TestSprite scenario',
  baseline_label='Synthetic 35-month cash flow', created_by=null;
update public.scenario_runs set
  assumptions='{"revenuePct":-0.1,"synthetic":true}'::jsonb,
  notes='Synthetic scenario run';
update public.scenario_assumptions set description='Synthetic assumption';

update public.ai_response_snapshots set
  question='What is the synthetic cash risk?',
  answer_md='Synthetic evidence-backed answer for TestSprite.',
  source_fact_keys='{}', source_hrefs='{}', safety_notes=array['synthetic data'],
  meta='{"synthetic":true}'::jsonb;

update public.action_items set
  title='Synthetic action item', owner='Demo Owner',
  source_fact_key=null, source_href='/overview', related_entity_table=null,
  related_entity_id=null, note='Synthetic TestSprite action', created_by=null;

update public.external_assumptions set
  label='Synthetic interest assumption', value_numeric=40,
  source_name='Synthetic source', source_url=null,
  notes='Synthetic TestSprite assumption', created_by=null, reviewed_by=null;

update public.audit_logs set
  actor=null, before_data='{"synthetic":true}'::jsonb,
  after_data='{"synthetic":true}'::jsonb;

