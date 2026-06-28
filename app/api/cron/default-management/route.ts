import { NextRequest, NextResponse } from "next/server";
import { runDefaultManagement } from "@/lib/scheduler/default-management";

/**
 * POST/GET /api/cron/default-management
 *
 * Automated Default-Management run (issue #23). Triggered by an external
 * scheduler (Vercel Cron, GitHub Actions, cURL). Iterates over overdue loans
 * and, past the grace period, triggers the on-chain `mark_defaulted` /
 * `record_default` / `trigger_insurance_payout` contract methods.
 *
 * Secured via CRON_SECRET in the Authorization header (`Bearer <secret>`).
 */
export async function POST(request: NextRequest) {
  // Verify the caller is the trusted scheduler.
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const authHeader = request.headers.get("authorization");
    if (authHeader !== `Bearer ${secret}`) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  const start = Date.now();
  try {
    const result = await runDefaultManagement();
    const duration = Date.now() - start;
    console.log(
      `[default-management] Run complete in ${duration}ms: ` +
        `scanned=${result.scanned} defaulted=${result.defaulted} ` +
        `paidOut=${result.paidOut} failed=${result.failed}`
    );
    return NextResponse.json({ ok: true, ...result, duration });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unexpected error";
    console.error("[default-management] Scheduler run failed:", msg);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}

// Allow Vercel's cron invocations (GET-based) as well.
export const GET = POST;

// Default-management contract calls can take a while across many loans.
export const maxDuration = 300;
