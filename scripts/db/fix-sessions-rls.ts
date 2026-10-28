import { Client } from "pg";

async function main() {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  await client.query("reset role");
  
  // Check if sessions_admin policy exists
  const check = await client.query(
    "select 1 from pg_policy where polname = 'sessions_admin' and polrelid = 'public.sessions'::regclass"
  );
  if (check.rowCount === 0) {
    await client.query("grant select, insert, update, delete on public.sessions to mas_radar_admin");
    await client.query(
      "create policy sessions_admin on public.sessions for all to mas_radar_admin using (true) with check (true)"
    );
    console.log("Created policy sessions_admin on public.sessions.");
  } else {
    console.log("Policy sessions_admin already exists.");
  }

  // Also check other roles for session creation during login
  const roles = ["mas_radar_finance_operator", "mas_radar_finance_approver", "mas_radar_finance_manager", "mas_radar_viewer"];
  for (const r of roles) {
    const pName = `sessions_${r.replace("mas_radar_", "")}`;
    const pCheck = await client.query(
      "select 1 from pg_policy where polname = $1 and polrelid = 'public.sessions'::regclass",
      [pName]
    );
    if (pCheck.rowCount === 0) {
      await client.query(`grant select, insert, update, delete on public.sessions to ${r}`);
      await client.query(
        `create policy ${pName} on public.sessions for all to ${r} using (true) with check (true)`
      );
      console.log(`Created policy ${pName} on public.sessions.`);
    }
  }

  await client.end();
}

main().catch(console.error);
