import { NextResponse } from "next/server";
import { requirePermission, isSuperAdmin } from "@/lib/auth/permissions";
import { getDashboardOverview } from "@/services/control-room/dashboard_service";

export async function GET(req: Request) {
  try {
    const { user } = await requirePermission("LIVE_MAP", req);
    const scopedAdminId = isSuperAdmin(user) ? null : user.id;
    const data = await getDashboardOverview(false, scopedAdminId);
    return NextResponse.json(data);
  } catch (error: any) {
    if (error.message === "UNAUTHORIZED") return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    if (error.message === "FORBIDDEN") return NextResponse.json({ error: "Forbidden: Live Map permission required" }, { status: 403 });
    
    console.error("Dashboard overview error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
