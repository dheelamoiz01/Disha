import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getApkStream } from "@/lib/storage/apk_storage";

export const dynamic = "force-dynamic";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    let release = await prisma.appRelease.findUnique({
      where: { id },
    });

    // If not found by primary key ID, also check by downloadUrl match
    if (!release) {
      release = await prisma.appRelease.findFirst({
        where: {
          isActive: true,
          downloadUrl: { contains: id },
        },
      });
    }

    if (!release || !release.isActive) {
      return NextResponse.json({ error: "Release not found or inactive" }, { status: 404 });
    }

    // If downloadUrl is an external link (e.g. public R2 URL or CDN), redirect directly
    if (release.downloadUrl.startsWith("http://") || release.downloadUrl.startsWith("https://")) {
      return NextResponse.redirect(release.downloadUrl, 302);
    }

    // Stream from storage abstraction (R2 or filesystem fallback)
    const fileData = await getApkStream(release.downloadUrl);
    if (!fileData) {
      return NextResponse.json({ error: "APK file not found on server or storage bucket" }, { status: 404 });
    }

    const safeFileName = `disha-tracker-v${release.versionName}.apk`.replace(/[^a-zA-Z0-9._-]/g, "_");

    const headers: Record<string, string> = {
      "Content-Type": fileData.contentType || "application/vnd.android.package-archive",
      "Content-Disposition": `attachment; filename="${safeFileName}"`,
      "X-Checksum-Sha256": release.sha256Checksum,
      "Cache-Control": "public, max-age=86400, immutable",
    };

    if (fileData.size != null) {
      headers["Content-Length"] = fileData.size.toString();
    }

    return new Response(fileData.stream, {
      status: 200,
      headers,
    });
  } catch (error: any) {
    console.error("GET /api/app/release/download/[id] error:", error);
    return NextResponse.json({ error: "Failed to download release" }, { status: 500 });
  }
}
