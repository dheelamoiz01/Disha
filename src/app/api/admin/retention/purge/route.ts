import { NextResponse } from "next/server";
import { purgeExpiredLocationData, MAX_LOCATION_RETENTION_HOURS } from "@/services/retention/purge_service";
import { getSession } from "@/lib/auth/session";
import { isSuperAdmin } from "@/lib/auth/permissions";

export const dynamic = "force-dynamic";
export const maxDuration = 60; // seconds — allow time for large batch deletes

/**
 * POST /api/admin/retention/purge
 *
 * Triggers the 48-hour location data retention purge.
 *
 * Authorization (either one is sufficient):
 *   1. SuperAdmin session cookie  (manual trigger from dashboard)
 *   2. Authorization: Bearer <CRON_SECRET>  (automated Vercel Cron Job or external scheduler)
 *
 * The CRON_SECRET must be set in Vercel environment variables. Vercel Cron Jobs
 * automatically send this header when invoking the endpoint.
 *
 * Body (optional JSON):
 *   { "retentionHours": number }  — must be <= 48 (the hard policy limit)
 */
export async function POST(req: Request) {
  try {
    // ── Authorization ────────────────────────────────────────────────────────
    const authHeader = req.headers.get("authorization");
    const cronSecret = process.env.CRON_SECRET;

    // Vercel Cron Jobs send: Authorization: Bearer <CRON_SECRET>
    const isAuthorizedCron =
      cronSecret && authHeader && authHeader === `Bearer ${cronSecret}`;

    let actorId = "SYSTEM_CRON";
    let isAuthorizedAdmin = false;

    try {
      const { session, user } = await getSession();
      if (session && user && isSuperAdmin(user)) {
        isAuthorizedAdmin = true;
        actorId = user.id;
      }
    } catch {
      // Session check failure is not a hard error here — cron auth may still be valid
    }

    if (!isAuthorizedCron && !isAuthorizedAdmin) {
      console.warn("[RetentionPurge] Unauthorized purge attempt — missing valid CRON_SECRET or admin session.");
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // ── Parse optional override ──────────────────────────────────────────────
    let retentionHours = MAX_LOCATION_RETENTION_HOURS; // 48h default

    try {
      const body = await req.json();
      if (body?.retentionHours != null) {
        const parsed = Number(body.retentionHours);
        if (!isNaN(parsed) && parsed > 0) {
          retentionHours = Math.min(parsed, MAX_LOCATION_RETENTION_HOURS);
        }
      }
    } catch {
      // No body or invalid JSON — use default 48h
    }

    // ── Execute purge ────────────────────────────────────────────────────────
    const result = await purgeExpiredLocationData(retentionHours, actorId);

    return NextResponse.json({
      success: true,
      message: `48-hour retention purge completed. Permanently deleted ${result.locationsPurged} GPS pings, ${result.eventsPurged} location events, and ${result.heartbeatsPurged} heartbeats older than ${retentionHours}h (cutoff: ${result.cutoffDate}).`,
      ...result,
    });
  } catch (error: any) {
    console.error("[RetentionPurge] Route error:", error?.message);
    return NextResponse.json(
      { error: error?.message || "Failed to execute retention purge" },
      { status: 500 }
    );
  }
}

/**
 * GET /api/admin/retention/purge
 *
 * Supported for Vercel Cron Jobs which may invoke via GET.
 * Vercel sends Authorization: Bearer <CRON_SECRET> automatically.
 */
export async function GET(req: Request) {
  return POST(req);
}
