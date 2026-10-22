package com.disha.locationtracker.util

import java.time.Duration
import java.time.Instant
import java.time.ZoneId
import java.time.ZonedDateTime

/**
 * Utility for Authorised Location Tracking in Asia/Kolkata (IST).
 *
 * Operational schedule: 7:00 AM – 7:00 PM Asia/Kolkata (IST).
 * Location telemetry and historical trail points are active during this authorized window.
 * Outside this window, the service enters standby and resumes at 7:00 AM IST.
 */
object DutyTimeHelper {

    val IST_ZONE_ID: ZoneId = ZoneId.of("Asia/Kolkata")

    // Controllable clock for deterministic automated testing
    @Volatile
    var testCurrentTimeMillis: Long? = null

    // 24×7 Continuous Location Tracking: active around the clock by default (day and night, every day)
    @Volatile
    var enforceRestrictedHours: Boolean = false

    fun nowMillis(): Long = testCurrentTimeMillis ?: System.currentTimeMillis()

    fun getZonedDateTime(epochMillis: Long = nowMillis()): ZonedDateTime {
        return Instant.ofEpochMilli(epochMillis).atZone(IST_ZONE_ID)
    }

    /**
     * Checks whether location tracking is active.
     * Enforces the authorised tracking schedule: 7:00 AM–7:00 PM (07:00:00 to 19:00:00), Asia/Kolkata (IST).
     */
    fun isWithinDutyWindow(epochMillis: Long = nowMillis()): Boolean {
        if (!enforceRestrictedHours) return true
        val istTime = getZonedDateTime(epochMillis)
        val hour = istTime.hour
        val minute = istTime.minute
        val second = istTime.second

        // Active from 07:00:00 AM to strictly 07:00:00 PM (19:00:00) IST
        if (hour < 7) return false
        if (hour > 19) return false
        if (hour == 19 && (minute > 0 || second > 0)) return false
        return true
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
