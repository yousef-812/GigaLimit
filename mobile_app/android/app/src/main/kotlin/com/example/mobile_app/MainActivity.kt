package com.example.mobile_app

import android.content.Intent
import android.net.VpnService
import android.os.Bundle
import android.util.Log
import io.flutter.embedding.android.FlutterActivity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.MethodChannel

class MainActivity : FlutterActivity() {

    private val CHANNEL = "com.gigalimit.vpn"
    private var vpnResult: MethodChannel.Result? = null
    private var pendingServerIp: String? = null
    private var pendingDeviceId: String? = null
    private var pendingDeviceToken: String? = null
    private val VPN_REQUEST_CODE = 1001
    private external fun getNativeDebug(): Array<String>

    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)

        MethodChannel(flutterEngine.dartExecutor.binaryMessenger, CHANNEL)
            .setMethodCallHandler { call, result ->
                when (call.method) {
                    "startVpn" -> {
                        val serverIp = call.argument<String>("server_ip")
                        val deviceId = call.argument<String>("device_id")
                        val deviceToken = call.argument<String>("device_token")
                        if (serverIp == null || deviceId == null || deviceToken == null) {
                            result.error("INVALID_ARGS", "server_ip, device_id and device_token required", null)
                            return@setMethodCallHandler
                        }

                        val vpnIntent = VpnService.prepare(this)
                        if (vpnIntent != null) {
                            pendingServerIp = serverIp
                            pendingDeviceId = deviceId
                            pendingDeviceToken = deviceToken
                            vpnResult = result
                            startActivityForResult(vpnIntent, VPN_REQUEST_CODE)
                        } else {
                            startVpnService(serverIp, deviceId, deviceToken)
                            result.success(true)
                        }
                    }
                    "stopVpn" -> {
                        val intent = Intent(this, VpnProxyService::class.java)
                        intent.action = "com.example.mobile_app.STOP_VPN"
                        startService(intent)
                        result.success(true)
                    }
                    "getVpnStatus" -> {
                        result.success(VpnProxyService.isRunning)
                    }
                    "getVpnDebug" -> {
                        val logs = VpnProxyService.takeDebugMessages(this).toMutableList()
                        try {
                            logs.addAll(getNativeDebug())
                        } catch (_: Throwable) {
                            // The VPN library has not loaded yet.
                        }
                        result.success(logs)
                    }
                    else -> result.notImplemented()
                }
            }
    }

    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)

        if (requestCode == VPN_REQUEST_CODE) {
            if (resultCode == RESULT_OK) {
                val serverIp = pendingServerIp
                val deviceId = pendingDeviceId
                val deviceToken = pendingDeviceToken
                if (serverIp != null && deviceId != null && deviceToken != null) {
                    startVpnService(serverIp, deviceId, deviceToken)
                    vpnResult?.success(true)
                } else {
                    vpnResult?.error("NO_SERVER", "Server IP not available", null)
                }
            } else {
                vpnResult?.error("VPN_DENIED", "VPN permission denied by user", null)
            }
            pendingServerIp = null
            pendingDeviceId = null
            pendingDeviceToken = null
            vpnResult = null
        }
    }

    private fun startVpnService(serverIp: String, deviceId: String, deviceToken: String) {
        val intent = Intent(this, VpnProxyService::class.java)
        intent.putExtra("server_ip", serverIp)
        intent.putExtra("device_id", deviceId)
        intent.putExtra("device_token", deviceToken)
        startForegroundService(intent)
    }
}
