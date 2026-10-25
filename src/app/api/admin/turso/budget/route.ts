import { NextResponse } from "next/server";
import { requirePermission, isSuperAdmin } from "@/lib/auth/permissions";
import { tursoBudgetTracker } from "@/lib/turso/budget";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    const { user } = await requirePermission("LIVE_MAP", req);

    if (!isSuperAdmin(user)) {
      return NextResponse.json({ error: "Forbidden: Superadmin access required" }, { status: 403 });
    }

    const report = tursoBudgetTracker.getBudgetReport();
    return NextResponse.json(report);
  } catch (error: any) {
    if (error.message === "UNAUTHORIZED") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    if (error.message === "FORBIDDEN") {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
