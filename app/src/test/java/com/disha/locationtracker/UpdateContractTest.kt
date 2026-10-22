package com.disha.locationtracker

import com.disha.locationtracker.update.ReleaseInfo
import com.disha.locationtracker.update.UpdateCheckResponse
import com.google.gson.Gson
import org.junit.Assert.*
import org.junit.Test

class UpdateContractTest {

    private val gson = Gson()

    @Test
    fun testUpdateCheckResponseDeserialization() {
        val json = """
            {
                "updateAvailable": true,
                "currentVersionCode": 1,
                "latestRelease": {
                    "id": "rel-abc-123",
                    "versionCode": 2,
                    "versionName": "2.1.0",
                    "releaseNotes": "• 24x7 tracking enabled\n• 10-second telemetry",
                    "downloadUrl": "/downloads/apk/disha-tracker.apk",
                    "sha256Checksum": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
                    "fileSizeBytes": 10485760,
                    "minSupportedVersionCode": 1,
                    "isMandatory": false,
                    "publishedAt": "2026-10-22T20:00:00.000Z"
                }
            }
        """.trimIndent()

        val parsed = gson.fromJson(json, UpdateCheckResponse::class.java)
        assertTrue(parsed.updateAvailable)
        assertEquals(1, parsed.currentVersionCode)
        assertNotNull(parsed.latestRelease)

        val release = parsed.latestRelease!!
        assertEquals("rel-abc-123", release.id)
        assertEquals(2, release.versionCode)
        assertEquals("2.1.0", release.versionName)
        assertEquals("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855", release.sha256Checksum)
        assertEquals(10485760L, release.fileSizeBytes)
        assertFalse(release.isMandatory)
    }

    @Test
    fun testMandatoryUpdateEvaluation() {
        // Case 1: Flagged as mandatory by admin
        val mandatoryRelease = ReleaseInfo(
            id = "rel-1",
            versionCode = 5,
            versionName = "2.0.0",
            releaseNotes = "Security fix",
            downloadUrl = "/downloads/apk/app.apk",
            sha256Checksum = "a".repeat(64),
            fileSizeBytes = 5000000L,
            minSupportedVersionCode = 1,
            isMandatory = true,
            publishedAt = null
        )
        assertTrue(mandatoryRelease.isMandatory)

        // Case 2: Version below minSupportedVersionCode
        val minSupportedRelease = ReleaseInfo(
            id = "rel-2",
            versionCode = 5,
            versionName = "2.0.0",
            releaseNotes = "Standard release",
            downloadUrl = "/downloads/apk/app.apk",
            sha256Checksum = "b".repeat(64),
            fileSizeBytes = 5000000L,
            minSupportedVersionCode = 3,
            isMandatory = false,
            publishedAt = null
        )
        val currentDeviceCode = 2
        val isEffectiveMandatory = minSupportedRelease.isMandatory || currentDeviceCode < minSupportedRelease.minSupportedVersionCode
        assertTrue(isEffectiveMandatory)

        // Case 3: Version at or above minSupportedVersionCode with isMandatory=false
        val updatedDeviceCode = 3
        val isNotMandatory = minSupportedRelease.isMandatory || updatedDeviceCode < minSupportedRelease.minSupportedVersionCode
        assertFalse(isNotMandatory)
    }

    @Test
    fun testSha256ChecksumValidation() {
        val validChecksum = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        val regex = Regex("^[a-fA-F0-9]{64}$")
        assertTrue(regex.matches(validChecksum))

        val invalidLength = "e3b0c44298fc1c149afbf4c8996fb92427"
        assertFalse(regex.matches(invalidLength))

        val invalidChars = "g3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b85z"
        assertFalse(regex.matches(invalidChars))
    }
}
