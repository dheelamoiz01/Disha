import { NextResponse } from "next/server";
import { z } from "zod";
import { requireSuperAdmin } from "@/lib/auth/permissions";
import {
  publishRelease,
  getAllReleases,
} from "@/services/release/release_service";

const publishReleaseSchema = z.object({
  versionCode: z.coerce.number().int().positive("Version code must be a positive integer"),
  versionName: z.string().min(1, "Version name cannot be empty"),
  releaseNotes: z.string().min(1, "Release notes cannot be empty"),
  downloadUrl: z.string().min(1, "Download URL is required"),
  sha256Checksum: z.string().regex(/^[a-fA-F0-9]{64}$/, "SHA-256 must be a 64-character hexadecimal hash"),
  fileSizeBytes: z.coerce.number().int().positive().optional(),
  minSupportedVersionCode: z.coerce.number().int().positive().optional(),
  isMandatory: z.boolean().default(false),
});

export async function GET(req: Request) {
  try {
    await requireSuperAdmin(req);
    const releases = await getAllReleases();
    return NextResponse.json({ releases });
  } catch (error: any) {
    if (error.message === "UNAUTHORIZED") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    if (error.message === "FORBIDDEN") {
      return NextResponse.json({ error: "Forbidden: Super Admin access required" }, { status: 403 });
    }
    console.error("GET /api/admin/releases error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const { user } = await requireSuperAdmin(req);
    const body = await req.json();
    const data = publishReleaseSchema.parse(body);

    const release = await publishRelease(data, user.id);
    return NextResponse.json({
      success: true,
      message: `Release v${release.versionName} (code ${release.versionCode}) published successfully`,
      release,
    });
  } catch (error: any) {
    if (error.message === "UNAUTHORIZED") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    if (error.message === "FORBIDDEN") {
      return NextResponse.json({ error: "Forbidden: Super Admin access required" }, { status: 403 });
    }
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: error.issues[0]?.message || "Validation failed" }, { status: 400 });
    }
    console.error("POST /api/admin/releases error:", error);
    return NextResponse.json({ error: error?.message || "Failed to publish release" }, { status: 500 });
  }
}
