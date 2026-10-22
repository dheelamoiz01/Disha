import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import fs from "fs";
import path from "path";

export const dynamic = "force-dynamic";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const release = await prisma.appRelease.findUnique({
      where: { id },
    });

    if (!release || !release.isActive) {
      return NextResponse.json({ error: "Release not found or inactive" }, { status: 404 });
    }

    // If downloadUrl is an external link, redirect directly
    if (release.downloadUrl.startsWith("http://") || release.downloadUrl.startsWith("https://")) {
      return NextResponse.redirect(release.downloadUrl, 302);
    }

    // If relative path inside public/
    const relativeClean = release.downloadUrl.startsWith("/")
      ? release.downloadUrl.substring(1)
      : release.downloadUrl;
    const localFilePath = path.join(process.cwd(), "public", relativeClean);

    if (!fs.existsSync(localFilePath)) {
      return NextResponse.json({ error: "APK file not found on server" }, { status: 404 });
    }

    const stat = await fs.promises.stat(localFilePath);
    const fileStream = fs.createReadStream(localFilePath);

    // Convert node ReadStream to web ReadableStream
    const webStream = new ReadableStream({
      start(controller) {
        fileStream.on("data", (chunk) => controller.enqueue(chunk));
        fileStream.on("end", () => controller.close());
        fileStream.on("error", (err) => controller.error(err));
      },
    });

    const safeFileName = `disha-tracker-v${release.versionName}.apk`.replace(/[^a-zA-Z0-9._-]/g, "_");

    return new Response(webStream, {
      status: 200,
      headers: {
        "Content-Type": "application/vnd.android.package-archive",
        "Content-Disposition": `attachment; filename="${safeFileName}"`,
        "Content-Length": stat.size.toString(),
        "X-Checksum-Sha256": release.sha256Checksum,
        "Cache-Control": "public, max-age=86400, immutable",
      },
    });
  } catch (error: any) {
    console.error("GET /api/app/release/download/[id] error:", error);
    return NextResponse.json({ error: "Failed to download release" }, { status: 500 });
  }
}
