import { NextRequest } from "next/server";
import { requirePermission, isSuperAdmin } from "@/lib/auth/permissions";
import { getDashboardOverview } from "@/services/control-room/dashboard_service";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  let user: any;
  try {
    const auth = await requirePermission("LIVE_MAP", req);
    user = auth.user;
  } catch (err: any) {
    if (err.message === "UNAUTHORIZED") {
      return new Response("Unauthorized", { status: 401 });
    }
    return new Response("Forbidden", { status: 403 });
  }

  const scopedAdminId = isSuperAdmin(user) ? null : user.id;
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      try {
        const overview = await getDashboardOverview(false, scopedAdminId);
        const message = `data: ${JSON.stringify(overview)}\n\n`;
        controller.enqueue(encoder.encode(message));
      } catch {
        // Suppress initial send error
      } finally {
        try {
          controller.close();
        } catch {
          // Suppress close error
        }
      }
    },
    cancel() {
      // Stream cancelled
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
