import { prisma } from "@/lib/prisma";
import { AlertStatus } from "../../../generated/prisma/enums";
import { logAudit } from "@/lib/auth/audit";

export class AlertError extends Error {
  constructor(message: string, public code: string) {
    super(message);
    this.name = "AlertError";
  }
}

export async function acknowledgeAlert(alertId: string, actorId: string, isSuper: boolean = false) {
  const alert = await prisma.alert.findUnique({
    where: { id: alertId },
    include: { personnel: { select: { adminId: true } } },
  });

  if (!alert) {
    throw new AlertError("Alert not found.", "NOT_FOUND");
  }

  if (!isSuper && alert.personnel?.adminId && alert.personnel.adminId !== actorId) {
    throw new AlertError("Alert not found or access denied.", "NOT_FOUND");
  }

  if (alert.status === AlertStatus.RESOLVED) {
    throw new AlertError("Alert is already resolved.", "ALREADY_RESOLVED");
  }

  if (alert.status === AlertStatus.ACKNOWLEDGED) {
    return { status: "already_acknowledged", alertId: alert.id };
  }

  await prisma.alert.update({
    where: { id: alertId },
    data: {
      status: AlertStatus.ACKNOWLEDGED,
      acknowledgedAt: new Date(),
      acknowledgedBy: actorId,
    },
  });

  await logAudit({
    actorId,
    action: "ALERT_ACKNOWLEDGED",
    targetType: "Alert",
    targetId: alert.id,
  });

  return { status: "acknowledged", alertId: alert.id };
}

export async function resolveAlert(alertId: string, actorId: string, isSuper: boolean = false) {
  const alert = await prisma.alert.findUnique({
    where: { id: alertId },
    include: { personnel: { select: { adminId: true } } },
  });

  if (!alert) {
    throw new AlertError("Alert not found.", "NOT_FOUND");
  }

  if (!isSuper && alert.personnel?.adminId && alert.personnel.adminId !== actorId) {
    throw new AlertError("Alert not found or access denied.", "NOT_FOUND");
  }

  if (alert.status === AlertStatus.RESOLVED) {
    return { status: "already_resolved", alertId: alert.id };
  }

  await prisma.alert.update({
    where: { id: alertId },
    data: {
      status: AlertStatus.RESOLVED,
      resolvedAt: new Date(),
      resolvedBy: actorId,
    },
  });

  await logAudit({
    actorId,
    action: "ALERT_RESOLVED",
    targetType: "Alert",
    targetId: alert.id,
  });

  return { status: "resolved", alertId: alert.id };
}
