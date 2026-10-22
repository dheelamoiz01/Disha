package com.disha.locationtracker.update

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.provider.Settings
import android.util.Log
import androidx.core.content.FileProvider
import com.disha.locationtracker.data.local.AppPreferences
import com.google.gson.Gson
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient
import okhttp3.Request
import java.io.File
import java.io.FileOutputStream
import java.io.InputStream
import java.security.MessageDigest
import java.util.concurrent.TimeUnit

data class UpdateCheckResponse(
    val updateAvailable: Boolean,
    val currentVersionCode: Int,
    val latestRelease: ReleaseInfo?
)

data class ReleaseInfo(
    val id: String,
    val versionCode: Int,
    val versionName: String,
    val releaseNotes: String,
    val downloadUrl: String,
    val sha256Checksum: String,
    val fileSizeBytes: Long?,
    val minSupportedVersionCode: Int,
    val isMandatory: Boolean,
    val publishedAt: String?
)

sealed class DownloadProgressState {
    object Idle : DownloadProgressState()
    data class Downloading(val progressPercent: Int, val bytesDownloaded: Long, val totalBytes: Long) : DownloadProgressState()
    object VerifyingChecksum : DownloadProgressState()
    data class ReadyToInstall(val apkFile: File) : DownloadProgressState()
    data class Error(val message: String) : DownloadProgressState()
}

class UpdateManager(
    private val context: Context,
    private val prefs: AppPreferences
) {
    companion object {
        private const val TAG = "UpdateManager"
    }

    private val gson = Gson()
    private val downloadClient = OkHttpClient.Builder()
        .connectTimeout(30, TimeUnit.SECONDS)
        .readTimeout(60, TimeUnit.SECONDS)
        .writeTimeout(30, TimeUnit.SECONDS)
        .followRedirects(true)
        .followSslRedirects(true)
        .build()

    fun getCurrentVersionCode(): Int {
        return try {
            val packageInfo = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                context.packageManager.getPackageInfo(context.packageName, PackageManager.PackageInfoFlags.of(0))
            } else {
                @Suppress("DEPRECATION")
                context.packageManager.getPackageInfo(context.packageName, 0)
            }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                packageInfo.longVersionCode.toInt()
            } else {
                @Suppress("DEPRECATION")
                packageInfo.versionCode
            }
        } catch (e: Exception) {
            Log.e(TAG, "Error getting current version code", e)
            1
        }
    }

    fun getCurrentVersionName(): String {
        return try {
            val packageInfo = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                context.packageManager.getPackageInfo(context.packageName, PackageManager.PackageInfoFlags.of(0))
            } else {
                @Suppress("DEPRECATION")
                context.packageManager.getPackageInfo(context.packageName, 0)
            }
            packageInfo.versionName ?: "1.0.0"
        } catch (e: Exception) {
            "1.0.0"
        }
    }

    suspend fun checkForUpdate(): Result<UpdateCheckResponse> = withContext(Dispatchers.IO) {
        try {
            val currentCode = getCurrentVersionCode()
            val baseUrl = prefs.serverUrl.trimEnd('/')
            val url = "$baseUrl/api/app/update/check?versionCode=$currentCode"

            val request = Request.Builder()
                .url(url)
                .header("Accept", "application/json")
                .apply {
                    prefs.bearerToken?.let { token ->
                        header("Authorization", "Bearer $token")
                    }
                }
                .get()
                .build()

            downloadClient.newCall(request).execute().use { response ->
                val bodyStr = response.body?.string().orEmpty()
                if (response.isSuccessful) {
                    val result = gson.fromJson(bodyStr, UpdateCheckResponse::class.java)
                    Result.success(result)
                } else {
                    Result.failure(Exception("Update check failed with HTTP ${response.code}: $bodyStr"))
                }
            }
        } catch (e: Exception) {
            Log.e(TAG, "Failed to check for updates", e)
            Result.failure(e)
        }
    }

    suspend fun downloadAndVerifyApk(
        release: ReleaseInfo,
        onProgress: (DownloadProgressState) -> Unit
    ): Result<File> = withContext(Dispatchers.IO) {
        var tempFile: File? = null
        try {
            val baseUrl = prefs.serverUrl.trimEnd('/')
            val downloadUrl = if (release.downloadUrl.startsWith("http://") || release.downloadUrl.startsWith("https://")) {
                release.downloadUrl
            } else {
                val cleanPath = if (release.downloadUrl.startsWith("/")) release.downloadUrl else "/${release.downloadUrl}"
                "$baseUrl$cleanPath"
            }

            Log.i(TAG, "Downloading update v${release.versionName} from $downloadUrl")

            val updatesDir = File(context.cacheDir, "updates").apply { mkdirs() }
            val apkFile = File(updatesDir, "update_${release.versionCode}.apk")
            if (apkFile.exists()) {
                apkFile.delete()
            }
            tempFile = apkFile

            val request = Request.Builder()
                .url(downloadUrl)
                .get()
                .build()

            downloadClient.newCall(request).execute().use { response ->
                if (!response.isSuccessful) {
                    val err = "Download failed with HTTP ${response.code}"
                    onProgress(DownloadProgressState.Error(err))
                    return@withContext Result.failure(Exception(err))
                }

                val responseBody = response.body ?: throw Exception("Empty response body from APK download")
                val totalBytes = responseBody.contentLength().let { if (it > 0) it else (release.fileSizeBytes ?: -1L) }

                val inputStream: InputStream = responseBody.byteStream()
                val outputStream = FileOutputStream(apkFile)
                val digest = MessageDigest.getInstance("SHA-256")

                val buffer = ByteArray(8192)
                var bytesRead: Int
                var totalDownloaded = 0L
                var lastReportedPercent = -1

                inputStream.use { input ->
                    outputStream.use { output ->
                        while (input.read(buffer).also { bytesRead = it } != -1) {
                            output.write(buffer, 0, bytesRead)
                            digest.update(buffer, 0, bytesRead)
                            totalDownloaded += bytesRead

                            if (totalBytes > 0) {
                                val percent = ((totalDownloaded * 100) / totalBytes).toInt()
                                if (percent != lastReportedPercent) {
                                    lastReportedPercent = percent
                                    onProgress(DownloadProgressState.Downloading(percent, totalDownloaded, totalBytes))
                                }
                            } else {
                                onProgress(DownloadProgressState.Downloading(-1, totalDownloaded, -1))
                            }
                        }
                        output.flush()
                    }
                }

                onProgress(DownloadProgressState.VerifyingChecksum)

                // Verify SHA-256 Checksum
                val calculatedChecksum = digest.digest().joinToString("") { "%02x".format(it) }.lowercase()
                val expectedChecksum = release.sha256Checksum.trim().lowercase()

                if (calculatedChecksum != expectedChecksum) {
                    apkFile.delete()
                    val err = "SHA-256 checksum mismatch! Expected: $expectedChecksum, Actual: $calculatedChecksum"
                    Log.e(TAG, err)
                    onProgress(DownloadProgressState.Error("Security verification failed: Checksum mismatch"))
                    return@withContext Result.failure(SecurityException(err))
                }

                // Verify Package Name & Archive Integrity
                val archiveInfo = context.packageManager.getPackageArchiveInfo(
                    apkFile.absolutePath,
                    0
                )

                if (archiveInfo == null) {
                    apkFile.delete()
                    val err = "Corrupted APK file: Package manager failed to parse archive"
                    Log.e(TAG, err)
                    onProgress(DownloadProgressState.Error(err))
                    return@withContext Result.failure(SecurityException(err))
                }

                if (archiveInfo.packageName != context.packageName) {
                    apkFile.delete()
                    val err = "Package mismatch! APK is for '${archiveInfo.packageName}', current app is '${context.packageName}'"
                    Log.e(TAG, err)
                    onProgress(DownloadProgressState.Error("Security verification failed: Application ID mismatch"))
                    return@withContext Result.failure(SecurityException(err))
                }

                Log.i(TAG, "Update APK verified successfully: ${apkFile.absolutePath} (v${release.versionName})")
                onProgress(DownloadProgressState.ReadyToInstall(apkFile))
                Result.success(apkFile)
            }
        } catch (e: Exception) {
            Log.e(TAG, "Error during APK download and verification", e)
            tempFile?.delete()
            onProgress(DownloadProgressState.Error(e.message ?: "Download failed"))
            Result.failure(e)
        }
    }

    fun canRequestPackageInstalls(): Boolean {
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            context.packageManager.canRequestPackageInstalls()
        } else {
            true
        }
    }

    fun requestInstallPermission(activity: Activity) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val intent = Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES).apply {
                data = Uri.parse("package:${activity.packageName}")
            }
            activity.startActivity(intent)
        }
    }

    fun launchApkInstaller(activity: Activity, apkFile: File) {
        try {
            val contentUri = FileProvider.getUriForFile(
                activity,
                "${activity.packageName}.fileprovider",
                apkFile
            )

            val installIntent = Intent(Intent.ACTION_VIEW).apply {
                setDataAndType(contentUri, "application/vnd.android.package-archive")
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            }

            activity.startActivity(installIntent)
        } catch (e: Exception) {
            Log.e(TAG, "Failed to launch package installer", e)
        }
    }
}
