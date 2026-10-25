import { NextResponse } from "next/server";
import { z } from "zod";
import { requirePermission, isSuperAdmin } from "@/lib/auth/permissions";
import { prisma } from "@/lib/prisma";
import { UserStatus } from "../../../../../generated/prisma/enums";
import { logAudit } from "@/lib/auth/audit";

const updateStaffSchema = z.object({
  name: z.string().min(2, "Staff name must be at least 2 characters").max(100).optional(),
  personnelCode: z.string().min(2).max(50).optional(),
  designation: z.string().max(100).optional().nullable(),
  unit: z.string().max(100).optional().nullable(),
  phone: z.string().max(20).optional().nullable(),
  active: z.boolean().optional(),
});

export async function PATCH(req: Request, props: { params: Promise<{ id: string }> }) {
  try {
    const { user: currentAdmin } = await requirePermission("STAFF_MANAGEMENT", req);
    const params = await props.params;
    const staffId = params.id;

    const body = await req.json();
    const data = updateStaffSchema.parse(body);

    const personnel = await prisma.personnel.findUnique({
      where: { id: staffId },
      include: { user: true },
    });

    if (!personnel) {
      return NextResponse.json({ error: "Staff record not found" }, { status: 404 });
    }

    // Ownership check: regular admin can only modify their own staff
    if (!isSuperAdmin(currentAdmin) && personnel.adminId !== currentAdmin.id) {
      return NextResponse.json({ error: "Staff record not found or access denied" }, { status: 404 });
    }

    // Check personnelCode conflict if changed
    if (data.personnelCode && data.personnelCode !== personnel.personnelCode) {
      const existing = await prisma.personnel.findUnique({
        where: { personnelCode: data.personnelCode },
      });
      if (existing) {
        return NextResponse.json({ error: "Personnel code / Badge ID already in use." }, { status: 400 });
      }
    }

    const personnelUpdate: any = {};
    if (data.name !== undefined) personnelUpdate.name = data.name;
    if (data.personnelCode !== undefined) personnelUpdate.personnelCode = data.personnelCode;
    if (data.designation !== undefined) personnelUpdate.designation = data.designation;
    if (data.unit !== undefined) personnelUpdate.unit = data.unit;
    if (data.phone !== undefined) personnelUpdate.phone = data.phone;
    if (data.active !== undefined) personnelUpdate.active = data.active;

    const userUpdate: any = {};
    if (data.name !== undefined) userUpdate.displayName = data.name;
    if (data.active !== undefined) {
      userUpdate.status = data.active ? UserStatus.ACTIVE : UserStatus.INACTIVE;
    }

    const [updatedPersonnel, updatedUser] = await prisma.$transaction([
      prisma.personnel.update({
        where: { id: staffId },
        data: personnelUpdate,
      }),
      prisma.user.update({
        where: { id: personnel.userId },
        data: userUpdate,
      }),
    ]);

    await logAudit({
      actorId: currentAdmin.id,
      action: "UPDATE_STAFF",
      targetType: "Personnel",
      targetId: staffId,
      metadata: data,
    });

    return NextResponse.json({
      success: true,
      staff: {
        id: updatedPersonnel.id,
        userId: updatedUser.id,
        username: updatedUser.username,
        name: updatedPersonnel.name,
        personnelCode: updatedPersonnel.personnelCode,
        designation: updatedPersonnel.designation,
        unit: updatedPersonnel.unit,
        phone: updatedPersonnel.phone,
        active: updatedPersonnel.active,
        status: updatedUser.status,
        updatedAt: updatedPersonnel.updatedAt,
      },
    });
  } catch (error: any) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: error.issues[0]?.message || "Invalid input" }, { status: 400 });
    }
    if (error.message === "UNAUTHORIZED") return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    if (error.message === "FORBIDDEN") return NextResponse.json({ error: "Forbidden: Staff Management permission required" }, { status: 403 });
    console.error("PATCH /api/staff/[id] error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

export async function DELETE(req: Request, props: { params: Promise<{ id: string }> }) {
  try {
    const { user: currentAdmin } = await requirePermission("STAFF_MANAGEMENT", req);
    const params = await props.params;
    const staffId = params.id;

    const personnel = await prisma.personnel.findUnique({
      where: { id: staffId },
      include: { user: true, devices: true },
    });

    if (!personnel) {
      return NextResponse.json({ error: "Staff record not found" }, { status: 404 });
    }

    // Ownership check: regular admin can only modify their own staff
    if (!isSuperAdmin(currentAdmin) && personnel.adminId !== currentAdmin.id) {
      return NextResponse.json({ error: "Staff record not found or access denied" }, { status: 404 });
    }

    const deviceIds = personnel.devices.map((d) => d.id);

    await prisma.$transaction(async (tx) => {
      // 1. Delete credentials for all linked devices
      if (deviceIds.length > 0) {
        await tx.deviceCredential.deleteMany({
          where: { deviceId: { in: deviceIds } },
        });
      }

      // 2. Clear foreign key references on alerts if acknowledged/resolved by this user
      await tx.alert.updateMany({
        where: { acknowledgedBy: personnel.userId },
        data: { acknowledgedBy: null },
      });
      await tx.alert.updateMany({
        where: { resolvedBy: personnel.userId },
        data: { resolvedBy: null },
      });

      // 3. Delete personnel-linked records
      await tx.location.deleteMany({ where: { personnelId: staffId } });
      await tx.locationEvent.deleteMany({ where: { personnelId: staffId } });
      await tx.heartbeat.deleteMany({ where: { personnelId: staffId } });
      await tx.alert.deleteMany({ where: { personnelId: staffId } });
      await tx.sOSEvent.deleteMany({ where: { personnelId: staffId } });
      await tx.dutySession.deleteMany({ where: { personnelId: staffId } });

      // 4. Delete devices
      if (deviceIds.length > 0) {
        await tx.device.deleteMany({ where: { id: { in: deviceIds } } });
      }

      // 5. Delete personnel profile
      await tx.personnel.delete({ where: { id: staffId } });

      // 6. Delete user sessions
      await tx.session.deleteMany({ where: { userId: personnel.userId } });

      // 7. Delete user account
      await tx.user.delete({ where: { id: personnel.userId } });
    });

    await logAudit({
      actorId: currentAdmin.id,
      action: "DELETE_STAFF",
      targetType: "Personnel",
      targetId: staffId,
      metadata: { username: personnel.user.username, name: personnel.name },
    });

    return NextResponse.json({
      success: true,
      message: `Staff member ${personnel.name} deleted successfully.`,
    });
  } catch (error: any) {
    if (error.message === "UNAUTHORIZED") return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    if (error.message === "FORBIDDEN") return NextResponse.json({ error: "Forbidden: Staff Management permission required" }, { status: 403 });
    console.error("DELETE /api/staff/[id] error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
