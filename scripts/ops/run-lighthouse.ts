import { Pool } from 'pg';
import { createHash, randomBytes } from 'node:crypto';
import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

async function main() {
  const targetUrl = process.argv[2] || 'http://localhost:3000/payments/calendar';
  console.log(`\n========================================`);
  console.log(`Running Lighthouse Audit on: ${targetUrl}`);
  console.log(`========================================\n`);

  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();

  let token = '';
  let tokenHash = '';

  try {
    // 1. Get an admin user
    const userRes = await client.query("SELECT id, username FROM public.users WHERE role = 'admin' LIMIT 1");
    if (userRes.rows.length === 0) {
      throw new Error('No admin user found in database');
    }
    const adminUser = userRes.rows[0];

    // 2. Generate a valid session token
    token = randomBytes(32).toString('base64url');
    tokenHash = createHash('sha256').update(token).digest('hex');
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

    await client.query(
      "INSERT INTO public.sessions (user_id, token_hash, expires_at) VALUES ($1, $2, $3)",
      [adminUser.id, tokenHash, expiresAt]
    );
    console.log(`[Auth] Created test session for user '${adminUser.username}' (expires in 24h)`);

    // 3. Prepare Lighthouse command
    const reportPath = path.resolve(process.cwd(), '.lighthouse-result.json');
    if (fs.existsSync(reportPath)) {
      fs.unlinkSync(reportPath);
    }

    const headersJson = JSON.stringify({ Cookie: `mas_session=${token}` });
    // Write headers to a temp file or pass as extra-headers
    const headersFile = path.resolve(process.cwd(), '.lighthouse-headers.json');
    fs.writeFileSync(headersFile, headersJson, 'utf-8');

    console.log('[Lighthouse] Launching Chrome in headless mode...');
    const cmd = `npx lighthouse "${targetUrl}" --preset=desktop --chrome-flags="--headless=new --no-sandbox" --extra-headers="${headersFile}" --output=json --output-path="${reportPath}" --quiet`;

    try {
      execSync(cmd, { stdio: 'inherit' });
    } catch (e: any) {
      console.warn('[Lighthouse] Execution warning:', e.message);
    }

    if (!fs.existsSync(reportPath)) {
      throw new Error('Lighthouse report was not generated');
    }

    const report = JSON.parse(fs.readFileSync(reportPath, 'utf-8'));

    // 4. Extract scores and metrics
    const categories = report.categories || {};
    const audits = report.audits || {};

    const perfScore = Math.round((categories.performance?.score ?? 0) * 100);
    const a11yScore = Math.round((categories.accessibility?.score ?? 0) * 100);
    const bpScore = Math.round((categories['best-practices']?.score ?? 0) * 100);
    const seoScore = Math.round((categories.seo?.score ?? 0) * 100);

    console.log(`\n----------------------------------------`);
    console.log(`LIGHTHOUSE SCORES (Desktop):`);
    console.log(`----------------------------------------`);
    console.log(`  Performance:    ${perfScore} / 100 ${perfScore >= 95 ? '✅ PASSED' : '❌ TARGET >= 95'}`);
    console.log(`  Accessibility:  ${a11yScore} / 100`);
    console.log(`  Best Practices: ${bpScore} / 100`);
    console.log(`  SEO:            ${seoScore} / 100`);
    console.log(`----------------------------------------`);
    console.log(`CORE WEB VITALS & AUDITS:`);
    console.log(`  FCP:  ${audits['first-contentful-paint']?.displayValue || 'N/A'}`);
    console.log(`  LCP:  ${audits['largest-contentful-paint']?.displayValue || 'N/A'}`);
    console.log(`  TBT:  ${audits['total-blocking-time']?.displayValue || 'N/A'}`);
    console.log(`  CLS:  ${audits['cumulative-layout-shift']?.displayValue || 'N/A'}`);
    console.log(`  TTFB: ${audits['server-response-time']?.displayValue || 'N/A'}`);
    console.log(`----------------------------------------\n`);

    // Flag any failed audits
    const opportunities = Object.entries(audits)
      .filter(([_, a]: [string, any]) => a.details && a.details.type === 'opportunity' && a.score !== 1)
      .map(([id, a]: [string, any]) => ({
        id,
        title: a.title,
        savings: a.displayValue || `${a.details?.overallSavingsMs || 0}ms`,
      }));

    if (opportunities.length > 0) {
      console.log('Top Opportunities for Improvement:');
      opportunities.forEach(op => console.log(`  - [${op.id}] ${op.title} (${op.savings})`));
      console.log('');
    }

    // Cleanup temp headers
    if (fs.existsSync(headersFile)) fs.unlinkSync(headersFile);

    return {
      performance: perfScore,
      accessibility: a11yScore,
      bestPractices: bpScore,
      seo: seoScore,
    };
  } finally {
    // Revoke test session
    if (tokenHash) {
      await client.query("UPDATE public.sessions SET revoked_at = now() WHERE token_hash = $1", [tokenHash]);
      console.log('[Auth] Cleaned up temporary test session');
    }
    client.release();
    await pool.end();
  }
}

main().catch(err => {
  console.error('[Error]', err);
  process.exit(1);
});
