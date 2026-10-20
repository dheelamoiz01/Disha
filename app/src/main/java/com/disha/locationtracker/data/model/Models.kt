package com.disha.locationtracker.data.model

import com.google.gson.annotations.SerializedName

// Device Enrollment
data class EnrollRequest(
    val username: String,
    val password: String,
    val deviceIdentifier: String,
    val platform: String = "Android",
    val appVersion: String? = "1.0.0"
)

data class EnrollResponse(
    val token: String?,
    val device: DeviceDto?,
    val personnel: PersonnelDto?,
    val error: String?
)

data class DeviceDto(
    val id: String,
    val status: String
)

data class PersonnelDto(
    val id: String,
    val name: String
)

// User Session Login (for cookie authentication and role verification)
data class LoginRequest(
    val username: String,
    val password: String
)

data class LoginResponse(
    val success: Boolean,
    val role: String?,
    val error: String?
)

// Duty Lifecycle
data class DutyStartRequest(
    val personnelId: String,
    val deviceIdentifier: String
)

data class DutyStartResponse(
    val success: Boolean,
    val session: DutySessionDto?,
    val error: String?,
    val code: String?
)

data class DutyEndRequest(
    val personnelId: String
)

data class DutyEndResponse(
    val success: Boolean,
    val session: DutySessionDto?,
    val error: String?,
    val code: String?
)

data class DutySessionDto(
    val id: String,
    val status: String,
    val startedAt: String?,
    val endedAt: String?
)

// Telemetry & Location
data class LocationTelemetryPayload(
    val clientEventId: String,
    val latitude: Double,
    val longitude: Double,
    val accuracy: Float,
    val recordedAt: String, // ISO-8601 string
    val source: String = "GPS", // "GPS", "NETWORK", "UNKNOWN"
    val trackingMode: String = "NORMAL", // "NORMAL", "SOS"
    val batteryLevel: Float? = null,
    val networkState: String? = null
)

data class HeartbeatPayload(
    val personnelId: String,
    val batteryLevel: Float?,
    val networkState: String?,
    val appVersion: String?,
    val healthState: String?,
    val recordedAt: String, // ISO-8601 string
    val locationEnabled: Boolean? = null,
    val permissionState: String? = null,
    val isTrackingRunning: Boolean? = null,
    val gpsAvailable: Boolean? = null,
    val lastGpsFixTime: String? = null
)

data class SOSRequest(
    val clientEventId: String
)

data class TelemetryResponse(
    val status: String?,
    val locationId: String?,
    val receivedAt: String?,
    val error: String?
)

// Batch Telemetry Models
data class BatchIngestionRequest(
    val locations: List<LocationTelemetryPayload>? = null,
    val events: List<LocationEventPayload>? = null
)

data class LocationEventPayload(
    val clientEventId: String,
    val eventType: String,
    val recordedAt: String,
    val metadata: Map<String, Any>? = null
)

data class BatchIngestionResponse(
    val locations: List<BatchItemResult>?,
    val events: List<BatchItemResult>?
)

data class BatchItemResult(
    val clientEventId: String,
    val status: String,
    val locationId: String? = null,
    val eventId: String? = null,
    val receivedAt: String? = null,
    val error: String? = null
)

// Local Offline SQLite Model
data class CachedLocationRecord(
    val id: Long = 0,
    val clientEventId: String,
    val latitude: Double,
    val longitude: Double,
    val accuracy: Float,
    val recordedAt: String,
    val source: String,
    val trackingMode: String,
    val batteryLevel: Float?,
    val networkState: String?,
    val createdAt: Long = System.currentTimeMillis()
)
