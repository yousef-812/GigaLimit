# Giga Limit

نظام محلي لإدارة حصص الإنترنت للأجهزة على نفس الشبكة. يشغل العميل السيرفر على جهاز Windows داخل الشبكة، ثم يثبت المستخدمون تطبيق Android ويتصلون بعنوان IP الخاص بهذا الجهاز. لا توجد خدمة سحابية أو قاعدة بيانات خارج الشبكة المحلية.

## مكونات المشروع

| المسار | المحتوى |
| --- | --- |
| `server/` | سيرفر Node.js ولوحة الإدارة وHTTP proxy وSOCKS5. |
| `mobile_app/` | تطبيق Flutter وVPN Android ومكتبة tun2socks المكتوبة بـGo. |
| `.github/workflows/build.yml` | يبني APK Release تلقائياً عند push إلى `main`. |

## قبل البدء

يجب تثبيت الأدوات التالية على جهاز البناء Windows:

1. [Git](https://git-scm.com/download/win) لتنزيل المشروع.
2. [Node.js LTS](https://nodejs.org/en/download) لتشغيل وبناء السيرفر.
3. [Go](https://go.dev/dl/) إصدار 1.21 أو أحدث لبناء مكتبة VPN.
4. [Flutter SDK](https://docs.flutter.dev/get-started/install/windows/mobile) إصدار 3.44 أو أحدث.
5. [Android Studio](https://developer.android.com/studio) مع Android SDK وAndroid NDK.

من Android Studio افتح `Settings > Languages & Frameworks > Android SDK > SDK Tools` وثبت:

- Android SDK Command-line Tools.
- NDK (Side by side).
- CMake.

بعد تثبيت Flutter نفذ الأمر التالي وتأكد أن Android toolchain بلا أخطاء:

```powershell
flutter doctor
```

## تنزيل المشروع

```powershell
git clone https://github.com/yousef-812/GigaLimit.git
cd GigaLimit
```

## بناء السيرفر التنفيذي

نفذ الأوامر التالية من PowerShell:

```powershell
cd server
npm ci
npm run build:exe
```

سينتج الملف:

```text
server\GigaLimit_Server.exe
```

لتشغيل السيرفر من المصدر بدلاً من EXE:

```powershell
npm start
```

## بناء APK

إذا كان NDK خارج `C:\AndroidSDK\ndk`، اضبط مساره قبل البناء. استبدل رقم الإصدار بالإصدار المثبت لديك:

```powershell
$env:ANDROID_NDK_HOME = "$env:LOCALAPPDATA\Android\Sdk\ndk\27.2.12479018"
```

ثم:

```powershell
cd mobile_app
flutter pub get
powershell -ExecutionPolicy Bypass -File .\build_tun2socks.ps1
flutter build apk --release
```

سينتج الملف:

```text
mobile_app\build\app\outputs\flutter-apk\app-release.apk
```

ملفات `libtun2socks.so` تتولد تلقائياً من سكربت البناء ولا يجب إضافتها إلى Git.

## تجهيز مجلد التوزيع

ضع EXE وAPK في نفس المجلد. هذا ضروري لكي يستطيع السيرفر توفير APK من صفحة التنزيل عبر `/download_app`.

من جذر المشروع نفذ:

```powershell
New-Item -ItemType Directory -Force -Path .\GigaLimit-Release
Copy-Item .\server\GigaLimit_Server.exe .\GigaLimit-Release\
Copy-Item .\mobile_app\build\app\outputs\flutter-apk\app-release.apk .\GigaLimit-Release\GigaLimit_App.apk
```

يكون شكل مجلد التوزيع النهائي:

```text
GigaLimit-Release\
  GigaLimit_Server.exe
  GigaLimit_App.apk
```

## تشغيل السيرفر عند العميل

1. انقل مجلد `GigaLimit-Release` كاملاً إلى جهاز العميل الذي سيكون السيرفر.
2. شغّل `GigaLimit_Server.exe`.
3. وافق على Windows Firewall واختر **Private networks**.
4. افتح لوحة الإدارة من نفس الجهاز أو أي جهاز على نفس الشبكة:

```text
https://IP-OF-SERVER:3000
```

مثال: `https://192.168.100.84:3000`

المنافذ المستخدمة:

| المنفذ | البروتوكول | الاستخدام |
| --- | --- | --- |
| 3000 | HTTPS/TCP | API ولوحة الإدارة. |
| 3001 | HTTP/TCP | تحديث IP الحقيقي للهاتف من خدمة VPN. |
| 8080 | HTTP/TCP | HTTP proxy. |
| 1080 | TCP وUDP | SOCKS5 وSOCKS UDP relay. |

إذا لم يظهر الإنترنت داخل VPN، تأكد أن Firewall يسمح لـ`GigaLimit_Server.exe` بهذه المنافذ على الشبكات الخاصة.

## كلمة مرور الإدارة

في أول تشغيل ينشئ السيرفر كلمة مرور عشوائية، ولا يطبعها في الطرفية. ستجدها فقط في:

```text
admin_credentials.txt
```

يوجد الملف بجانب `GigaLimit_Server.exe`. احتفظ به في مكان آمن ولا تشاركه. إذا كانت قاعدة البيانات القديمة تستخدم كلمة المرور الافتراضية `admin123`، فسيستبدلها السيرفر بكلمة مرور عشوائية عند أول تشغيل للإصدار الجديد.

## بيانات العميل والنسخ الاحتياطي

لا تحذف الملفات التالية من مجلد السيرفر:

| الملف | الغرض |
| --- | --- |
| `giga_limit_db.json` | قاعدة البيانات الأساسية: الإعدادات والأجهزة والاستهلاك. |
| `giga_limit_db.json.bak` | نسخة احتياطية كاملة تتجدد كل ساعة. |
| `admin_credentials.txt` | كلمة مرور الإدارة. |
| `server.key` و`server.cert` | شهادة HTTPS المحلية. |
| `vpn_debug.log` | آخر 1000 سجل تشخيص VPN فقط. |

الكتابة إلى قاعدة البيانات ذرية: يكتب السيرفر إلى ملف مؤقت ثم يستبدل الملف الأساسي، لتقليل خطر تلفه عند إغلاق الجهاز أو انقطاع الكهرباء. إذا وجد السيرفر أن `giga_limit_db.json` فارغ أو تالف عند بدء التشغيل، يستعيد البيانات تلقائياً من `giga_limit_db.json.bak`، بما في ذلك الأجهزة والاستهلاك.

لنسخ احتياطي يدوي، أوقف السيرفر أولاً ثم انسخ المجلد بالكامل أو انسخ ملفي قاعدة البيانات معاً.

## تثبيت التطبيق للمستخدم

1. أرسل `GigaLimit_App.apk` إلى هاتف Android أو نزله من `https://IP-OF-SERVER:3000/download_app`.
2. اسمح بالتثبيت من مصدر غير معروف عند طلب Android ذلك.
3. افتح التطبيق، اكتب الاسم وIP جهاز السيرفر.
4. وافق على إذن VPN وإذن الإشعارات.
5. اضغط زر VPN.

التطبيق يرسل IP الحقيقي للهاتف إلى السيرفر من خدمة VPN نفسها، ويراقب تغير الشبكة. عند الانتقال إلى شبكة أخرى يحدث IP خلال ثوانٍ حتى لو التطبيق في الخلفية، طالما خدمة VPN ما زالت ظاهرة في إشعارات Android.

## بناء APK عبر GitHub Actions

كل push إلى فرع `main` يشغل workflow يبني APK Release وينشره في GitHub Releases. هذا الـworkflow يبني APK فقط؛ بناء Server EXE يتم محلياً بالأمر `npm run build:exe`.

## تشخيص المشاكل

| المشكلة | الإجراء |
| --- | --- |
| التطبيق لا يصل للسيرفر | تأكد أن الهاتف والسيرفر على نفس الشبكة وأن IP صحيح. |
| VPN متصل ولا يوجد إنترنت | تأكد أن `GigaLimit_Server.exe` يعمل وأن Firewall يسمح بالمنافذ 1080 و3000 و3001. |
| IP المستخدم لا يتغير | تأكد من تشغيل أحدث EXE وأحدث APK، ثم راجع `vpn_debug.log` وابحث عن `NETWORK_PING`. |
| بيانات الإدارة اختفت | أوقف السيرفر وتحقق من `giga_limit_db.json.bak`؛ التشغيل الجديد يستعيده تلقائياً إن كان الملف الأساسي تالفاً أو فارغاً. |
| كلمة مرور الإدارة غير معروفة | افتح `admin_credentials.txt` بجانب EXE. |
