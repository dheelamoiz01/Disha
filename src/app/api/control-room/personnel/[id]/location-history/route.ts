import { NextResponse } from "next/server";
import { requirePermission, isSuperAdmin } from "@/lib/auth/permissions";
import { prisma } from "@/lib/prisma";
import { logAudit } from "@/lib/auth/audit";
import { getStaffLocationTrail } from "@/services/control-room/trail_service";

export async function GET(req: Request, props: { params: Promise<{ id: string }> }) {
  try {
    const { user } = await requirePermission("LIVE_MAP", req);

    const resolvedParams = await props.params;
    const personnelId = resolvedParams.id;

    if (!personnelId) {
      return NextResponse.json({ error: "Missing personnel ID" }, { status: 400 });
    }

    // Ownership check: regular admin can only view location history for their own staff
    if (!isSuperAdmin(user)) {
      const staff = await prisma.personnel.findUnique({
        where: { id: personnelId },
        select: { adminId: true },
      });
      if (!staff || staff.adminId !== user.id) {
        return NextResponse.json({ error: "Staff member not found or access denied" }, { status: 404 });
      }
    }

    const { searchParams } = new URL(req.url);
    const dateParam = searchParams.get("date");
    const startParam = searchParams.get("start");
    const endParam = searchParams.get("end");
    const dutySessionId = searchParams.get("dutySessionId") || undefined;

    let trailResult;

    if (dateParam) {
      // Date in YYYY-MM-DD format (IST)
      trailResult = await getStaffLocationTrail(personnelId, {
        dateStr: dateParam,
        dutySessionId,
      });
    } else if (startParam && endParam) {
      const startTime = new Date(startParam);
      const endTime = new Date(endParam);

      if (isNaN(startTime.getTime()) || isNaN(endTime.getTime())) {
        return NextResponse.json({ error: "Invalid date format" }, { status: 400 });
      }

      const diffDays = (endTime.getTime() - startTime.getTime()) / (1000 * 3600 * 24);
      if (diffDays > 90) {
        return NextResponse.json({ error: "Requested range exceeds 90 days" }, { status: 400 });
      }
      if (diffDays < 0) {
        return NextResponse.json({ error: "Invalid date range: start cannot be after end" }, { status: 400 });
      }

      trailResult = await getStaffLocationTrail(personnelId, {
        startTime,
        endTime,
        dutySessionId,
      });
    } else {
      // Default to today in IST
      trailResult = await getStaffLocationTrail(personnelId, {
        dutySessionId,
      });
    }

    await logAudit({
      actorId: user.id,
      action: "VIEW_LOCATION_HISTORY",
      targetType: "Personnel",
      targetId: personnelId,
      metadata: {
        date: dateParam || undefined,
        start: startParam || undefined,
        end: endParam || undefined,
        dutySessionId,
        pointsReturned: trailResult.locations.length,
      },
    });

    return NextResponse.json({
      personnel: trailResult.personnel,
      sessions: trailResult.sessions,
      locations: trailResult.locations,
      summary: trailResult.summary,
      trackingGaps: trailResult.trackingGaps,
    });
  } catch (error: any) {
    if (error.message === "UNAUTHORIZED") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    if (error.message === "FORBIDDEN") {
      return NextResponse.json({ error: "Forbidden: Live Map permission required" }, { status: 403 });
    }
    if (error.message === "PERSONNEL_NOT_FOUND") {
      return NextResponse.json({ error: "Staff member not found" }, { status: 404 });
    }

    console.error("Location history route error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
