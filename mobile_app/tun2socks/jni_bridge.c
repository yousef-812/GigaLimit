#include <jni.h>
#include <android/log.h>
#include <pthread.h>
#include <stdio.h>
#include <string.h>
#include "_cgo_export.h"

#define LOG_TAG "Tun2SocksNative"
#define LOGI(...) __android_log_print(ANDROID_LOG_INFO, LOG_TAG, __VA_ARGS__)
#define LOGE(...) __android_log_print(ANDROID_LOG_ERROR, LOG_TAG, __VA_ARGS__)

static JavaVM *java_vm;
static jobject vpn_service;
static jmethodID protect_socket_method;
static pthread_mutex_t debug_mutex = PTHREAD_MUTEX_INITIALIZER;
static char debug_messages[100][256];
static int debug_start;
static int debug_count;

void appendNativeDebug(const char *message) {
    pthread_mutex_lock(&debug_mutex);
    int index = (debug_start + debug_count) % 100;
    if (debug_count == 100) {
        debug_start = (debug_start + 1) % 100;
    } else {
        debug_count++;
    }
    snprintf(debug_messages[index], sizeof(debug_messages[index]), "%s", message);
    pthread_mutex_unlock(&debug_mutex);
}

JNIEXPORT jobjectArray JNICALL
Java_com_example_mobile_1app_MainActivity_getNativeDebug(JNIEnv *env, jobject thiz) {
    char messages[100][256];
    pthread_mutex_lock(&debug_mutex);
    int count = debug_count;
    for (int i = 0; i < count; i++) {
        snprintf(messages[i], sizeof(messages[i]), "%s", debug_messages[(debug_start + i) % 100]);
    }
    debug_start = 0;
    debug_count = 0;
    pthread_mutex_unlock(&debug_mutex);

    jclass string_class = (*env)->FindClass(env, "java/lang/String");
    jobjectArray result = (*env)->NewObjectArray(env, count, string_class, NULL);
    for (int i = 0; i < count; i++) {
        jstring message = (*env)->NewStringUTF(env, messages[i]);
        (*env)->SetObjectArrayElement(env, result, i, message);
        (*env)->DeleteLocalRef(env, message);
    }
    (*env)->DeleteLocalRef(env, string_class);
    return result;
}

static int set_vpn_service(JNIEnv *env, jobject service) {
    if ((*env)->GetJavaVM(env, &java_vm) != JNI_OK) {
        LOGE("Failed to get Java VM");
        return 0;
    }

    if (vpn_service != NULL) {
        (*env)->DeleteGlobalRef(env, vpn_service);
    }
    vpn_service = (*env)->NewGlobalRef(env, service);
    if (vpn_service == NULL) {
        LOGE("Failed to retain VPN service");
        return 0;
    }

    jclass service_class = (*env)->GetObjectClass(env, service);
    // VpnService.protect(int) is inherited by VpnProxyService and keeps the
    // SOCKS connection outside this VPN, avoiding a routing loop.
    protect_socket_method = (*env)->GetMethodID(env, service_class, "protect", "(I)Z");
    (*env)->DeleteLocalRef(env, service_class);
    if (protect_socket_method == NULL) {
        LOGE("Failed to find VpnService.protect");
        return 0;
    }
    return 1;
}

// Called from Go before connecting to the SOCKS server. Go worker threads are
// attached to the JVM on demand so VpnService.protect can be called safely.
int protectSocket(int fd) {
    if (java_vm == NULL || vpn_service == NULL || protect_socket_method == NULL) {
        LOGE("VPN service is not ready to protect socket");
        return 0;
    }

    JNIEnv *env = NULL;
    int attached = 0;
    jint status = (*java_vm)->GetEnv(java_vm, (void **)&env, JNI_VERSION_1_6);
    if (status == JNI_EDETACHED) {
        if ((*java_vm)->AttachCurrentThread(java_vm, &env, NULL) != JNI_OK) {
            LOGE("Failed to attach Go thread to JVM");
            return 0;
        }
        attached = 1;
    } else if (status != JNI_OK) {
        LOGE("Failed to access JVM from Go thread");
        return 0;
    }

    jboolean protected = (*env)->CallBooleanMethod(env, vpn_service, protect_socket_method, (jint)fd);
    if ((*env)->ExceptionCheck(env)) {
        (*env)->ExceptionDescribe(env);
        (*env)->ExceptionClear(env);
        protected = JNI_FALSE;
    }
    if (attached) {
        (*java_vm)->DetachCurrentThread(java_vm);
    }
    return protected == JNI_TRUE;
}

JNIEXPORT jint JNICALL
Java_com_example_mobile_1app_VpnProxyService_startNativeTun2Socks(
    JNIEnv *env, jobject thiz, jint fd, jstring socksAddr) {
    if (!set_vpn_service(env, thiz)) { return -1; }
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
