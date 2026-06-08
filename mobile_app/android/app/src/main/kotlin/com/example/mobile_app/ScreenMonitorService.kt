package com.example.mobile_app

import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.AccessibilityServiceInfo
import android.view.accessibility.AccessibilityEvent
import android.graphics.Bitmap
import android.os.Handler
import android.os.Looper
import android.util.Log
import java.io.ByteArrayOutputStream
import java.net.HttpURLConnection
import java.net.URL
import kotlin.concurrent.thread
import org.json.JSONObject
import android.content.Context
import android.hardware.display.DisplayManager
import android.view.Display
import android.os.PowerManager
import android.app.KeyguardManager
import android.accessibilityservice.AccessibilityService.ScreenshotResult
import android.accessibilityservice.AccessibilityService.TakeScreenshotCallback

class ScreenMonitorService : AccessibilityService() {

    private val handler = Handler(Looper.getMainLooper())
    private var isMonitoring = false
    private val POLLING_INTERVAL = 20000L // 20 seconds
    private var lastBitmapHash = 0
    private var currentPackageName = ""

    override fun onServiceConnected() {
        super.onServiceConnected()
        val info = AccessibilityServiceInfo()
        info.eventTypes = AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED
        info.feedbackType = AccessibilityServiceInfo.FEEDBACK_GENERIC
        info.flags = AccessibilityServiceInfo.DEFAULT
        this.serviceInfo = info
        Log.d("ScreenMonitor", "Service Connected")
        
        startMonitoringLoop()
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent?) {
        if (event?.eventType == AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED) {
            event.packageName?.let {
                currentPackageName = it.toString()
            }
        }
    }

    override fun onInterrupt() {
        Log.d("ScreenMonitor", "Service Interrupted")
        isMonitoring = false
    }

    private fun getSharedPrefsValue(key: String): String? {
        val prefs = getSharedPreferences("FlutterSharedPreferences", Context.MODE_PRIVATE)
        return prefs.getString("flutter.$key", null)
    }

    private fun startMonitoringLoop() {
        isMonitoring = true
        handler.post(object : Runnable {
            override fun run() {
                if (!isMonitoring) return
                thread { checkStatusAndCapture() }
                handler.postDelayed(this, POLLING_INTERVAL)
            }
        })
    }

    private fun checkStatusAndCapture() {
        val powerManager = getSystemService(Context.POWER_SERVICE) as PowerManager
        val keyguardManager = getSystemService(Context.KEYGUARD_SERVICE) as KeyguardManager
        
        if (!powerManager.isInteractive || keyguardManager.isKeyguardLocked) return
        if (!currentPackageName.contains("instagram")) return

        val serverIp = getSharedPrefsValue("server_ip")
        val deviceId = getSharedPrefsValue("device_id")
        
        if (serverIp == null || deviceId == null) return

        // 1. Check if monitoring is enabled on server
        try {
            val statusUrl = URL("http://$serverIp:3001/api/status/$deviceId")
            val conn = statusUrl.openConnection() as HttpURLConnection
            conn.requestMethod = "GET"
            conn.connectTimeout = 5000
            
            if (conn.responseCode == 200) {
                val response = conn.inputStream.bufferedReader().use { it.readText() }
                val json = JSONObject(response)
                val enabled = json.optBoolean("monitoring_enabled", false)
                
                if (enabled) {
                    takeScreenshotAndUpload(serverIp, deviceId)
                }
            }
            conn.disconnect()
        } catch (e: Exception) {
            Log.e("ScreenMonitor", "Failed to check status", e)
        }
    }

    private fun takeScreenshotAndUpload(serverIp: String, deviceId: String) {
        if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.R) {
            takeScreenshot(Display.DEFAULT_DISPLAY, mainExecutor, object : TakeScreenshotCallback {
                override fun onSuccess(screenshot: ScreenshotResult) {
                    val bitmap = Bitmap.wrapHardwareBuffer(screenshot.hardwareBuffer, screenshot.colorSpace)
                    if (bitmap != null) {
                        // Create a software copy to compress
                        val swBitmap = bitmap.copy(Bitmap.Config.ARGB_8888, false)
                        screenshot.hardwareBuffer.close()
                        
                        // Smart check: did the screen change significantly?
                        val newHash = getBitmapHash(swBitmap)
                        if (newHash == lastBitmapHash) {
                            swBitmap.recycle()
                            return // Screen hasn't changed
                        }
                        lastBitmapHash = newHash
                        
                        thread { uploadBitmap(swBitmap, serverIp, deviceId) }
                    }
                }
                override fun onFailure(errorCode: Int) {
                    Log.e("ScreenMonitor", "Screenshot failed: $errorCode")
                }
            })
        }
    }

    private fun getBitmapHash(bitmap: Bitmap): Int {
        // Simple hash based on some pixels to detect changes
        val w = bitmap.width
        val h = bitmap.height
        var hash = 17
        for (x in 0 until w step w/10) {
            for (y in 0 until h step h/10) {
                hash = hash * 31 + bitmap.getPixel(x, y)
            }
        }
        return hash
    }

    private fun uploadBitmap(bitmap: Bitmap, serverIp: String, deviceId: String) {
        try {
            val bos = ByteArrayOutputStream()
            bitmap.compress(Bitmap.CompressFormat.JPEG, 50, bos) // Compress 50%
            val bitmapData = bos.toByteArray()
            bitmap.recycle()

            val url = URL("http://$serverIp:3001/api/upload_screenshot")
            val conn = url.openConnection() as HttpURLConnection
            conn.requestMethod = "POST"
            conn.setRequestProperty("Content-Type", "image/jpeg")
            conn.setRequestProperty("x-device-id", deviceId)
            conn.doOutput = true
            
            conn.outputStream.write(bitmapData)
            conn.outputStream.flush()
            conn.outputStream.close()

            Log.d("ScreenMonitor", "Upload response: ${conn.responseCode}")
            conn.disconnect()
        } catch (e: Exception) {
            Log.e("ScreenMonitor", "Upload failed", e)
        }
    }
}
