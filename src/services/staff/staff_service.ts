import { prisma } from "@/lib/prisma";
import { getHeartbeatTimeoutMs } from "@/lib/config/inactivity";

export async function fetchStaffList(scopedAdminId?: string | null) {
  const now = Date.now();
  const timeoutMs = getHeartbeatTimeoutMs();

  // Single efficient query selecting only required columns and scoped to owning admin if not superadmin
  const staffList = await prisma.personnel.findMany({
    where: scopedAdminId ? { adminId: scopedAdminId } : undefined,
    include: {
      user: {
        select: {
          id: true,
          username: true,
          displayName: true,
          role: true,
          status: true,
          mustChangePassword: true,
          createdAt: true,
          updatedAt: true,
        },
      },
      devices: {
        orderBy: { registeredAt: "desc" },
        take: 1,
        select: {
          id: true,
          deviceIdentifier: true,
          platform: true,
          status: true,
          lastSeenAt: true,
          lastHeartbeatAt: true,
          latestLocationTime: true,
        },
      },
      dutySessions: {
        where: { endedAt: null },
        take: 1,
        select: {
          id: true,
          status: true,
          startedAt: true,
        },
      },
      admin: {
        select: {
          id: true,
          username: true,
          displayName: true,
          role: true,
        },
      },
    },
    orderBy: { createdAt: "desc" },
    take: 500,
  });

  return staffList.map((p) => {
    const dev = p.devices[0] || null;

    const hbTime = dev?.lastHeartbeatAt ? new Date(dev.lastHeartbeatAt).getTime() : 0;
    const locTime = dev?.latestLocationTime ? new Date(dev.latestLocationTime).getTime() : 0;
    const devSeenTime = dev?.lastSeenAt ? new Date(dev.lastSeenAt).getTime() : 0;
    const lastActiveTime = Math.max(hbTime, locTime, devSeenTime);

    let connectionStatus: "ONLINE" | "OFFLINE" = "OFFLINE";
    if (dev && dev.status === "ACTIVE" && lastActiveTime > 0) {
      const diff = now - lastActiveTime;
      if (diff <= timeoutMs) {
        connectionStatus = "ONLINE";
      }
    }

    return {
      id: p.id,
      userId: p.userId,
      adminId: p.adminId,
      username: p.user.username,
      name: p.name,
      personnelCode: p.personnelCode,
      designation: p.designation,
      unit: p.unit,
      phone: p.phone,
      active: p.active,
      status: p.user.status as "ACTIVE" | "INACTIVE",
      connectionStatus,
      lastSeenAt: lastActiveTime > 0 ? new Date(lastActiveTime).toISOString() : null,
      mustChangePassword: p.user.mustChangePassword,
      device: dev
        ? {
            id: dev.id,
            deviceIdentifier: dev.deviceIdentifier,
            platform: dev.platform,
            status: dev.status,
            connectionStatus,
            lastSeenAt: lastActiveTime > 0 ? new Date(lastActiveTime).toISOString() : null,
          }
        : null,
      activeDuty: p.dutySessions[0]
        ? {
            id: p.dutySessions[0].id,
            status: p.dutySessions[0].status,
            startedAt: p.dutySessions[0].startedAt.toISOString(),
          }
        : null,
      admin: p.admin
        ? {
            id: p.admin.id,
            username: p.admin.username,
            displayName: p.admin.displayName || p.admin.username,
            role: p.admin.role,
          }
        : null,
      createdAt: p.createdAt.toISOString(),
      updatedAt: p.updatedAt.toISOString(),
    };
  });
}
