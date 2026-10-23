package com.disha.locationtracker.data.local

import android.content.ContentValues
import android.content.Context
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteOpenHelper
import com.disha.locationtracker.data.model.CachedLocationRecord
import java.util.Calendar
import java.util.TimeZone

class OfflineLocationDbHelper(context: Context) :
    SQLiteOpenHelper(context, DATABASE_NAME, null, DATABASE_VERSION) {

    override fun onCreate(db: SQLiteDatabase) {
        db.execSQL(
            """
            CREATE TABLE $TABLE_LOCATIONS (
                $COL_ID INTEGER PRIMARY KEY AUTOINCREMENT,
                $COL_CLIENT_EVENT_ID TEXT UNIQUE,
                $COL_LATITUDE REAL,
                $COL_LONGITUDE REAL,
                $COL_ACCURACY REAL,
                $COL_RECORDED_AT TEXT,
                $COL_SOURCE TEXT,
                $COL_TRACKING_MODE TEXT,
                $COL_BATTERY_LEVEL REAL,
                $COL_NETWORK_STATE TEXT,
                $COL_CREATED_AT INTEGER
            )
            """.trimIndent()
        )
    }

    override fun onUpgrade(db: SQLiteDatabase, oldVersion: Int, newVersion: Int) {
        db.execSQL("DROP TABLE IF EXISTS $TABLE_LOCATIONS")
        onCreate(db)
    }

    @Synchronized
    fun insertLocation(record: CachedLocationRecord): Long {
        val db = writableDatabase

        // Enforce bounded local queuing: Keep maximum 5,000 records to prevent device storage overflow
        try {
            db.execSQL(
                """
                DELETE FROM $TABLE_LOCATIONS 
                WHERE $COL_ID NOT IN (
                    SELECT $COL_ID FROM $TABLE_LOCATIONS ORDER BY $COL_CREATED_AT DESC LIMIT 4999
                )
                """.trimIndent()
            )
        } catch (e: Exception) {
            e.printStackTrace()
        }

        // Enforce rolling 2-business-day retention alignment (Asia/Kolkata):
        // Evict locally cached records whose timestamp is older than the start of the preceding IST business day.
        val cutoffMs = getRollingTwoDayCutoffMs()
        try {
            db.execSQL(
                "DELETE FROM $TABLE_LOCATIONS WHERE $COL_CREATED_AT < ?",
                arrayOf(cutoffMs.toString())
            )
        } catch (e: Exception) {
            e.printStackTrace()
        }

        val values = ContentValues().apply {
            put(COL_CLIENT_EVENT_ID, record.clientEventId)
            put(COL_LATITUDE, record.latitude)
            put(COL_LONGITUDE, record.longitude)
            put(COL_ACCURACY, record.accuracy)
            put(COL_RECORDED_AT, record.recordedAt)
            put(COL_SOURCE, record.source)
            put(COL_TRACKING_MODE, record.trackingMode)
            put(COL_BATTERY_LEVEL, record.batteryLevel)
            put(COL_NETWORK_STATE, record.networkState)
            put(COL_CREATED_AT, record.createdAt)
        }
        return db.insertWithOnConflict(
            TABLE_LOCATIONS,
            null,
            values,
            SQLiteDatabase.CONFLICT_IGNORE
        )
    }

    @Synchronized
    fun getPendingLocations(limit: Int = 50): List<CachedLocationRecord> {
        val list = mutableListOf<CachedLocationRecord>()
        val db = readableDatabase

        // Only return records within the rolling 2-business-day window (Asia/Kolkata).
        // Expired records from Day N - 2 or earlier are permanently deleted and skipped.
        val cutoffMs = getRollingTwoDayCutoffMs()

        try {
            val dbWrite = writableDatabase
            dbWrite.execSQL(
                "DELETE FROM $TABLE_LOCATIONS WHERE $COL_CREATED_AT < ?",
                arrayOf(cutoffMs.toString())
            )
        } catch (e: Exception) {
            // Non-fatal if write is unavailable during query
        }

        val cursor = db.query(
            TABLE_LOCATIONS,
            null,
            "$COL_CREATED_AT >= ?",
            arrayOf(cutoffMs.toString()),
            null,
            null,
            "$COL_CREATED_AT ASC",
            limit.toString()
        )

        cursor.use {
            val idxId = it.getColumnIndexOrThrow(COL_ID)
            val idxCid = it.getColumnIndexOrThrow(COL_CLIENT_EVENT_ID)
            val idxLat = it.getColumnIndexOrThrow(COL_LATITUDE)
            val idxLng = it.getColumnIndexOrThrow(COL_LONGITUDE)
            val idxAcc = it.getColumnIndexOrThrow(COL_ACCURACY)
            val idxRec = it.getColumnIndexOrThrow(COL_RECORDED_AT)
            val idxSrc = it.getColumnIndexOrThrow(COL_SOURCE)
            val idxMode = it.getColumnIndexOrThrow(COL_TRACKING_MODE)
            val idxBat = it.getColumnIndexOrThrow(COL_BATTERY_LEVEL)
            val idxNet = it.getColumnIndexOrThrow(COL_NETWORK_STATE)
            val idxCreated = it.getColumnIndexOrThrow(COL_CREATED_AT)

            while (it.moveToNext()) {
                val record = CachedLocationRecord(
                    id = it.getLong(idxId),
                    clientEventId = it.getString(idxCid),
                    latitude = it.getDouble(idxLat),
                    longitude = it.getDouble(idxLng),
                    accuracy = it.getFloat(idxAcc),
                    recordedAt = it.getString(idxRec),
                    source = it.getString(idxSrc),
                    trackingMode = it.getString(idxMode),
                    batteryLevel = if (it.isNull(idxBat)) null else it.getFloat(idxBat),
                    networkState = if (it.isNull(idxNet)) null else it.getString(idxNet),
                    createdAt = it.getLong(idxCreated)
                )
                list.add(record)
            }
        }
        return list
    }

    @Synchronized
    fun purgeExpiredLocations(nowMs: Long = System.currentTimeMillis()): Int {
        val db = writableDatabase
        val cutoffMs = getRollingTwoDayCutoffMs(nowMs)
        return db.delete(TABLE_LOCATIONS, "$COL_CREATED_AT < ?", arrayOf(cutoffMs.toString()))
    }

    @Synchronized
    fun deleteLocationByEventId(clientEventId: String): Int {
        val db = writableDatabase
        return db.delete(TABLE_LOCATIONS, "$COL_CLIENT_EVENT_ID = ?", arrayOf(clientEventId))
    }

    @Synchronized
    fun getPendingCount(): Int {
        val db = readableDatabase
        val cursor = db.rawQuery("SELECT COUNT(*) FROM $TABLE_LOCATIONS", null)
        cursor.use {
            if (it.moveToFirst()) {
                return it.getInt(0)
            }
        }
        return 0
    }

    companion object {
        private const val DATABASE_NAME = "disha_offline_telemetry.db"
        private const val DATABASE_VERSION = 1

        private const val TABLE_LOCATIONS = "pending_locations"
        private const val COL_ID = "id"
        private const val COL_CLIENT_EVENT_ID = "client_event_id"
        private const val COL_LATITUDE = "latitude"
        private const val COL_LONGITUDE = "longitude"
        private const val COL_ACCURACY = "accuracy"
        private const val COL_RECORDED_AT = "recorded_at"
        private const val COL_SOURCE = "source"
        private const val COL_TRACKING_MODE = "tracking_mode"
        private const val COL_BATTERY_LEVEL = "battery_level"
        private const val COL_NETWORK_STATE = "network_state"
        private const val COL_CREATED_AT = "created_at"

        /**
         * Calculates the UTC epoch millisecond timestamp representing the start
         * (00:00:00.000 IST) of the immediately preceding business day in Asia/Kolkata.
         *
         * Rolling 2-business-day policy:
         *   - Current business day = Day N
         *   - Immediately preceding business day = Day N - 1
         *   - Cutoff = Start of Day N - 1 in IST (00:00:00.000 IST)
         *
         * Any record recorded strictly before this cutoff belongs to Day N - 2 or earlier
         * and must be physically purged to prevent resurrected stale trails.
         */
        @JvmStatic
        fun getRollingTwoDayCutoffMs(nowMs: Long = System.currentTimeMillis()): Long {
            val istZone = TimeZone.getTimeZone("Asia/Kolkata")
            val cal = Calendar.getInstance(istZone)
            cal.timeInMillis = nowMs
            cal.add(Calendar.DAY_OF_MONTH, -1)
            cal.set(Calendar.HOUR_OF_DAY, 0)
            cal.set(Calendar.MINUTE, 0)
            cal.set(Calendar.SECOND, 0)
            cal.set(Calendar.MILLISECOND, 0)
            return cal.timeInMillis
        }
    }
}
