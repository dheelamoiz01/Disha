package com.disha.locationtracker

import com.disha.locationtracker.data.local.OfflineLocationDbHelper
import org.junit.Assert.*
import org.junit.Test
import java.text.SimpleDateFormat
import java.util.*

class RollingRetentionTest {

    private val istFormat = SimpleDateFormat("yyyy-MM-dd HH:mm:ss.SSS", Locale.US).apply {
        timeZone = TimeZone.getTimeZone("Asia/Kolkata")
    }

    private fun parseIST(dateTimeStr: String): Long {
        return istFormat.parse(dateTimeStr)!!.time
    }

    private fun formatIST(ms: Long): String {
        return istFormat.format(Date(ms))
    }

    @Test
    fun testRollingTwoDayCutoffOnDay2() {
        // Given current time is Day 2 at 15:30:00 IST
        val day2Now = parseIST("2026-10-22 15:30:00.000")
        val cutoff = OfflineLocationDbHelper.getRollingTwoDayCutoffMs(day2Now)

        // Preceding business day is Day 1 (2026-10-21). Cutoff should be 2026-10-21 00:00:00.000 IST
        assertEquals("2026-10-21 00:00:00.000", formatIST(cutoff))

        // Day 1 pings (e.g. 2026-10-21 09:00:00) must be retained (>= cutoff)
        val day1Ping = parseIST("2026-10-21 09:00:00.000")
        assertTrue("Day 1 ping must be retained on Day 2", day1Ping >= cutoff)

        // Day 2 pings must be retained (>= cutoff)
        val day2Ping = parseIST("2026-10-22 10:00:00.000")
        assertTrue("Day 2 ping must be retained on Day 2", day2Ping >= cutoff)
    }

    @Test
    fun testRollingTwoDayCutoffOnDay3PurgesDay1() {
        // When Day 3 starts at 00:05:00 IST
        val day3Now = parseIST("2026-10-23 00:05:00.000")
        val cutoff = OfflineLocationDbHelper.getRollingTwoDayCutoffMs(day3Now)

        // Preceding business day is Day 2 (2026-10-22). Cutoff must be 2026-10-22 00:00:00.000 IST
        assertEquals("2026-10-22 00:00:00.000", formatIST(cutoff))

        // Day 1 ping at 23:50:00 IST on Day 1: only ~24h15m old (far less than 48h!), but MUST be purged
        val lateDay1Ping = parseIST("2026-10-21 23:50:00.000")
        assertTrue("Day 1 ping must be purged when Day 3 starts", lateDay1Ping < cutoff)

        // Day 2 ping must remain retained
        val earlyDay2Ping = parseIST("2026-10-22 00:01:00.000")
        assertTrue("Day 2 ping must be retained on Day 3", earlyDay2Ping >= cutoff)

        // Day 3 ping must remain retained
        val earlyDay3Ping = parseIST("2026-10-23 00:02:00.000")
        assertTrue("Day 3 ping must be retained on Day 3", earlyDay3Ping >= cutoff)
    }

    @Test
    fun testRollingTwoDayCutoffOnDay4PurgesDay2() {
        // When Day 4 starts at 00:01:00 IST
        val day4Now = parseIST("2026-10-24 00:01:00.000")
        val cutoff = OfflineLocationDbHelper.getRollingTwoDayCutoffMs(day4Now)

        // Preceding business day is Day 3 (2026-10-23). Cutoff must be 2026-10-23 00:00:00.000 IST
        assertEquals("2026-10-23 00:00:00.000", formatIST(cutoff))

        // Day 2 pings must be purged
        val day2Ping = parseIST("2026-10-22 23:59:00.000")
        assertTrue("Day 2 ping must be purged when Day 4 starts", day2Ping < cutoff)

        // Day 3 and Day 4 pings must be retained
        val day3Ping = parseIST("2026-10-23 12:00:00.000")
        val day4Ping = parseIST("2026-10-24 00:00:30.000")
        assertTrue("Day 3 ping must be retained on Day 4", day3Ping >= cutoff)
        assertTrue("Day 4 ping must be retained on Day 4", day4Ping >= cutoff)
    }

    @Test
    fun testMidnightISTBoundaryTransition() {
        // Exactly 1 millisecond before midnight IST (end of Day 2)
        val endOfDay2 = parseIST("2026-10-22 23:59:59.999")
        val cutoffBeforeMidnight = OfflineLocationDbHelper.getRollingTwoDayCutoffMs(endOfDay2)
        assertEquals("2026-10-21 00:00:00.000", formatIST(cutoffBeforeMidnight))

        // Exactly at midnight IST (start of Day 3)
        val startOfDay3 = parseIST("2026-10-23 00:00:00.000")
        val cutoffAtMidnight = OfflineLocationDbHelper.getRollingTwoDayCutoffMs(startOfDay3)
        assertEquals("2026-10-22 00:00:00.000", formatIST(cutoffAtMidnight))

        // Any Day 1 ping that was valid 1ms ago is now immediately purged
        val day1Ping = parseIST("2026-10-21 23:59:00.000")
        assertTrue("Retained 1ms before midnight", day1Ping >= cutoffBeforeMidnight)
        assertTrue("Purged at midnight IST", day1Ping < cutoffAtMidnight)
    }
}
