package com.example.mobile_app

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.net.VpnService
import android.os.Build
import android.os.ParcelFileDescriptor
import android.os.PowerManager
import android.util.Log
import java.io.BufferedReader
import java.io.InputStreamReader

class VpnProxyService : VpnService() {

    companion object {
        const val TAG = "VpnProxyService"
        const val CHANNEL_ID = "giga_limit_vpn"
        const val NOTIFICATION_ID = 1
        const val ACTION_STOP = "com.example.mobile_app.STOP_VPN"
        var isRunning = false
            private set
    }

    private var vpnInterface: ParcelFileDescriptor? = null
    private var tun2socksProcess: Process? = null
    private var wakeLock: PowerManager.WakeLock? = null

    override fun onCreate() {
        super.onCreate()
        isRunning = true
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            stopVpn()
            return START_NOT_STICKY
        }

        val serverIp = intent?.getStringExtra("server_ip") ?: run {
            stopSelf()
            return START_NOT_STICKY
        }

        startVpn(serverIp)
        return START_STICKY
    }

    private fun startVpn(serverIp: String) {
        createNotificationChannel()

        val builder = Builder()
        builder.setSession("Giga Limit")
        builder.addAddress("10.0.0.2", 32)
        builder.addRoute("0.0.0.0", 0)
        builder.addDnsServer("8.8.8.8")
        builder.addDnsServer("8.8.4.4")
        builder.setMtu(1500)
        builder.setBlocking(true)

        try {
            vpnInterface = builder.establish()
        } catch (e: Exception) {
            Log.e(TAG, "Failed to establish VPN", e)
            stopSelf()
            return
        }

        if (vpnInterface == null) {
            Log.e(TAG, "VPN interface is null - user denied or VPN already active")
            stopSelf()
            return
        }

        val notification = buildNotification()
        startForeground(NOTIFICATION_ID, notification)

        acquireWakeLock()
        startTun2socks(serverIp)
    }

    private fun startTun2socks(serverIp: String) {
        val fd = vpnInterface?.fd ?: run {
            Log.e(TAG, "VPN fd is null")
            stopSelf()
            return
        }
        val socksAddr = "$serverIp:1080"

        val nativeDir = applicationInfo.nativeLibraryDir
        val binaryFile = File(nativeDir, "libtun2socks.so")
        Log.i(TAG, "Looking for tun2socks: ${binaryFile.absolutePath} (exists=${binaryFile.exists()}, canExec=${binaryFile.canExecute()})")

        if (!binaryFile.exists()) {
            Log.e(TAG, "tun2socks binary not found in nativeLibraryDir: $nativeDir")
            Log.e(TAG, "Files in nativeLibDir: ${File(nativeDir).listFiles()?.joinToString { it.name } ?: "none"}")
            stopSelf()
            return
        }

        try {
            val pb = ProcessBuilder(
                binaryFile.absolutePath,
                fd.toString(),
                socksAddr
            )
            pb.directory(File(nativeDir))
            pb.redirectErrorStream(true)

            tun2socksProcess = pb.start()

            Thread {
                try {
                    val reader = BufferedReader(InputStreamReader(tun2socksProcess!!.inputStream))
                    var line: String?
                    while (reader.readLine().also { line = it } != null) {
                        Log.d(TAG, "tun2socks: $line")
                    }
                } catch (e: Exception) {
                    Log.e(TAG, "tun2socks output error", e)
                }
            }.start()

            Thread {
                try {
                    val exitCode = tun2socksProcess!!.waitFor()
                    Log.w(TAG, "tun2socks exited with code: $exitCode")
                    if (isRunning) {
                        stopVpn()
                    }
                } catch (e: Exception) {
                    Log.e(TAG, "tun2socks wait error", e)
                }
            }.start()

            Log.i(TAG, "tun2socks started, proxy: socks5://$socksAddr, fd: $fd")
        } catch (e: Exception) {
            Log.e(TAG, "Failed to start tun2socks", e)
            stopSelf()
        }
    }

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                CHANNEL_ID,
                "Giga Limit VPN",
                NotificationManager.IMPORTANCE_LOW
            ).apply {
                description = "VPN connection active"
                setShowBadge(false)
            }
            val nm = getSystemService(NotificationManager::class.java)
            nm.createNotificationChannel(channel)
        }
    }

    private fun buildNotification(): Notification {
        val stopIntent = Intent(this, VpnProxyService::class.java)
        stopIntent.action = ACTION_STOP
        val stopPendingIntent = PendingIntent.getService(
            this, 0, stopIntent,
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        )

        val openIntent = Intent(this, MainActivity::class.java)
        openIntent.flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
        val openPendingIntent = PendingIntent.getActivity(
            this, 0, openIntent,
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        )

        val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            Notification.Builder(this, CHANNEL_ID)
        } else {
            @Suppress("DEPRECATION")
            Notification.Builder(this)
        }

        return builder
            .setContentTitle("Giga Limit")
            .setContentText("VPN Active - Traffic is being monitored")
            .setSmallIcon(android.R.drawable.ic_lock_lock)
            .setContentIntent(openPendingIntent)
            .addAction(
                Notification.Action.Builder(
                    null, "Disconnect",
                    stopPendingIntent
                ).build()
            )
            .setOngoing(true)
            .build()
    }

    private fun acquireWakeLock() {
        val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
        wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "GigaLimit::VPN")
        wakeLock?.acquire(24 * 60 * 60 * 1000L)
    }

    private fun stopVpn() {
        isRunning = false
        try {
            tun2socksProcess?.destroy()
            tun2socksProcess = null
        } catch (e: Exception) {
            Log.e(TAG, "Error killing tun2socks", e)
        }

        try {
            vpnInterface?.close()
            vpnInterface = null
        } catch (e: Exception) {
            Log.e(TAG, "Error closing VPN interface", e)
        }

        try {
            wakeLock?.let {
                if (it.isHeld) it.release()
            }
            wakeLock = null
        } catch (e: Exception) {
            Log.e(TAG, "Error releasing wake lock", e)
        }

        stopForeground(STOP_FOREGROUND_REMOVE)
        stopSelf()
    }

    override fun onDestroy() {
        stopVpn()
        super.onDestroy()
    }

    override fun onRevoke() {
        stopVpn()
        super.onRevoke()
    }
}
