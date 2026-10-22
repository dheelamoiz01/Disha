import { NextResponse } from "next/server";
import { checkAppUpdate } from "@/services/release/release_service";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const versionCodeParam = searchParams.get("versionCode");

    if (!versionCodeParam) {
      return NextResponse.json(
        { error: "versionCode query parameter is required" },
        { status: 400 }
      );
    }

    const currentVersionCode = parseInt(versionCodeParam, 10);
    if (isNaN(currentVersionCode) || currentVersionCode < 1) {
      return NextResponse.json(
        { error: "Invalid versionCode; must be a positive integer" },
        { status: 400 }
      );
    }

    const result = await checkAppUpdate(currentVersionCode);

    return NextResponse.json(result, {
      headers: {
        "Cache-Control": "no-store, no-cache, must-revalidate",
      },
    });
  } catch (error: any) {
    console.error("GET /api/app/update/check error:", error);
    return NextResponse.json(
      { error: error?.message || "Failed to check for app update" },
      { status: 500 }
    );
  }
}
