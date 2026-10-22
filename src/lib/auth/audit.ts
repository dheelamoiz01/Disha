import { prisma } from "@/lib/prisma";

type AuditAction =
  | "LOGIN_SUCCESS"
  | "LOGIN_FAILED"
  | "LOGOUT"
  | "SESSION_REVOKED"
  | "DEVICE_REGISTERED"
  | "DEVICE_UPDATED"
  | "DEVICE_SUSPENDED"
  | "DEVICE_REVOKED"
  | "DEVICE_REASSIGNED"
  | "PERSONNEL_CREATED"
  | "PERSONNEL_UPDATED"
  | "PERSONNEL_DEACTIVATED"
  | "PERSONNEL_ASSIGNMENT_CHANGED"
  | "DUTY_STARTED"
  | "DUTY_ENDED"
  | "LOCATION_UNAVAILABLE"
  | "LOCATION_RECOVERED"
  | "NETWORK_LOST"
  | "NETWORK_RESTORED"
  | "SOS_STARTED"
  | "SOS_ENDED"
  | "ALERT_ACKNOWLEDGED"
  | "ALERT_RESOLVED"
  | "SENSITIVE_PERSONNEL_VIEWED"
  | "VIEW_LOCATION_HISTORY"
  | "SENSITIVE_LOCATION_VIEWED"
  | "ROLE_CHANGED"
  | "PERMISSION_CHANGED"
  | "CONFIGURATION_CHANGED"
  | "RETENTION_PURGE_STARTED"
  | "RETENTION_PURGE_COMPLETED"
  | "RETENTION_PURGE_FAILED"
  | "UNAUTHORIZED_ACCESS"
  | "VIEW_DASHBOARD"
  | "LOGIN"
  | "CREATE_ADMIN"
  | "UPDATE_ADMIN"
  | "DELETE_STAFF"
  | "RESET_PASSWORD"
  | "CHANGE_PASSWORD"
  | "CREATE_STAFF"
  | "UPDATE_STAFF"
  | "RESET_STAFF_PASSWORD"
  | "DEVICE_SIGNOUT"
  | "APP_RELEASE_PUBLISHED";

interface AuditLogOptions {
  actorId?: string;
  action: AuditAction;
  targetType?: string;
  targetId?: string;
  metadata?: Record<string, unknown>;
  ipAddress?: string;
  userAgent?: string;
}

export async function logAudit(options: AuditLogOptions) {
  try {
    await prisma.auditLog.create({
      data: {
        actorId: options.actorId,
        action: options.action,
        targetType: options.targetType,
        targetId: options.targetId,
        metadata: options.metadata ? JSON.stringify(options.metadata) : null,
        ipAddress: options.ipAddress || null,
        userAgent: options.userAgent || null,
      },
    });
  } catch (err) {
    // In a real production environment, we should log this to a file or external monitoring system
    console.error("Failed to write audit log:", err);
  }
}
