#include <jni.h>
#include <android/log.h>
#include "_cgo_export.h"

#define LOG_TAG "Tun2SocksNative"
#define LOGI(...) __android_log_print(ANDROID_LOG_INFO, LOG_TAG, __VA_ARGS__)
#define LOGE(...) __android_log_print(ANDROID_LOG_ERROR, LOG_TAG, __VA_ARGS__)

JNIEXPORT jint JNICALL
Java_com_example_mobile_1app_VpnProxyService_startNativeTun2Socks(
    JNIEnv *env, jobject thiz, jint fd, jstring socksAddr) {
    const char *addr = (*env)->GetStringUTFChars(env, socksAddr, NULL);
    if (addr == NULL) { LOGE("Failed to get SOCKS address"); return -1; }
    LOGI("Starting tun2socks: fd=%d addr=%s", fd, addr);
    int result = (int)goStartTun2Socks(fd, (char*)addr);
    (*env)->ReleaseStringUTFChars(env, socksAddr, addr);
    return result;
}

JNIEXPORT void JNICALL
Java_com_example_mobile_1app_VpnProxyService_stopNativeTun2Socks(
    JNIEnv *env, jobject thiz) {
    LOGI("Stopping tun2socks");
    goStopTun2Socks();
}
