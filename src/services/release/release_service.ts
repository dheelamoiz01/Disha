import { prisma } from "@/lib/prisma";
import { logAudit } from "@/lib/auth/audit";

export interface PublishReleaseInput {
  versionCode: number;
  versionName: string;
  releaseNotes: string;
  downloadUrl: string;
  sha256Checksum: string;
  fileSizeBytes?: number;
  minSupportedVersionCode?: number;
  isMandatory?: boolean;
}

export interface CheckUpdateResult {
  updateAvailable: boolean;
  currentVersionCode: number;
  latestRelease: {
    id: string;
    versionCode: number;
    versionName: string;
    releaseNotes: string;
    downloadUrl: string;
    sha256Checksum: string;
    fileSizeBytes: number | null;
    minSupportedVersionCode: number;
    isMandatory: boolean;
    publishedAt: Date;
  } | null;
}

/**
 * Validates and publishes an in-app OTA update release.
 */
export async function publishRelease(
  input: PublishReleaseInput,
  actorId?: string
) {
  if (!input.versionCode || input.versionCode < 1) {
    throw new Error("versionCode must be a positive integer.");
  }

  if (!input.versionName || input.versionName.trim().length === 0) {
    throw new Error("versionName cannot be empty.");
  }

  if (!input.downloadUrl || input.downloadUrl.trim().length === 0) {
    throw new Error("downloadUrl is required.");
  }

  // Validate SHA-256 format (64-character hexadecimal)
  const normalizedChecksum = input.sha256Checksum.trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(normalizedChecksum)) {
    throw new Error("sha256Checksum must be a 64-character hexadecimal string.");
  }

  const minSupported = Math.max(1, input.minSupportedVersionCode ?? 1);

  // Check if release with this versionCode already exists
  const existing = await prisma.appRelease.findUnique({
    where: { versionCode: input.versionCode },
  });

  let release;
  if (existing) {
    release = await prisma.appRelease.update({
      where: { id: existing.id },
      data: {
        versionName: input.versionName.trim(),
        releaseNotes: input.releaseNotes.trim(),
        downloadUrl: input.downloadUrl.trim(),
        sha256Checksum: normalizedChecksum,
        fileSizeBytes: input.fileSizeBytes ?? null,
        minSupportedVersionCode: minSupported,
        isMandatory: input.isMandatory ?? false,
        isActive: true,
        publishedBy: actorId || null,
        updatedAt: new Date(),
      },
    });
  } else {
    release = await prisma.appRelease.create({
      data: {
        versionCode: input.versionCode,
        versionName: input.versionName.trim(),
        releaseNotes: input.releaseNotes.trim(),
        downloadUrl: input.downloadUrl.trim(),
        sha256Checksum: normalizedChecksum,
        fileSizeBytes: input.fileSizeBytes ?? null,
        minSupportedVersionCode: minSupported,
        isMandatory: input.isMandatory ?? false,
        isActive: true,
        publishedBy: actorId || null,
      },
    });
  }

  await logAudit({
    actorId,
    action: "APP_RELEASE_PUBLISHED",
    targetType: "AppRelease",
    targetId: release.id,
    metadata: {
      versionCode: release.versionCode,
      versionName: release.versionName,
      isMandatory: release.isMandatory,
      sha256Checksum: release.sha256Checksum,
    },
  });

  return release;
}

/**
 * Returns all releases ordered by versionCode descending.
 */
export async function getAllReleases() {
  return prisma.appRelease.findMany({
    orderBy: { versionCode: "desc" },
  });
}

/**
 * Returns the highest versionCode active release.
 */
export async function getLatestActiveRelease() {
  return prisma.appRelease.findFirst({
    where: { isActive: true },
    orderBy: { versionCode: "desc" },
  });
}

/**
 * Evaluates whether an update is available for an app running currentVersionCode.
 */
export async function checkAppUpdate(
  currentVersionCode: number
): Promise<CheckUpdateResult> {
  const latest = await getLatestActiveRelease();

  if (!latest || latest.versionCode <= currentVersionCode) {
    return {
      updateAvailable: false,
      currentVersionCode,
      latestRelease: null,
    };
  }

  // Mandatory if explicitly flagged OR if the device's version is below minimum supported
  const isMandatory =
    latest.isMandatory || currentVersionCode < latest.minSupportedVersionCode;

  return {
    updateAvailable: true,
    currentVersionCode,
    latestRelease: {
      id: latest.id,
      versionCode: latest.versionCode,
      versionName: latest.versionName,
      releaseNotes: latest.releaseNotes,
      downloadUrl: latest.downloadUrl,
      sha256Checksum: latest.sha256Checksum,
      fileSizeBytes: latest.fileSizeBytes,
      minSupportedVersionCode: latest.minSupportedVersionCode,
      isMandatory,
      publishedAt: latest.publishedAt,
    },
  };
}
