import { NextResponse } from "next/server";
import { z } from "zod";
import { requireDeviceAuth } from "@/lib/auth/authorization";
import { singleLocationSchema } from "@/domain/telemetry/validation";
import { ingestSingleLocation, TelemetryError } from "@/services/telemetry/ingestion_service";

export const dynamic = "force-dynamic";
export const maxDuration = 15;

export async function POST(req: Request) {
  try {
    const { device, personnel } = await requireDeviceAuth(req);
    
    const body = await req.json();
    const payload = singleLocationSchema.parse(body);

    const result = await ingestSingleLocation(personnel.id, payload);

    return NextResponse.json(result);
  } catch (error: any) {
    if (error instanceof z.ZodError) {
      console.warn("[Location Telemetry 400] Validation failure:", {
        issues: error.issues.map((i) => ({ path: i.path, code: i.code, message: i.message })),
      });
      return NextResponse.json({ error: "Invalid telemetry payload", code: "VALIDATION_ERROR", details: error.issues }, { status: 400 });
    }
    if (error.message === "UNAUTHORIZED") return NextResponse.json({ error: "Unauthorized", code: "UNAUTHORIZED" }, { status: 401 });
    if (error instanceof TelemetryError) {
      console.warn("[Location Telemetry 400] Telemetry error:", { code: error.code, message: error.message });
      return NextResponse.json({ error: error.message, code: error.code }, { status: 400 });
    }
    
    console.error("Telemetry Ingestion Error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
