package com.example.mobile_app

import android.content.Context
import android.util.Log
import java.io.File
import java.io.FileOutputStream

object AssetHelper {
    private const val TAG = "AssetHelper"

    fun extractBinary(context: Context, assetName: String): File? {
        val outFile = File(context.filesDir, assetName)

        if (outFile.exists() && outFile.canExecute()) {
            Log.d(TAG, "Binary already extracted: ${outFile.absolutePath}")
            return outFile
        }

        return try {
            context.assets.open(assetName).use { input ->
                FileOutputStream(outFile).use { output ->
                    input.copyTo(output)
                }
            }

            Runtime.getRuntime().exec(arrayOf("chmod", "755", outFile.absolutePath)).waitFor()

            if (!outFile.canExecute()) {
                Log.w(TAG, "chmod failed, trying setExecutable")
                outFile.setExecutable(true, false)
            }

            Log.i(TAG, "Extracted binary: ${outFile.absolutePath} (${outFile.length()} bytes)")
            outFile
        } catch (e: Exception) {
            Log.e(TAG, "Failed to extract $assetName", e)
            outFile.delete()
            null
        }
    }

    fun getArchBinaryName(baseName: String): String {
        val abi = getDeviceAbi()
        return "${baseName}_$abi"
    }

    fun getDeviceAbi(): String {
        val supportedAbis = android.os.Build.SUPPORTED_ABIS
        return if (supportedAbis.isNotEmpty()) {
            val abi = supportedAbis[0]
            when {
                abi.contains("arm64") -> "arm64-v8a"
                abi.contains("arm") -> "armeabi-v7a"
                abi.contains("x86_64") -> "x86_64"
                abi.contains("x86") -> "x86"
                else -> "armeabi-v7a"
            }
        } else {
            @Suppress("DEPRECATION")
            val cpuAbi = android.os.Build.CPU_ABI
            when {
                cpuAbi.contains("arm64") -> "arm64-v8a"
                cpuAbi.contains("arm") -> "armeabi-v7a"
                else -> "armeabi-v7a"
            }
        }
    }

    fun listAssets(context: Context): Array<String> {
        return try {
            context.assets.list("") ?: emptyArray()
        } catch (e: Exception) {
            Log.e(TAG, "Failed to list assets", e)
            emptyArray()
        }
    }
}
