import { NextResponse } from "next/server";
import { purgeOldTelemetry } from "@/services/retention/purge_service";
import { getSession } from "@/lib/auth/session";
import { isSuperAdmin } from "@/lib/auth/permissions";

export async function POST(req: Request) {
  try {
    // Check either SuperAdmin session or authorization header with CRON_SECRET
    const { session, user } = await getSession();
    const authHeader = req.headers.get("authorization");
    const cronSecret = process.env.CRON_SECRET || "disha-midnight-cron-secret";

    const isAuthorizedCron = authHeader && authHeader === `Bearer ${cronSecret}`;
    const isAuthorizedAdmin = session && user && isSuperAdmin(user);

    if (!isAuthorizedCron && !isAuthorizedAdmin) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await req.json().catch(() => ({}));
    const daysToKeep = Number(body.daysToKeep || process.env.RETENTION_DAYS || 30);

    const result = await purgeOldTelemetry(daysToKeep, user?.id || "SYSTEM_CRON");

    return NextResponse.json({
      success: true,
      message: `Successfully executed retention cleanup (kept past ${daysToKeep} days)`,
      ...result,
    });
  } catch (error: any) {
    return NextResponse.json(
      { error: error?.message || "Failed to execute retention purge" },
      { status: 500 }
    );
  }
}
