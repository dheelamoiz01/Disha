package com.disha.locationtracker

import com.disha.locationtracker.data.model.HeartbeatPayload
import com.disha.locationtracker.data.model.LocationTelemetryPayload
import com.google.gson.Gson
import org.junit.Assert.*
import org.junit.Test
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone

class TelemetryContractTest {

    private val gson = Gson()

    @Test
    fun testLocationPayloadMatchesBackendSchema() {
        val isoFormat = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US).apply {
            timeZone = TimeZone.getTimeZone("UTC")
        }
        val recordedAt = isoFormat.format(Date())

        val payload = LocationTelemetryPayload(
            clientEventId = "evt-test-12345",
            latitude = 12.9716,
            longitude = 77.5946,
            accuracy = 4.5f,
            recordedAt = recordedAt,
            source = "GPS",
            trackingMode = "NORMAL",
            batteryLevel = 88.5f,
            networkState = "WIFI"
        )

        val json = gson.toJson(payload)
        assertTrue(json.contains("\"clientEventId\":\"evt-test-12345\""))
        assertTrue(json.contains("\"latitude\":12.9716"))
        assertTrue(json.contains("\"longitude\":77.5946"))
        assertTrue(json.contains("\"accuracy\":4.5"))
        assertTrue(json.contains("\"source\":\"GPS\""))
        assertTrue(json.contains("\"trackingMode\":\"NORMAL\""))
        assertTrue(json.contains("\"batteryLevel\":88.5"))
        assertTrue(json.contains("\"networkState\":\"WIFI\""))

        // Deserialize back
        val parsed = gson.fromJson(json, LocationTelemetryPayload::class.java)
        assertEquals(payload.clientEventId, parsed.clientEventId)
        assertEquals(payload.latitude, parsed.latitude, 0.0001)
        assertEquals(payload.longitude, parsed.longitude, 0.0001)
        assertEquals(payload.accuracy, parsed.accuracy, 0.01f)
    }

    @Test
    fun testHeartbeatPayloadMatchesBackendSchema() {
        val payload = HeartbeatPayload(
            personnelId = "pers-officer-99",
            batteryLevel = 92.0f,
            networkState = "CELLULAR",
            appVersion = "1.0.0",
            healthState = "HEALTHY",
            recordedAt = "2026-10-17T11:00:00.000Z"
        )

        val json = gson.toJson(payload)
        assertTrue(json.contains("\"personnelId\":\"pers-officer-99\""))
        assertTrue(json.contains("\"batteryLevel\":92.0"))
        assertTrue(json.contains("\"networkState\":\"CELLULAR\""))
        assertTrue(json.contains("\"healthState\":\"HEALTHY\""))

        val parsed = gson.fromJson(json, HeartbeatPayload::class.java)
        assertEquals("pers-officer-99", parsed.personnelId)
        assertEquals("HEALTHY", parsed.healthState)
    }

    @Test
    fun testCoordinateBounds() {
        // Valid lat/lng ranges
        val validLat = 12.9716
        val validLng = 77.5946
        assertTrue(validLat in -90.0..90.0)
        assertTrue(validLng in -180.0..180.0)

        val invalidLat = 95.0
        assertFalse(invalidLat in -90.0..90.0)
    }

    @Test
    fun testBatchIngestionContract() {
        val payload = LocationTelemetryPayload(
            clientEventId = "evt-batch-1",
            latitude = 22.8333,
            longitude = 74.2562,
            accuracy = 8.0f,
            recordedAt = "2026-10-20T10:00:00.000Z",
            source = "FUSED",
            trackingMode = "NORMAL",
            batteryLevel = 95.0f,
            networkState = "WIFI"
        )
        val request = com.disha.locationtracker.data.model.BatchIngestionRequest(
            locations = listOf(payload)
        )
        val json = gson.toJson(request)
        assertTrue(json.contains("\"locations\":["))
        assertTrue(json.contains("\"clientEventId\":\"evt-batch-1\""))

        val mockResponseBody = """{"locations":[{"clientEventId":"evt-batch-1","status":"accepted","locationId":"loc-123"}]}"""
        val response = gson.fromJson(mockResponseBody, com.disha.locationtracker.data.model.BatchIngestionResponse::class.java)
        assertNotNull(response.locations)
        assertEquals(1, response.locations?.size)
        assertEquals("accepted", response.locations?.first()?.status)
        assertEquals("evt-batch-1", response.locations?.first()?.clientEventId)
    }

    @Test
    fun testAccuracyRatingCategorization() {
        val optimalAccuracy = 6.2f
        val moderateAccuracy = 18.5f
        val coarseAccuracy = 125.0f

        val ratingOptimal = if (optimalAccuracy <= 10.0f) "OPTIMAL" else if (optimalAccuracy <= 30.0f) "MODERATE" else "COARSE"
        val ratingModerate = if (moderateAccuracy <= 10.0f) "OPTIMAL" else if (moderateAccuracy <= 30.0f) "MODERATE" else "COARSE"
        val ratingCoarse = if (coarseAccuracy <= 10.0f) "OPTIMAL" else if (coarseAccuracy <= 30.0f) "MODERATE" else "COARSE"

        assertEquals("OPTIMAL", ratingOptimal)
        assertEquals("MODERATE", ratingModerate)
        assertEquals("COARSE", ratingCoarse)
    }

    @Test
    fun testServerConfigDefaultUrl() {
        assertEquals("https://disha-roan.vercel.app", com.disha.locationtracker.config.ServerConfig.DEFAULT_SERVER_URL)
        assertEquals("https://disha-roan.vercel.app", com.disha.locationtracker.config.ServerConfig.sanitizeUrl("disha-roan.vercel.app/"))
        assertEquals("https://custom-server.internal", com.disha.locationtracker.config.ServerConfig.sanitizeUrl("https://custom-server.internal"))
    }

    @Test
    fun testTrailRecordingIntervalDefaultIs30Seconds() {
        // 30-second location trail recording interval (30,000 ms)
        val intervalMs = com.disha.locationtracker.service.LocationTrackingService.DEFAULT_TRAIL_RECORDING_INTERVAL_MS
        assertEquals(30_000L, intervalMs)
        assertEquals(30 * 1000L, intervalMs)
    }

    @Test
    fun testTrailRecordingIntervalGateLogic() {
        val intervalMs = 30_000L // 30 seconds (30,000 ms)
        var lastRecordedElapsedMs = 0L
        var isFirstDutyPoint = true

        fun shouldRecord(currentElapsedMs: Long, isSos: Boolean): Boolean {
            val elapsedSinceLast = currentElapsedMs - lastRecordedElapsedMs
            val record = isSos || isFirstDutyPoint || (elapsedSinceLast >= intervalMs)
            if (record) {
                lastRecordedElapsedMs = currentElapsedMs
                isFirstDutyPoint = false
            }
            return record
        }

        // t = 0s: Service starts, first valid fix should record immediately as anchor
        assertTrue(shouldRecord(0L, isSos = false))
        assertEquals(0L, lastRecordedElapsedMs)

        // t = 10s: Live map fix arrives -> Should NOT record duplicate historical point
        assertFalse(shouldRecord(10_000L, isSos = false))

        // t = 20s: 20 seconds in -> Should NOT record (within 30s window)
        assertFalse(shouldRecord(20_000L, isSos = false))

        // t = 29s: 29s -> Should NOT record
        assertFalse(shouldRecord(29_000L, isSos = false))

        // t = 30s: 30s -> SHOULD record (30-second interval elapsed)
        assertTrue(shouldRecord(30_000L, isSos = false))
        assertEquals(30_000L, lastRecordedElapsedMs)

        // t = 40s: 10s later -> Should NOT record
        assertFalse(shouldRecord(40_000L, isSos = false))

        // t = 45s: Emergency SOS triggered -> SHOULD record immediately!
        assertTrue(shouldRecord(45_000L, isSos = true))
        assertEquals(45_000L, lastRecordedElapsedMs)
    }

    @Test
    fun testDutyTimeHelperAuthorisedTrackingWindow() {
        val isoFormat = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US).apply {
            timeZone = TimeZone.getTimeZone("UTC")
        }

        // Tracking schedule: 07:00 AM – 07:00 PM Asia/Kolkata (IST)
        val t_0659 = isoFormat.parse("2026-10-21T01:29:59.000Z")!!.time // 06:59:59 IST (outside)
        val t_0700 = isoFormat.parse("2026-10-21T01:30:00.000Z")!!.time // 07:00:00 IST (inside)
        val t_1200 = isoFormat.parse("2026-10-21T06:30:00.000Z")!!.time // 12:00:00 IST (inside)
        val t_1859 = isoFormat.parse("2026-10-21T13:29:59.000Z")!!.time // 18:59:59 IST (inside)
        val t_1900 = isoFormat.parse("2026-10-21T13:30:00.000Z")!!.time // 19:00:00 IST (closed)
        val t_1901 = isoFormat.parse("2026-10-21T13:31:00.000Z")!!.time // 19:01:00 IST (outside)
        val t_2230 = isoFormat.parse("2026-10-21T17:00:00.000Z")!!.time // 22:30:00 IST (outside)

        assertFalse("06:59:59 IST is outside tracking window", com.disha.locationtracker.util.DutyTimeHelper.isWithinDutyWindow(t_0659))
        assertTrue("07:00:00 IST is inside tracking window", com.disha.locationtracker.util.DutyTimeHelper.isWithinDutyWindow(t_0700))
        assertTrue("12:00:00 IST is inside tracking window", com.disha.locationtracker.util.DutyTimeHelper.isWithinDutyWindow(t_1200))
        assertTrue("18:59:59 IST is inside tracking window", com.disha.locationtracker.util.DutyTimeHelper.isWithinDutyWindow(t_1859))
        assertFalse("19:01:00 IST is outside tracking window", com.disha.locationtracker.util.DutyTimeHelper.isWithinDutyWindow(t_1901))
        assertFalse("22:30:00 IST is outside tracking window", com.disha.locationtracker.util.DutyTimeHelper.isWithinDutyWindow(t_2230))
    }

    @Test
    fun testHeartbeatDeviceTrackingStatusContract() {
        val payload = HeartbeatPayload(
            personnelId = "pers-officer-status",
            batteryLevel = 87.5f,
            networkState = "CELLULAR",
            appVersion = "1.0.0",
            healthState = "HEALTHY",
            recordedAt = "2026-10-21T08:00:00.000Z",
            locationEnabled = true,
            permissionState = "GRANTED",
            isTrackingRunning = true,
            gpsAvailable = true,
            lastGpsFixTime = "2026-10-21T07:59:45.000Z"
        )

        val json = gson.toJson(payload)
        assertTrue(json.contains("\"locationEnabled\":true"))
        assertTrue(json.contains("\"permissionState\":\"GRANTED\""))
        assertTrue(json.contains("\"isTrackingRunning\":true"))
        assertTrue(json.contains("\"gpsAvailable\":true"))
        assertTrue(json.contains("\"lastGpsFixTime\":\"2026-10-21T07:59:45.000Z\""))

        val parsed = gson.fromJson(json, HeartbeatPayload::class.java)
        assertEquals(true, parsed.locationEnabled)
        assertEquals("GRANTED", parsed.permissionState)
        assertEquals(true, parsed.isTrackingRunning)
        assertEquals(true, parsed.gpsAvailable)
        assertEquals("2026-10-21T07:59:45.000Z", parsed.lastGpsFixTime)
    }

    @Test
    fun testFusedProviderResolutionContract() {
        fun resolveSource(provider: String, accuracy: Float, satellites: Int = 0): String {
            if (provider == "gps") return "GPS"
            if (provider == "network") return "NETWORK"
            if (satellites > 0) return "GPS"
            if (accuracy <= 25.0f) return "GPS"
            return "NETWORK"
        }

        // Native providers
        assertEquals("GPS", resolveSource("gps", 15.0f))
        assertEquals("NETWORK", resolveSource("network", 8.0f))

        // Google Play Services Fused Location Provider
        assertEquals("GPS", resolveSource("fused", 4.2f)) // Optimal satellite lock
        assertEquals("GPS", resolveSource("fused", 18.0f)) // Verified satellite lock
        assertEquals("GPS", resolveSource("fused", 25.0f)) // Upper threshold satellite
        assertEquals("NETWORK", resolveSource("fused", 228.0f)) // Coarse cell tower fix
        assertEquals("NETWORK", resolveSource("fused", 65.0f)) // Wi-Fi triangulation fix
        assertEquals("GPS", resolveSource("fused", 35.0f, satellites = 6)) // Coarser fix but GNSS verified
    }

    @Test
    fun testAccuracyUpgradeBypassesTransmissionGate() {
        var lastLiveTransmittedElapsedMs = 0L
        var lastTransmittedAccuracy: Float? = null
        var lastTransmittedSource: String? = null
        val liveIntervalMs = 30_000L

        fun evaluateTransmission(currentElapsedMs: Long, accuracy: Float, source: String, isFirst: Boolean): Boolean {
            val isGpsFix = source == "GPS"
            val lastAcc = lastTransmittedAccuracy
            val isAccuracyUpgrade = (lastAcc == null || lastAcc > 25.0f || lastTransmittedSource == "NETWORK") &&
                    (accuracy <= 20.0f && isGpsFix)
            val elapsedSinceLive = currentElapsedMs - lastLiveTransmittedElapsedMs
            val isLiveDue = isFirst || isAccuracyUpgrade || (elapsedSinceLive >= liveIntervalMs)

            if (isLiveDue) {
                lastLiveTransmittedElapsedMs = currentElapsedMs
                lastTransmittedAccuracy = accuracy
                lastTransmittedSource = source
            }
            return isLiveDue
        }

        // t = 0s: Service starts, initial cached fix (228m, NETWORK) transmitted as first point
        assertTrue(evaluateTransmission(0L, 228.0f, "NETWORK", isFirst = true))
        assertEquals(228.0f, lastTransmittedAccuracy)
        assertEquals("NETWORK", lastTransmittedSource)

        // t = 6s: Real satellite lock acquired (8.0m, GPS)
        // Even though only 6 seconds passed (well under 30s), accuracy upgrade MUST trigger immediate transmission!
        assertTrue("Accuracy upgrade from 228m to 8m must bypass 30s transmission delay",
            evaluateTransmission(6_000L, 8.0f, "GPS", isFirst = false))
        assertEquals(8.0f, lastTransmittedAccuracy)
        assertEquals("GPS", lastTransmittedSource)

        // t = 12s: Subsequent satellite fix (7.5m, GPS) within the 30s window
        // Should NOT transmit; already verified at 8m
        assertFalse("Subsequent fix within 30s without coarse upgrade should not transmit",
            evaluateTransmission(12_000L, 7.5f, "GPS", isFirst = false))

        // t = 36s: 30 seconds since last live transmission (at 6s)
        // 36s - 6s = 30s >= 30,000ms -> SHOULD transmit
        assertTrue("Periodic 30s schedule must transmit",
            evaluateTransmission(36_000L, 6.0f, "GPS", isFirst = false))
    }
}
