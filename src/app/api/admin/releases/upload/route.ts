import { NextResponse } from "next/server";
import { requireSuperAdmin } from "@/lib/auth/permissions";
import crypto from "crypto";
import fs from "fs";
import path from "path";

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

    // Calculate SHA-256 hash of the uploaded APK
    const sha256Checksum = crypto.createHash("sha256").update(buffer).digest("hex").toLowerCase();
    const fileSizeBytes = buffer.length;

    // Sanitize filename and create unique storage path
    const safeBaseName = originalName.replace(/[^a-zA-Z0-9._-]/g, "_");
    const uniqueFileName = `${Date.now()}_${safeBaseName}`;
    
    const targetDir = path.join(process.cwd(), "public", "downloads", "apk");
    await fs.promises.mkdir(targetDir, { recursive: true });

    const filePath = path.join(targetDir, uniqueFileName);
    await fs.promises.writeFile(filePath, buffer);

    const downloadUrl = `/downloads/apk/${uniqueFileName}`;

    return NextResponse.json({
      success: true,
      downloadUrl,
      sha256Checksum,
      fileSizeBytes,
      fileName: originalName,
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
