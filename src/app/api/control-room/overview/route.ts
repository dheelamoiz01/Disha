import { NextResponse } from "next/server";
import { requirePermission, isSuperAdmin } from "@/lib/auth/permissions";
import { getDashboardOverview, getDashboardOverviewCacheTimestamp } from "@/services/control-room/dashboard_service";

export async function GET(req: Request) {
  try {
    const { user } = await requirePermission("LIVE_MAP", req);
    const scopedAdminId = isSuperAdmin(user) ? null : user.id;

    // Fast-path ETag check if cached snapshot is valid
    const scopeKey = scopedAdminId || "GLOBAL";
    const ifNoneMatch = req.headers.get("if-none-match");
    const cachedTs = getDashboardOverviewCacheTimestamp(scopedAdminId);

    if (ifNoneMatch && cachedTs) {
      const expectedEtag = `"${scopeKey}-${cachedTs}"`;
      if (ifNoneMatch === expectedEtag) {
        return new NextResponse(null, {
          status: 304,
          headers: {
            ETag: expectedEtag,
            "Cache-Control": "private, no-cache",
          },
        });
      }
    }

    const data = await getDashboardOverview(false, scopedAdminId);
    const currentTs = getDashboardOverviewCacheTimestamp(scopedAdminId) || Date.now();
    const etag = `"${scopeKey}-${currentTs}"`;

    if (ifNoneMatch === etag) {
      return new NextResponse(null, {
        status: 304,
        headers: {
          ETag: etag,
          "Cache-Control": "private, no-cache",
        },
      });
    }

    return NextResponse.json(data, {
      headers: {
        ETag: etag,
        "Cache-Control": "private, no-cache",
      },
    });
  } catch (error: any) {
    if (error.message === "UNAUTHORIZED") return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    if (error.message === "FORBIDDEN") return NextResponse.json({ error: "Forbidden: Live Map permission required" }, { status: 403 });
    
    console.error("Dashboard overview error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
