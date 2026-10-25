import { tursoBudgetTracker } from "@/lib/turso/budget";
import { invalidateDeviceAuthorizationCache } from "@/services/telemetry/ingestion_service";
import { invalidateDashboardCache } from "@/services/control-room/dashboard_service";
import { prisma } from "@/lib/prisma";
import { DutyStatus, DeviceStatus } from "../../../generated/prisma/enums";
import { DutyStates, canStartDuty, canEndDuty } from "@/domain/duty/duty_state_machine";
import { logAudit } from "@/lib/auth/audit";

export class DutyError extends Error {
  constructor(message: string, public code: string) {
    super(message);
    this.name = "DutyError";
  }
}

export async function getActiveDutySession(personnelId: string) {
  return await prisma.dutySession.findFirst({
    where: {
      personnelId,
      endedAt: null,
    },
  });
}

export async function startDuty(personnelId: string, deviceIdentifier: string, actorId: string) {
  // Validate Device
  const device = await prisma.device.findUnique({
    where: { deviceIdentifier },
  });

  if (!device) {
    throw new DutyError("Device not found.", "DEVICE_NOT_FOUND");
  }

  if (device.personnelId !== personnelId) {
    throw new DutyError("Device is not assigned to this personnel.", "DEVICE_MISMATCH");
  }

  if (device.status !== DeviceStatus.ACTIVE) {
    throw new DutyError(`Device is ${device.status}, cannot start duty.`, "DEVICE_INACTIVE");
  }

  // Check current state
  const activeSession = await getActiveDutySession(personnelId);
  if (activeSession) {
    // Check if the state machine allows starting (it shouldn't)
    if (!canStartDuty(activeSession.status as any)) {
      throw new DutyError("Personnel already has an active duty session.", "ALREADY_ON_DUTY");
    }
  }

  // Attempt creation (Protected by DB unique partial index against concurrent starts)
  try {
    tursoBudgetTracker.recordWrite("attendance_sessions", 1);
    const session = await prisma.dutySession.create({
      data: {
        personnelId,
        deviceId: device.id,
        status: DutyStatus.DUTY_STARTED,
        startedAt: new Date(),
      },
    });

    await logAudit({
      actorId,
      action: "DUTY_STARTED",
      targetType: "DutySession",
      targetId: session.id,
      metadata: { personnelId, deviceId: device.id },
    });

    invalidateDeviceAuthorizationCache(personnelId);
    invalidateDashboardCache();
    return session;
  } catch (error: unknown) {
    // Unique constraint violation in SQLite (e.g. from our partial index)
    if ((error as any)?.message?.includes("UNIQUE constraint failed") || (error as any)?.code === "P2002") {
      throw new DutyError("Personnel already has an active duty session (Concurrent).", "ALREADY_ON_DUTY");
    }
    throw error;
  }
}

export async function endDuty(personnelId: string, actorId: string) {
  const activeSession = await getActiveDutySession(personnelId);

  if (!activeSession) {
    throw new DutyError("No active duty session to end.", "NOT_ON_DUTY");
  }

  if (!canEndDuty(activeSession.status as any)) {
    throw new DutyError(`Cannot end duty from state ${activeSession.status}.`, "INVALID_TRANSITION");
  }

  tursoBudgetTracker.recordWrite("attendance_sessions", 1);
  const endedSession = await prisma.dutySession.update({
    where: { id: activeSession.id },
    data: {
      status: DutyStatus.DUTY_ENDED,
      endedAt: new Date(),
    },
  });

  await logAudit({
    actorId,
    action: "DUTY_ENDED",
    targetType: "DutySession",
    targetId: endedSession.id,
    metadata: { personnelId },
  });

  invalidateDeviceAuthorizationCache(personnelId);
    invalidateDashboardCache();
    return endedSession;
}
