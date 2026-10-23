import { NextResponse } from "next/server";
import crypto from "crypto";
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
 * Security Requirements:
 *   - CRON_SECRET must be configured in environment variables.
 *   - No hardcoded default secret or fallback is permitted.
 *   - Constant-time comparison prevents timing attacks.
 *   - Secret tokens are never logged or exposed in responses.
 *
 * Body (optional JSON):
 *   { "retentionHours": number }  — clamped to MAX_LOCATION_RETENTION_HOURS (48h)
 */
export async function POST(req: Request) {
  try {
    // ── Authorization ────────────────────────────────────────────────────────
    const authHeader = req.headers.get("authorization");
    const configuredCronSecret = process.env.CRON_SECRET?.trim();

    let isAuthorizedCron = false;
    let actorId = "SYSTEM_CRON";
    let isAuthorizedAdmin = false;

    // 1. Check Bearer Token (for automated cron invocation)
    if (authHeader && authHeader.startsWith("Bearer ")) {
      const providedToken = authHeader.substring(7).trim();

      if (!configuredCronSecret) {
        console.error(
          "[RetentionPurge] Authorization rejected: CRON_SECRET environment variable is missing or empty on the server."
        );
      } else {
        try {
          const a = Buffer.from(providedToken, "utf-8");
          const b = Buffer.from(configuredCronSecret, "utf-8");
          if (a.length === b.length && crypto.timingSafeEqual(a, b)) {
            isAuthorizedCron = true;
          }
        } catch {
          isAuthorizedCron = false;
        }
      }
    }

    // 2. Check SuperAdmin session (for authenticated manual execution from control room)
    if (!isAuthorizedCron) {
      try {
        const { session, user } = await getSession();
        if (session && user && isSuperAdmin(user)) {
          isAuthorizedAdmin = true;
          actorId = user.id;
        }
      } catch {
        // Session check error does not grant access
      }
    }

    if (!isAuthorizedCron && !isAuthorizedAdmin) {
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
 * Supported for Vercel Cron Jobs which invoke endpoints via GET.
 * Evaluates the same authentication and executes the purge.
 */
export async function GET(req: Request) {
  return POST(req);
}
