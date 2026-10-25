import { NextResponse } from "next/server";
import { requireAuth, requireRole } from "@/lib/auth/authorization";
import { isSuperAdmin } from "@/lib/auth/permissions";
import { validateOrigin } from "@/lib/security/csrf";
import { resolveAlert, AlertError } from "@/services/alert/alert_service";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    if (!validateOrigin(req)) return NextResponse.json({ error: "Invalid Origin" }, { status: 403 });

    const { user } = await requireAuth();
    
    // Authorization: Only Control Room, DYSP, SP
    await requireRole(["CONTROL_ROOM_OFFICER", "DYSP", "SP"]);
    
    const resolvedParams = await params;
    const result = await resolveAlert(resolvedParams.id, user.id, isSuperAdmin(user));

    return NextResponse.json(result);
  } catch (error: any) {
    if (error.message === "UNAUTHORIZED") return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    if (error.message === "FORBIDDEN") return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    if (error instanceof AlertError) return NextResponse.json({ error: error.message, code: error.code }, { status: 400 });
    
    console.error("Alert Resolve Error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
