package com.disha.locationtracker.util

import java.time.Duration
import java.time.Instant
import java.time.ZoneId
import java.time.ZonedDateTime

/**
 * Utility for enforcing the Asia/Kolkata (IST) 07:00 AM to 10:00 PM business duty window.
 *
 * Workers keep the phone's system Location ON 24/7.
 * Tracking and telemetry uploads are strictly gated to 07:00:00.000 AM - 09:59:59.999 PM IST.
 * At 22:00:00 (10:00 PM), the duty window closes.
 * At 07:00:00 (07:00 AM), the duty window opens automatically.
 */
object DutyTimeHelper {

    val IST_ZONE_ID: ZoneId = ZoneId.of("Asia/Kolkata")

    // Controllable clock for deterministic automated testing
    @Volatile
    var testCurrentTimeMillis: Long? = null

    fun nowMillis(): Long = testCurrentTimeMillis ?: System.currentTimeMillis()

    fun getZonedDateTime(epochMillis: Long = nowMillis()): ZonedDateTime {
        return Instant.ofEpochMilli(epochMillis).atZone(IST_ZONE_ID)
    }

    /**
     * Checks whether a given timestamp falls strictly within the permitted duty window:
     * 07:00:00.000 AM to 09:59:59.999 PM Asia/Kolkata (hour in 7..21).
     *
     * - At 06:59 IST: false (blocked)
     * - At 07:00 IST: true (active)
     * - At 21:59 IST: true (active)
     * - At 22:00 IST: false (blocked)
     * - At 22:30 IST: false (blocked)
     */
    fun isWithinDutyWindow(epochMillis: Long = nowMillis()): Boolean {
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
