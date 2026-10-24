import { NextRequest } from "next/server";
import { requirePermission } from "@/lib/auth/permissions";
import { getDashboardOverview } from "@/services/control-room/dashboard_service";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    await requirePermission("LIVE_MAP", req);
  } catch (err: any) {
    if (err.message === "UNAUTHORIZED") {
      return new Response("Unauthorized", { status: 401 });
    }
    return new Response("Forbidden", { status: 403 });
  }

  const encoder = new TextEncoder();
  let intervalId: NodeJS.Timeout | null = null;
  let isClosed = false;

  const stream = new ReadableStream({
    async start(controller) {
      const sendOverview = async () => {
        if (isClosed) return;
        try {
          const overview = await getDashboardOverview();
          const message = `data: ${JSON.stringify(overview)}\n\n`;
          controller.enqueue(encoder.encode(message));
        } catch {
          // If controller is already closed, suppress
        }
      };

      // Send initial overview immediately upon connection
      await sendOverview();

      // Stream updates every 10 seconds
      intervalId = setInterval(async () => {
        if (isClosed) {
          if (intervalId) clearInterval(intervalId);
          return;
        }
        await sendOverview();
      }, 10000);

      req.signal.addEventListener("abort", () => {
        isClosed = true;
        if (intervalId) clearInterval(intervalId);
        try {
          controller.close();
        } catch {
          // Suppress close error
        }
      });
    },
    cancel() {
      isClosed = true;
      if (intervalId) clearInterval(intervalId);
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
