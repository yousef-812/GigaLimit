package com.example.mobile_app

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import android.net.VpnService
import android.os.Build
import android.os.ParcelFileDescriptor
import android.os.PowerManager
import android.util.Log
import java.net.InetSocketAddress
import java.net.Socket
import java.util.ArrayDeque

class VpnProxyService : VpnService() {

    companion object {
        const val TAG = "VpnProxyService"
        const val CHANNEL_ID = "giga_limit_vpn"
        const val NOTIFICATION_ID = 1
        const val ACTION_STOP = "com.example.mobile_app.STOP_VPN"
        var isRunning = false
            private set
        private var nativeLibraryLoaded = false
        private val debugMessages = ArrayDeque<String>()
        private const val DEBUG_PREFERENCES = "vpn_debug"
        private const val DEBUG_LOGS_KEY = "logs"
        private var debugContext: Context? = null

        @Synchronized
        private fun addDebug(message: String) {
            while (debugMessages.size >= 100) debugMessages.removeFirst()
            debugMessages.addLast("${System.currentTimeMillis()} $message")
            debugContext?.getSharedPreferences(DEBUG_PREFERENCES, Context.MODE_PRIVATE)
                ?.edit()
                ?.putString(DEBUG_LOGS_KEY, debugMessages.joinToString("\n"))
                ?.apply()
        }

        @Synchronized
        fun takeDebugMessages(context: Context): List<String> {
            debugContext = context.applicationContext
            val preferences = debugContext!!.getSharedPreferences(DEBUG_PREFERENCES, Context.MODE_PRIVATE)
            val messages = preferences.getString(DEBUG_LOGS_KEY, "")
                .orEmpty()
                .lineSequence()
                .filter { it.isNotBlank() }
                .toList()
            debugMessages.clear()
            preferences.edit().remove(DEBUG_LOGS_KEY).apply()
            return messages
        }
    }

    init {
        try {
            System.loadLibrary("tun2socks")
            nativeLibraryLoaded = true
            Log.i(TAG, "Loaded libtun2socks.so via JNI")
            addDebug("Native library loaded")
        } catch (e: UnsatisfiedLinkError) {
            Log.e(TAG, "Failed to load libtun2socks.so", e)
            addDebug("Native library load failed: ${e.message}")
        }
    }

    private external fun startNativeTun2Socks(fd: Int, socksAddr: String): Int
    private external fun stopNativeTun2Socks()

    private var vpnInterface: ParcelFileDescriptor? = null
    private var wakeLock: PowerManager.WakeLock? = null
    private var vpnThread: Thread? = null
    private var connectivityManager: ConnectivityManager? = null
    private var networkCallback: ConnectivityManager.NetworkCallback? = null

    override fun onCreate() {
        super.onCreate()
        debugContext = applicationContext
        addDebug("VPN service created")
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            addDebug("VPN stop requested")
            stopVpn()
            return START_NOT_STICKY
        }

        val serverIp = intent?.getStringExtra("server_ip") ?: run {
            addDebug("VPN start rejected: missing server IP")
            stopSelf()
            return START_NOT_STICKY
        }
        val deviceId = intent.getStringExtra("device_id") ?: run {
            addDebug("VPN start rejected: missing device ID")
            stopSelf()
            return START_NOT_STICKY
        }

        startVpn(serverIp, deviceId)
        return START_STICKY
    }

    private fun startVpn(serverIp: String, deviceId: String) {
        addDebug("VPN start requested for $serverIp:1080")
        if (!nativeLibraryLoaded) {
            Log.e(TAG, "libtun2socks.so is missing from this APK")
            addDebug("VPN start failed: native library is missing")
            stopSelf()
            return
        }

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
            addDebug("VPN establish failed: ${e.message}")
            stopSelf()
            return
        }

        if (vpnInterface == null) {
            Log.e(TAG, "VPN interface is null - user denied or VPN already active")
            addDebug("VPN establish returned a null interface")
            stopSelf()
            return
        }

        val notification = buildNotification()
        startForeground(NOTIFICATION_ID, notification)

        acquireWakeLock()
        isRunning = true
        addDebug("VPN interface established")
        reportPhysicalIp(serverIp, deviceId)
        monitorNetworkChanges(serverIp, deviceId)
        startTun2socks(serverIp)
    }

    private fun reportPhysicalIp(serverIp: String, deviceId: String) {
        Thread({
            try {
                Socket().use { socket ->
                    // Socket() is lazy on Android. Bind first so it owns an FD
                    // that VpnService.protect can exclude before connect().
                    socket.bind(InetSocketAddress(0))
                    if (!protect(socket)) {
                        addDebug("Physical IP report failed: socket protection rejected")
                        return@Thread
                    }
                    socket.connect(InetSocketAddress(serverIp, 3001), 5000)
                    val body = "{\"device_id\":\"${deviceId.replace("\\", "\\\\").replace("\"", "\\\"")}\"}"
                    val request = "POST /api/network_ping HTTP/1.1\r\n" +
                        "Host: $serverIp\r\n" +
                        "Content-Type: application/json\r\n" +
                        "Content-Length: ${body.toByteArray().size}\r\n" +
                        "Connection: close\r\n\r\n$body"
                    socket.getOutputStream().write(request.toByteArray())
                    socket.getOutputStream().flush()
                    addDebug("Physical IP report sent")
                }
            } catch (e: Exception) {
                addDebug("Physical IP report failed: ${e.message}")
            }
        }, "physical-ip-report").start()
    }

    private fun monitorNetworkChanges(serverIp: String, deviceId: String) {
        val manager = getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
        val callback = object : ConnectivityManager.NetworkCallback() {
            override fun onAvailable(network: Network) {
                addDebug("Physical network became available")
                reportPhysicalIp(serverIp, deviceId)
            }

            override fun onLinkPropertiesChanged(network: Network, linkProperties: android.net.LinkProperties) {
                addDebug("Physical network properties changed")
                reportPhysicalIp(serverIp, deviceId)
            }
        }
        try {
            val request = NetworkRequest.Builder()
                .addCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
                .addCapability(NetworkCapabilities.NET_CAPABILITY_NOT_VPN)
                .build()
            manager.registerNetworkCallback(request, callback)
            connectivityManager = manager
            networkCallback = callback
        } catch (e: Exception) {
            addDebug("Network monitor registration failed: ${e.message}")
        }
    }

    private fun startTun2socks(serverIp: String) {
        val fd = vpnInterface?.fd ?: run {
            Log.e(TAG, "VPN fd is null")
            stopSelf()
            return
        }
        val socksAddr = "$serverIp:1080"

        vpnThread = Thread({
            try {
                Log.i(TAG, "Calling native startTun2Socks: fd=$fd, addr=$socksAddr")
                val result = startNativeTun2Socks(fd, socksAddr)
                Log.i(TAG, "native startTun2Socks returned: $result")
                addDebug("Native engine exited with result $result")
                if (isRunning) {
                    stopVpn()
                }
            } catch (e: Throwable) {
                Log.e(TAG, "tun2socks native error", e)
                addDebug("Native engine crashed: ${e.message}")
                if (isRunning) {
                    stopVpn()
                }
            }
        }, "tun2socks-engine")
        vpnThread!!.isDaemon = true
        vpnThread!!.start()

        Log.i(TAG, "tun2socks JNI started, proxy: socks5://$socksAddr, fd: $fd")
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
        addDebug("VPN stopping")
        isRunning = false
        try {
            networkCallback?.let { connectivityManager?.unregisterNetworkCallback(it) }
            networkCallback = null
            connectivityManager = null
        } catch (e: Exception) {
            Log.e(TAG, "Error unregistering network monitor", e)
        }
        try {
            stopNativeTun2Socks()
        } catch (e: Exception) {
            Log.e(TAG, "Error stopping native tun2socks", e)
        }

        try {
            vpnThread?.interrupt()
            vpnThread = null
        } catch (e: Exception) {
            Log.e(TAG, "Error interrupting vpn thread", e)
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
        addDebug("VPN permission revoked by Android")
        stopVpn()
        super.onRevoke()
    }
}
