import { NextResponse } from "next/server";
import { requireSuperAdmin } from "@/lib/auth/permissions";
import { saveApkFile } from "@/lib/storage/apk_storage";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  try {
    await requireSuperAdmin(req);

    const formData = await req.formData();
    const file = formData.get("file") as File | null;

    if (!file) {
      return NextResponse.json({ error: "No file provided" }, { status: 400 });
    }

    const originalName = file.name || "update.apk";
    if (!originalName.toLowerCase().endsWith(".apk")) {
      return NextResponse.json(
        { error: "Only .apk files are supported for Android app releases" },
        { status: 400 }
      );
    }

    const arrayBuffer = await file.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    // Save APK using storage abstraction (R2 in Cloudflare, filesystem fallback in Node dev/test)
    const result = await saveApkFile(originalName, buffer);

    return NextResponse.json({
      success: true,
      downloadUrl: result.downloadUrl,
      sha256Checksum: result.sha256Checksum,
      fileSizeBytes: result.fileSizeBytes,
      fileName: result.fileName,
    });
  } catch (error: any) {
    if (error.message === "UNAUTHORIZED") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    if (error.message === "FORBIDDEN") {
      return NextResponse.json({ error: "Forbidden: Super Admin access required" }, { status: 403 });
    }
    console.error("POST /api/admin/releases/upload error:", error);
    return NextResponse.json({ error: error?.message || "Failed to upload APK" }, { status: 500 });
  }
}
