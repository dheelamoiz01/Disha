package com.disha.locationtracker.util

import java.time.Duration
import java.time.Instant
import java.time.ZoneId
import java.time.ZonedDateTime

/**
 * Utility for 24×7 Continuous Location Tracking in Asia/Kolkata (IST).
 *
 * GPS tracking is eligible to run 24 hours a day, 7 days a week,
 * including nights, weekends, holidays, and outside work sessions.
 * Location telemetry is accepted continuously without work-hour restrictions.
 */
object DutyTimeHelper {

    val IST_ZONE_ID: ZoneId = ZoneId.of("Asia/Kolkata")

    // Controllable clock for deterministic automated testing
    @Volatile
    var testCurrentTimeMillis: Long? = null

    // By default, 24×7 continuous tracking is enabled.
    // If legacy restricted hours (07:00 AM - 10:00 PM IST) are ever explicitly required:
    @Volatile
    var enforceRestrictedHours: Boolean = false

    fun nowMillis(): Long = testCurrentTimeMillis ?: System.currentTimeMillis()

    fun getZonedDateTime(epochMillis: Long = nowMillis()): ZonedDateTime {
        return Instant.ofEpochMilli(epochMillis).atZone(IST_ZONE_ID)
    }

    /**
     * Checks whether location tracking is active.
     * In 24×7 mode, returns true at all times (24 hours a day, 7 days a week).
     * If enforceRestrictedHours is explicitly set to true, enforces 07:00-22:00 IST.
     */
    fun isWithinDutyWindow(epochMillis: Long = nowMillis()): Boolean {
        if (!enforceRestrictedHours) return true
        val istTime = getZonedDateTime(epochMillis)
        val hour = istTime.hour
        return hour in 7..21
    }

    /**
     * Calculates milliseconds remaining until the next 07:00:00 AM IST window opening.
     */
    fun millisUntilNextDutyWindowStart(epochMillis: Long = nowMillis()): Long {
        val istTime = getZonedDateTime(epochMillis)
        var next07 = istTime.withHour(7).withMinute(0).withSecond(0).withNano(0)
        if (!istTime.isBefore(next07)) {
            // Already past 07:00 today; next 07:00 is tomorrow morning
            next07 = next07.plusDays(1)
        }
        return Duration.between(istTime, next07).toMillis().coerceAtLeast(1000L)
    }

    /**
     * Formats current time in IST for UI status strings.
     */
    fun formatCurrentIST(epochMillis: Long = nowMillis()): String {
        val istTime = getZonedDateTime(epochMillis)
        return String.format(
            java.util.Locale.US,
            "%02d:%02d:%02d IST",
            istTime.hour,
            istTime.minute,
            istTime.second
        )
    }
}
