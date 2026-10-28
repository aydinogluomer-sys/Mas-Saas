import fs from "fs";
import { Pool } from "pg";

async function main() {
  const env = fs.readFileSync(".env.local", "utf8");
  const match = env.match(/MIGRATION_DATABASE_URL=([^\r\n]+)/);
  if (!match) throw new Error("MIGRATION_DATABASE_URL not found");
  const url = match[1].trim();

  const pool = new Pool({ connectionString: url });
  try {
    const res = await pool.query("SELECT current_user, session_user;");
    console.log("Current user:", res.rows);

    const rolesRes = await pool.query("SELECT rolname FROM pg_roles WHERE rolname LIKE '%mas_radar%'");
    console.log("Existing mas_radar roles:", rolesRes.rows.map(r => r.rolname));

    // Try granting roles to postgres
    try {
      await pool.query("GRANT mas_radar_admin, mas_radar_finance_manager, mas_radar_finance_operator, mas_radar_finance_approver, mas_radar_viewer TO postgres;");
      console.log("GRANT mas_radar_* TO postgres SUCCEEDED!");
    } catch (e: any) {
      console.log("GRANT to postgres failed:", e.message);
    }

    // Try granting roles to the current connected user
    const currentUser = res.rows[0].current_user;
    try {
      await pool.query(`GRANT mas_radar_admin, mas_radar_finance_manager, mas_radar_finance_operator, mas_radar_finance_approver, mas_radar_viewer TO "${currentUser}";`);
      console.log(`GRANT mas_radar_* TO "${currentUser}" SUCCEEDED!`);
    } catch (e: any) {
      console.log(`GRANT to "${currentUser}" failed:`, e.message);
    }
  } finally {
    await pool.end();
  }
}

main().catch(console.error);
