import { NextResponse } from "next/server";
import { z } from "zod";
import { requirePermission, isSuperAdmin } from "@/lib/auth/permissions";
import { prisma } from "@/lib/prisma";
import { hashPassword } from "@/lib/auth/password";
import { UserRole, UserStatus } from "../../../../generated/prisma/enums";
import { logAudit } from "@/lib/auth/audit";

import { fetchStaffList } from "@/services/staff/staff_service";

const createStaffSchema = z.object({
  name: z.string().min(2, "Staff name must be at least 2 characters").max(100),
  username: z.string().min(3, "Login ID must be at least 3 characters").max(50).regex(/^[a-zA-Z0-9_.-]+$/, "Username can only contain alphanumeric characters, dots, underscores, and dashes"),
  password: z.string().min(8, "Password must be at least 8 characters long"),
  personnelCode: z.string().max(50).optional().nullable(),
  designation: z.string().max(100).optional().nullable(),
  unit: z.string().max(100).optional().nullable(),
  phone: z.string().max(20).optional().nullable(),
  status: z.enum(["ACTIVE", "INACTIVE"]).default("ACTIVE"),
});

export async function GET(req: Request) {
  try {
    const { user } = await requirePermission("STAFF_MANAGEMENT", req);
    const scopedAdminId = isSuperAdmin(user) ? null : user.id;
    const staff = await fetchStaffList(scopedAdminId);
    return NextResponse.json({ staff });
  } catch (error: any) {
    if (error.message === "UNAUTHORIZED") return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    if (error.message === "FORBIDDEN") return NextResponse.json({ error: "Forbidden: Staff Management permission required" }, { status: 403 });
    console.error("GET /api/staff error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const { user: currentAdmin } = await requirePermission("STAFF_MANAGEMENT", req);

    const body = await req.json();
    const data = createStaffSchema.parse(body);

    const normalizedUsername = data.username.toLowerCase();

    // Check if username already exists
    const existingUser = await prisma.user.findUnique({
      where: { username: normalizedUsername },
    });

    if (existingUser) {
      return NextResponse.json({ error: "Login ID already taken. Please choose another." }, { status: 400 });
    }

    const finalPersonnelCode = (data.personnelCode?.trim() || normalizedUsername.toUpperCase()).trim();

    // Check if personnelCode already exists
    const existingPersonnelCode = await prisma.personnel.findUnique({
      where: { personnelCode: finalPersonnelCode },
    });

    if (existingPersonnelCode) {
      return NextResponse.json({ error: "Personnel code / Badge ID already in use." }, { status: 400 });
    }

    const passwordHash = await hashPassword(data.password);
    const userStatus = data.status === "ACTIVE" ? UserStatus.ACTIVE : UserStatus.INACTIVE;

    // Create User and linked Personnel atomically
    const newUser = await prisma.user.create({
      data: {
        username: normalizedUsername,
        displayName: data.name,
        passwordHash,
        role: UserRole.FIELD_PERSONNEL,
        status: userStatus,
        permissions: "[]",
        mustChangePassword: false,
        personnel: {
          create: {
            personnelCode: finalPersonnelCode,
            name: data.name,
            designation: data.designation || null,
            unit: data.unit || null,
            phone: data.phone || null,
            active: data.status === "ACTIVE",
            adminId: currentAdmin.id,
          },
        },
      },
      include: {
        personnel: true,
      },
    });

    await logAudit({
      actorId: currentAdmin.id,
      action: "CREATE_STAFF",
      targetType: "Personnel",
      targetId: newUser.personnel!.id,
      metadata: { username: newUser.username, personnelCode: data.personnelCode },
    });

    return NextResponse.json({
      success: true,
      staff: {
        id: newUser.personnel!.id,
        userId: newUser.id,
        adminId: newUser.personnel!.adminId,
        username: newUser.username,
        name: newUser.personnel!.name,
        personnelCode: newUser.personnel!.personnelCode,
        designation: newUser.personnel!.designation,
        unit: newUser.personnel!.unit,
        phone: newUser.personnel!.phone,
        active: newUser.personnel!.active,
        status: newUser.status,
        createdAt: newUser.personnel!.createdAt,
      },
    });
  } catch (error: any) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: error.issues[0]?.message || "Invalid input" }, { status: 400 });
    }
    if (error.message === "UNAUTHORIZED") return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    if (error.message === "FORBIDDEN") return NextResponse.json({ error: "Forbidden: Staff Management permission required" }, { status: 403 });
    console.error("POST /api/staff error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
