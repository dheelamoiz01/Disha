import { invalidateActiveSOSCache } from "@/services/telemetry/ingestion_service";
import { invalidateDashboardCache } from "@/services/control-room/dashboard_service";
import { prisma } from "@/lib/prisma";
import { SOSStatus, AlertType, AlertSeverity, AlertStatus } from "../../../generated/prisma/enums";
import { validateDeviceAuthorization } from "@/services/telemetry/ingestion_service";
import { logAudit } from "@/lib/auth/audit";

export class SOSError extends Error {
  constructor(message: string, public code: string) {
    super(message);
    this.name = "SOSError";
  }
}

export async function getActiveSOSEvent(personnelId: string) {
  return await prisma.sOSEvent.findFirst({
    where: {
      personnelId,
      endedAt: null,
      status: SOSStatus.ACTIVE,
    },
  });
}

export async function startSOS(personnelId: string, clientEventId: string, actorId: string) {
  const { device, session } = await validateDeviceAuthorization(personnelId);

  // Check if there is already an active SOS for this personnel
  const activeSOS = await getActiveSOSEvent(personnelId);
  if (activeSOS) {
    return { status: "deduplicated", sosEventId: activeSOS.id };
  }

  // Attempt creation atomically using transaction
  try {
    const result = await prisma.$transaction(async (tx) => {
      // Create SOS
      const sosEvent = await tx.sOSEvent.create({
        data: {
          clientEventId,
          personnelId,
          deviceId: device.id,
          dutySessionId: session?.id ?? null,
          status: SOSStatus.ACTIVE,
          startedAt: new Date(),
        },
      });

      // Create Alert explicitly tied to this SOS
      const alert = await tx.alert.create({
        data: {
          type: AlertType.SOS,
          severity: AlertSeverity.CRITICAL,
          personnelId,
          dutySessionId: session?.id ?? null,
          sosEventId: sosEvent.id,
          message: "SOS Activated by Field Personnel",
          status: AlertStatus.ACTIVE,
        },
      });

      return { sosEvent, alert };
    });

    await logAudit({
      actorId,
      action: "SOS_STARTED",
      targetType: "SOSEvent",
      targetId: result.sosEvent.id,
      metadata: { personnelId, dutySessionId: session?.id, alertId: result.alert.id },
    });

    invalidateActiveSOSCache(personnelId);
    invalidateDashboardCache();
    return { status: "accepted", sosEventId: result.sosEvent.id };
  } catch (error: unknown) {
    if ((error as any)?.message?.includes("UNIQUE constraint failed") || (error as any)?.code === "P2002") {
      const existingByClient = await prisma.sOSEvent.findUnique({ where: { clientEventId } });
      if (existingByClient) {
         return { status: "deduplicated", sosEventId: existingByClient.id };
      }
      
      const existingActive = await getActiveSOSEvent(personnelId);
      if (existingActive) {
         return { status: "deduplicated", sosEventId: existingActive.id };
      }
    }
    throw error;
  }
}

export async function endSOS(personnelId: string, clientEventId: string, actorId: string) {
  const { session } = await validateDeviceAuthorization(personnelId);

  const activeSOS = await getActiveSOSEvent(personnelId);

  if (!activeSOS) {
    throw new SOSError("No active SOS event found.", "NO_ACTIVE_SOS");
  }

  const endedSOS = await prisma.sOSEvent.update({
    where: { id: activeSOS.id },
    data: {
      status: SOSStatus.RESOLVED,
      endedAt: new Date(),
    },
  });

  await logAudit({
    actorId,
    action: "SOS_ENDED",
    targetType: "SOSEvent",
    targetId: endedSOS.id,
    metadata: { personnelId, dutySessionId: session?.id },
  });

  return { status: "resolved", sosEventId: endedSOS.id };
}
