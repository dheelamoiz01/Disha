package com.disha.locationtracker.data.remote

import com.disha.locationtracker.data.local.AppPreferences
import com.disha.locationtracker.data.model.*
import com.google.gson.Gson
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.*
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.IOException
import java.util.concurrent.TimeUnit

class ApiClient(private val prefs: AppPreferences) {

    private val gson = Gson()
    private val jsonMediaType = "application/json; charset=utf-8".toMediaType()

    private val cookieJar = object : CookieJar {
        override fun saveFromResponse(url: HttpUrl, cookies: List<Cookie>) {
            for (cookie in cookies) {
                if (cookie.name == "disha_session") {
                    prefs.sessionCookie = cookie.value
                }
            }
        }

        override fun loadForRequest(url: HttpUrl): List<Cookie> {
            val sessionToken = prefs.sessionCookie
            if (!sessionToken.isNullOrBlank()) {
                val cookie = Cookie.Builder()
                    .domain(url.host)
                    .path("/")
                    .name("disha_session")
                    .value(sessionToken)
                    .httpOnly()
                    .build()
                return listOf(cookie)
            }
            return emptyList()
        }
    }

    private val client: OkHttpClient = OkHttpClient.Builder()
        .cookieJar(cookieJar)
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(15, TimeUnit.SECONDS)
        .writeTimeout(15, TimeUnit.SECONDS)
        .addInterceptor { chain ->
            val original = chain.request()
            val requestBuilder = original.newBuilder()

            // Attach Bearer token if available
            prefs.bearerToken?.let { token ->
                requestBuilder.header("Authorization", "Bearer $token")
            }

            // Always provide Origin header matching server host to satisfy CSRF validateOrigin
            val originUrl = prefs.serverUrl
            requestBuilder.header("Origin", originUrl)
            requestBuilder.header("Accept", "application/json")

            chain.proceed(requestBuilder.build())
        }
        .build()

    suspend fun enrollDevice(request: EnrollRequest): Result<EnrollResponse> =
        withContext(Dispatchers.IO) {
            try {
                val url = "${prefs.serverUrl}/api/device/enroll"
                val body = gson.toJson(request).toRequestBody(jsonMediaType)
                val httpRequest = Request.Builder().url(url).post(body).build()

                client.newCall(httpRequest).execute().use { response ->
                    val responseBody = response.body?.string().orEmpty()
                    if (response.isSuccessful) {
                        val parsed = gson.fromJson(responseBody, EnrollResponse::class.java)
                        Result.success(parsed)
                    } else {
                        Result.failure(IOException("Enroll failed (${response.code}): $responseBody"))
                    }
                }
            } catch (e: Exception) {
                Result.failure(e)
            }
        }

    suspend fun login(request: LoginRequest): Result<LoginResponse> =
        withContext(Dispatchers.IO) {
            try {
                val url = "${prefs.serverUrl}/api/auth/login"
                val body = gson.toJson(request).toRequestBody(jsonMediaType)
                val httpRequest = Request.Builder().url(url).post(body).build()

                client.newCall(httpRequest).execute().use { response ->
                    val responseBody = response.body?.string().orEmpty()
                    if (response.isSuccessful) {
                        val parsed = gson.fromJson(responseBody, LoginResponse::class.java)
                        Result.success(parsed)
                    } else {
                        Result.failure(IOException("Login failed (${response.code}): $responseBody"))
                    }
                }
            } catch (e: Exception) {
                Result.failure(e)
            }
        }

    suspend fun startDuty(personnelId: String, deviceIdentifier: String): Result<DutyStartResponse> =
        withContext(Dispatchers.IO) {
            try {
                val url = "${prefs.serverUrl}/api/duty/start"
                val payload = DutyStartRequest(personnelId, deviceIdentifier)
                val body = gson.toJson(payload).toRequestBody(jsonMediaType)
                val httpRequest = Request.Builder().url(url).post(body).build()

                client.newCall(httpRequest).execute().use { response ->
                    val responseBody = response.body?.string().orEmpty()
                    val parsed = gson.fromJson(responseBody, DutyStartResponse::class.java)
                    if (response.isSuccessful && parsed?.success == true) {
                        Result.success(parsed)
                    } else {
                        Result.failure(IOException(parsed?.error ?: "Start duty failed (${response.code}): $responseBody"))
                    }
                }
            } catch (e: Exception) {
                Result.failure(e)
            }
        }

    suspend fun endDuty(personnelId: String): Result<DutyEndResponse> =
        withContext(Dispatchers.IO) {
            try {
                val url = "${prefs.serverUrl}/api/duty/end"
                val payload = DutyEndRequest(personnelId)
                val body = gson.toJson(payload).toRequestBody(jsonMediaType)
                val httpRequest = Request.Builder().url(url).post(body).build()

                client.newCall(httpRequest).execute().use { response ->
                    val responseBody = response.body?.string().orEmpty()
                    val parsed = gson.fromJson(responseBody, DutyEndResponse::class.java)
                    if (response.isSuccessful && parsed?.success == true) {
                        Result.success(parsed)
                    } else {
                        Result.failure(IOException(parsed?.error ?: "End duty failed (${response.code}): $responseBody"))
                    }
                }
            } catch (e: Exception) {
                Result.failure(e)
            }
        }

    suspend fun signOut(personnelId: String, deviceIdentifier: String): Result<Boolean> =
        withContext(Dispatchers.IO) {
            try {
                val url = "${prefs.serverUrl}/api/device/signout"
                val payload = mapOf(
                    "personnelId" to personnelId,
                    "deviceIdentifier" to deviceIdentifier
                )
                val body = gson.toJson(payload).toRequestBody(jsonMediaType)
                val httpRequest = Request.Builder().url(url).post(body).build()

                client.newCall(httpRequest).execute().use { response ->
                    if (response.isSuccessful) {
                        Result.success(true)
                    } else {
                        // Fallback attempt to general logout
                        try {
                            val logoutUrl = "${prefs.serverUrl}/api/auth/logout"
                            val emptyBody = "".toRequestBody(jsonMediaType)
                            val logoutReq = Request.Builder().url(logoutUrl).post(emptyBody).build()
                            client.newCall(logoutReq).execute().close()
                        } catch (_: Exception) {}
                        Result.success(false)
                    }
                }
            } catch (e: Exception) {
                try {
                    val logoutUrl = "${prefs.serverUrl}/api/auth/logout"
                    val emptyBody = "".toRequestBody(jsonMediaType)
                    val logoutReq = Request.Builder().url(logoutUrl).post(emptyBody).build()
                    client.newCall(logoutReq).execute().close()
                } catch (_: Exception) {}
                Result.failure(e)
            }
        }

    suspend fun sendLocation(payload: LocationTelemetryPayload): Result<TelemetryResponse> =
        withContext(Dispatchers.IO) {
            try {
                val url = "${prefs.serverUrl}/api/telemetry/location"
                val body = gson.toJson(payload).toRequestBody(jsonMediaType)
                val httpRequest = Request.Builder().url(url).post(body).build()

                client.newCall(httpRequest).execute().use { response ->
                    val responseBody = response.body?.string().orEmpty()
                    if (response.isSuccessful) {
                        val parsed = gson.fromJson(responseBody, TelemetryResponse::class.java)
                        Result.success(parsed)
                    } else {
                        Result.failure(IOException("Telemetry failed (${response.code}): $responseBody"))
                    }
                }
            } catch (e: Exception) {
                Result.failure(e)
            }
        }

    suspend fun sendBatch(request: BatchIngestionRequest): Result<BatchIngestionResponse> =
        withContext(Dispatchers.IO) {
            try {
                val url = "${prefs.serverUrl}/api/telemetry/batch"
                val body = gson.toJson(request).toRequestBody(jsonMediaType)
                val httpRequest = Request.Builder().url(url).post(body).build()

                client.newCall(httpRequest).execute().use { response ->
                    val responseBody = response.body?.string().orEmpty()
                    if (response.isSuccessful) {
                        val parsed = gson.fromJson(responseBody, BatchIngestionResponse::class.java)
                        Result.success(parsed)
                    } else {
                        Result.failure(IOException("Batch telemetry failed (${response.code}): $responseBody"))
                    }
                }
            } catch (e: Exception) {
                Result.failure(e)
            }
        }

    suspend fun sendHeartbeat(payload: HeartbeatPayload): Result<Boolean> =
        withContext(Dispatchers.IO) {
            try {
                val url = "${prefs.serverUrl}/api/telemetry/heartbeat"
                val body = gson.toJson(payload).toRequestBody(jsonMediaType)
                val httpRequest = Request.Builder().url(url).post(body).build()

                client.newCall(httpRequest).execute().use { response ->
                    if (response.isSuccessful) {
                        Result.success(true)
                    } else {
                        Result.failure(IOException("Heartbeat failed (${response.code})"))
                    }
                }
            } catch (e: Exception) {
                Result.failure(e)
            }
        }

    suspend fun sendEvent(payload: LocationEventPayload): Result<Boolean> =
        withContext(Dispatchers.IO) {
            try {
                val url = "${prefs.serverUrl}/api/telemetry/event"
                val body = gson.toJson(payload).toRequestBody(jsonMediaType)
                val httpRequest = Request.Builder().url(url).post(body).build()

                client.newCall(httpRequest).execute().use { response ->
                    if (response.isSuccessful) {
                        Result.success(true)
                    } else {
                        val err = response.body?.string().orEmpty()
                        Result.failure(IOException("Event transmission failed (${response.code}): $err"))
                    }
                }
            } catch (e: Exception) {
                Result.failure(e)
            }
        }

    suspend fun startSOS(clientEventId: String): Result<Boolean> =
        withContext(Dispatchers.IO) {
            try {
                val url = "${prefs.serverUrl}/api/sos/start"
                val payload = SOSRequest(clientEventId)
                val body = gson.toJson(payload).toRequestBody(jsonMediaType)
                val httpRequest = Request.Builder().url(url).post(body).build()

                client.newCall(httpRequest).execute().use { response ->
                    if (response.isSuccessful) {
                        Result.success(true)
                    } else {
                        val err = response.body?.string().orEmpty()
                        Result.failure(IOException("SOS start failed (${response.code}): $err"))
                    }
                }
            } catch (e: Exception) {
                Result.failure(e)
            }
        }

    suspend fun endSOS(clientEventId: String): Result<Boolean> =
        withContext(Dispatchers.IO) {
            try {
                val url = "${prefs.serverUrl}/api/sos/end"
                val payload = SOSRequest(clientEventId)
                val body = gson.toJson(payload).toRequestBody(jsonMediaType)
                val httpRequest = Request.Builder().url(url).post(body).build()

                client.newCall(httpRequest).execute().use { response ->
                    if (response.isSuccessful) {
                        Result.success(true)
                    } else {
                        val err = response.body?.string().orEmpty()
                        Result.failure(IOException("SOS end failed (${response.code}): $err"))
                    }
                }
            } catch (e: Exception) {
                Result.failure(e)
            }
        }
}
