import 'dart:convert';
import 'dart:async';
import 'dart:io';
import 'package:flutter/material.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:http/http.dart' as http;
import 'package:flutter_local_notifications/flutter_local_notifications.dart';
import 'package:permission_handler/permission_handler.dart';
import 'package:connectivity_plus/connectivity_plus.dart';
import 'package:flutter/services.dart';

final FlutterLocalNotificationsPlugin flutterLocalNotificationsPlugin = FlutterLocalNotificationsPlugin();
final Set<String> trustedServerCertificateSha1 = <String>{};

Future<void> loadTrustedServerCertificate() async {
  final prefs = await SharedPreferences.getInstance();
  final fingerprint = prefs.getString('server_cert_sha1');
  if (fingerprint != null && fingerprint.isNotEmpty) {
    trustedServerCertificateSha1.add(fingerprint);
  }
}

Future<String> trustServerCertificate(String serverIp) async {
  final socket = await SecureSocket.connect(
    serverIp,
    3000,
    onBadCertificate: (_) => true,
  ).timeout(const Duration(seconds: 8));
  final certificate = socket.peerCertificate;
  socket.destroy();
  if (certificate == null) throw const HandshakeException('Server certificate unavailable');

  final prefs = await SharedPreferences.getInstance();
  await prefs.setString('server_cert_sha1', certificate.sha1);
  trustedServerCertificateSha1
    ..clear()
    ..add(certificate.sha1);
  return certificate.sha1;
}

Future<void> initNotifications() async {
  const AndroidInitializationSettings initializationSettingsAndroid = AndroidInitializationSettings('@mipmap/launcher_icon');
  const InitializationSettings initializationSettings = InitializationSettings(android: initializationSettingsAndroid);
  await flutterLocalNotificationsPlugin.initialize(initializationSettings);
}

class MyHttpOverrides extends HttpOverrides {
  @override
  HttpClient createHttpClient(SecurityContext? context) {
    return super.createHttpClient(context)
      ..badCertificateCallback = (X509Certificate cert, String host, int port) {
        return port == 3000 && trustedServerCertificateSha1.contains(cert.sha1);
      };
  }
}

void main() async {
  WidgetsFlutterBinding.ensureInitialized();
  await loadTrustedServerCertificate();
  HttpOverrides.global = MyHttpOverrides();
  await initNotifications();
  runApp(const GigaLimitApp());
}

class GigaLimitApp extends StatelessWidget {
  const GigaLimitApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'Giga Limit',
      theme: ThemeData(
        brightness: Brightness.dark,
        primaryColor: const Color(0xFFFFEFB3), // Butter
        scaffoldBackgroundColor: const Color(0xFF013E37), // Dark Green
        cardColor: const Color(0xFF002823), // Darker Green for cards
        fontFamily: 'Roboto',
      ),
      home: const BootScreen(),
      debugShowCheckedModeBanner: false,
    );
  }
}

class BootScreen extends StatefulWidget {
  const BootScreen({super.key});

  @override
  State<BootScreen> createState() => _BootScreenState();
}

class _BootScreenState extends State<BootScreen> {
  @override
  void initState() {
    super.initState();
    _checkRegistration();
  }

  Future<void> _checkRegistration() async {
    final prefs = await SharedPreferences.getInstance();
    final deviceId = prefs.getString('device_id');
    final serverIp = prefs.getString('server_ip');

    if (deviceId != null && deviceId.isNotEmpty &&
        trustedServerCertificateSha1.isEmpty && serverIp != null && serverIp.isNotEmpty) {
      try {
        await trustServerCertificate(serverIp);
      } catch (_) {
        // Never replace an existing pin silently.
      }
    }

    await Future.delayed(const Duration(milliseconds: 500));

    if (!mounted) return;
    if (deviceId != null && deviceId.isNotEmpty) {
      Navigator.pushReplacement(context, MaterialPageRoute(builder: (_) => const DashboardScreen()));
    } else {
      Navigator.pushReplacement(context, MaterialPageRoute(builder: (_) => const RegistrationScreen()));
    }
  }

  @override
  Widget build(BuildContext context) {
    return const Scaffold(
      body: Center(child: CircularProgressIndicator(color: Color(0xFFFFEFB3))),
    );
  }
}

class RegistrationScreen extends StatefulWidget {
  const RegistrationScreen({super.key});

  @override
  State<RegistrationScreen> createState() => _RegistrationScreenState();
}

class _RegistrationScreenState extends State<RegistrationScreen> {
  final _nameController = TextEditingController();
  final _ipController = TextEditingController();
  bool _isLoading = false;

  // Generate a random device ID for testing
  String _generateDeviceId() {
    return 'dev_${DateTime.now().millisecondsSinceEpoch}';
  }

  Future<void> _register() async {
    if (_nameController.text.isEmpty || _ipController.text.isEmpty) return;
    setState(() => _isLoading = true);

    final deviceId = _generateDeviceId();
    final serverIp = _ipController.text.trim();

    try {
      await trustServerCertificate(serverIp);
      final res = await http.post(
        Uri.parse('https://$serverIp:3000/api/register'),
        headers: {'Content-Type': 'application/json'},
        body: jsonEncode({'device_id': deviceId, 'name': _nameController.text}),
      );

      if (res.statusCode == 200) {
        final data = jsonDecode(res.body) as Map<String, dynamic>;
        final token = data['device_token'] as String?;
        if (token == null || token.isEmpty) throw const FormatException('Missing device token');

        final prefs = await SharedPreferences.getInstance();
        await prefs.setString('user_name', _nameController.text);
        await prefs.setString('device_id', deviceId);
        await prefs.setString('device_token', token);
        await prefs.setString('server_ip', serverIp);

        if (!mounted) return;
        Navigator.pushReplacement(context, MaterialPageRoute(builder: (_) => const DashboardScreen()));
      } else {
        _showError('فشل تسجيل الجهاز: ${res.body}');
      }
    } catch (_) {
      _showError('تعذر إنشاء اتصال آمن بالسيرفر على $serverIp');
    } finally {
      if (mounted) setState(() => _isLoading = false);
    }
  }

  void _showError(String msg) {
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(msg), backgroundColor: Colors.red));
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: SafeArea(
        child: Padding(
          padding: const EdgeInsets.all(24.0),
          child: Column(
            mainAxisAlignment: MainAxisAlignment.center,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              const Icon(Icons.wifi_lock, size: 80, color: Color(0xFF3B82F6)),
              const SizedBox(height: 32),
              const Text('مرحباً بك في Giga Limit', textAlign: TextAlign.center, style: TextStyle(fontSize: 28, fontWeight: FontWeight.bold)),
              const SizedBox(height: 24),
              TextField(
                controller: _nameController,
                style: const TextStyle(color: Colors.white),
                decoration: const InputDecoration(labelText: 'الاسم', filled: true, fillColor: Color(0xFF1E293B)),
              ),
              const SizedBox(height: 16),
              TextField(
                controller: _ipController,
                style: const TextStyle(color: Colors.white),
                decoration: const InputDecoration(labelText: 'IP جهاز السيرفر (مثال 192.168.1.5)', filled: true, fillColor: Color(0xFF1E293B)),
              ),
              const SizedBox(height: 24),
              ElevatedButton(
                onPressed: _isLoading ? null : _register,
                child: _isLoading ? const CircularProgressIndicator(color: Colors.white) : const Text('اتصال وتسجيل الجهاز'),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class DashboardScreen extends StatefulWidget {
  const DashboardScreen({super.key});

  @override
  State<DashboardScreen> createState() => _DashboardScreenState();
}

class _DashboardScreenState extends State<DashboardScreen> {
  static const _vpnChannel = MethodChannel('com.gigalimit.vpn');
  String userName = "مستخدم";
  String serverIp = "";
  String deviceId = "";
  String deviceToken = "";
  Map<String, dynamic> stats = {
    'usage_today_bytes': 0,
    'weekly_usage_bytes': 0,
    'daily_remaining_bytes': 1024 * 1024 * 1024,
    'weekly_limit_bytes': 7168 * 1024 * 1024,
    'user': {'daily_limit_mb': 1024, 'weekly_limit_mb': 7168, 'status': 'active'}
  };
  bool canConnect = true;
  bool _vpnConnected = false;
  Timer? _vpnStatusTimer;

  @override
  void initState() {
    super.initState();
    _requestPermissions();
    _initConnectivity();
    _loadData();
    _checkVpnStatus();
    _vpnStatusTimer = Timer.periodic(const Duration(seconds: 2), (_) {
      _checkVpnStatus();
      _flushVpnDebug();
    });
  }

  @override
  void dispose() {
    _vpnStatusTimer?.cancel();
    super.dispose();
  }

  Future<void> _checkVpnStatus() async {
    try {
      final result = await _vpnChannel.invokeMethod('getVpnStatus');
      if (mounted) setState(() => _vpnConnected = result == true);
    } catch (e) {
      print('VPN status check failed: $e');
    }
  }

  Future<void> _flushVpnDebug() async {
    if (serverIp.isEmpty || deviceId.isEmpty) return;
    try {
      final logs = await _vpnChannel.invokeMethod<List<dynamic>>('getVpnDebug');
      if (logs == null || logs.isEmpty) return;
      await http.post(
        Uri.parse('https://$serverIp:3000/api/debug'),
        headers: {'Content-Type': 'application/json', 'X-Device-Token': deviceToken},
        body: jsonEncode({'device_id': deviceId, 'logs': logs}),
      );
    } catch (_) {
      // Diagnostics must never interrupt the VPN or the user interface.
    }
  }

  Future<void> _toggleVpn() async {
    if (_vpnConnected) {
      try {
        await _vpnChannel.invokeMethod('stopVpn');
        if (mounted) setState(() => _vpnConnected = false);
      } catch (e) {
        print('VPN stop failed: $e');
      }
    } else {
      try {
        await _vpnChannel.invokeMethod('startVpn', {
          'server_ip': serverIp,
          'device_id': deviceId,
          'device_token': deviceToken,
        });
        if (mounted) setState(() => _vpnConnected = true);
      } catch (e) {
        if (mounted) {
          ScaffoldMessenger.of(context).showSnackBar(
            SnackBar(content: Text('فشل تشغيل VPN: $e'), backgroundColor: Colors.red),
          );
        }
      }
    }
  }

  Future<void> _requestPermissions() async {
    await Permission.notification.request();
  }

  void _initConnectivity() {
    Connectivity().onConnectivityChanged.listen((List<ConnectivityResult> result) {
      if (result.contains(ConnectivityResult.none)) {
        _showNotification('تنبيه انقطاع الشبكة 🚨', 'تم تغير الشبكة أو انقطاع الاتصال! ارجع للتطبيق أو تأكد من الـ VPN ليعمل الإنترنت.');
      } else {
        _pingServer();
      }
    });
  }

  Future<void> _pingServer() async {
    if (serverIp.isEmpty || deviceId.isEmpty || deviceToken.isEmpty) return;
    try {
      await http.get(
        Uri.parse('https://$serverIp:3000/api/status/$deviceId'),
        headers: {'X-Device-Token': deviceToken},
      );
    } catch (e) {
      print('Ping failed: $e');
    }
  }

  Future<void> _showNotification(String title, String body) async {
    const AndroidNotificationDetails androidDetails = AndroidNotificationDetails(
      'giga_limit_channel', 'Giga Limit Notifications',
      importance: Importance.max, priority: Priority.high,
    );
    const NotificationDetails platformDetails = NotificationDetails(android: androidDetails);
    await flutterLocalNotificationsPlugin.show(DateTime.now().millisecond, title, body, platformDetails);
  }

  void _checkThresholds(double dailyPct, double weeklyPct) async {
    final prefs = await SharedPreferences.getInstance();
    final todayStr = DateTime.now().toIso8601String().split('T')[0];

    void check(double pct, String type) {
      int threshold = 0;
      if (pct >= 1) threshold = 100;
      else if (pct >= 0.75) threshold = 75;
      else if (pct >= 0.5) threshold = 50;

      if (threshold > 0) {
        final key = 'notified_${type}_${threshold}_$todayStr';
        if (prefs.getBool(key) != true) {
          prefs.setBool(key, true);
          String typeName = type == 'daily' ? 'اليومية' : 'الأسبوعية';
          _showNotification('Giga Limit ⚠️', 'لقد تم استهلاك $threshold% من باقتك $typeName!');
        }
      }
    }

    check(dailyPct, 'daily');
    check(weeklyPct, 'weekly');
  }

  Future<void> _loadData() async {
    final prefs = await SharedPreferences.getInstance();
    setState(() {
      userName = prefs.getString('user_name') ?? 'مستخدم';
      serverIp = prefs.getString('server_ip') ?? '';
      deviceId = prefs.getString('device_id') ?? '';
      deviceToken = prefs.getString('device_token') ?? '';
    });

    if (deviceToken.isEmpty) await _refreshDeviceToken();
    _fetchStats();
    _pingServer();
    _flushVpnDebug();
  }

  Future<void> _refreshDeviceToken() async {
    if (serverIp.isEmpty || deviceId.isEmpty) return;
    try {
      final res = await http.post(
        Uri.parse('https://$serverIp:3000/api/register'),
        headers: {'Content-Type': 'application/json'},
        body: jsonEncode({
          'device_id': deviceId,
          'name': userName,
          'legacy_migration': true,
          if (deviceToken.isNotEmpty) 'device_token': deviceToken,
        }),
      );
      if (res.statusCode != 200) return;
      final data = jsonDecode(res.body) as Map<String, dynamic>;
      final token = data['device_token'] as String?;
      if (token == null || token.isEmpty) return;
      final prefs = await SharedPreferences.getInstance();
      await prefs.setString('device_token', token);
      if (mounted) setState(() => deviceToken = token);
    } catch (_) {}
  }

  Future<void> _fetchStats() async {
    if (serverIp.isEmpty) return;
    try {
      final res = await http.get(
        Uri.parse('https://$serverIp:3000/api/status/$deviceId'),
        headers: {'X-Device-Token': deviceToken},
      );
      if (res.statusCode == 200) {
        setState(() {
          final data = jsonDecode(res.body);
          stats = data;
          canConnect = data['can_connect'];
          
          final limitMB = stats['user']['daily_limit_mb'] ?? 1;
          final usedMB = (stats['usage_today_bytes'] / (1024 * 1024)).round();
          final wLimitMB = stats['user']['weekly_limit_mb'] ?? (limitMB * 7);
          final wUsedMB = ((stats['weekly_usage_bytes'] ?? 0) / (1024 * 1024)).round();
          
          _checkThresholds(usedMB / limitMB, wUsedMB / wLimitMB);

          if (data['pending_notification'] != null) {
            _showNotification('رسالة من الإدارة 📩', data['pending_notification']);
            http.post(
              Uri.parse('https://$serverIp:3000/api/clear_notification'),
              headers: {'Content-Type': 'application/json', 'X-Device-Token': deviceToken},
              body: jsonEncode({'device_id': deviceId})
            );
          }
        });
      }
    } catch (e) {
      print('Error fetching stats');
    }
    Future.delayed(const Duration(seconds: 5), _fetchStats); // Auto refresh
  }

  @override
  Widget build(BuildContext context) {
    final usedMB = (stats['usage_today_bytes'] / (1024 * 1024)).round();
    final limitMB = stats['user']['daily_limit_mb'];
    final wUsedMB = ((stats['weekly_usage_bytes'] ?? 0) / (1024 * 1024)).round();
    final wLimitMB = stats['user']['weekly_limit_mb'] ?? (limitMB * 7);
    
    return Scaffold(
      body: SafeArea(
        child: Column(
          children: [
            Padding(
              padding: const EdgeInsets.all(24.0),
              child: Row(
                mainAxisAlignment: MainAxisAlignment.spaceBetween,
                children: [
                  Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text('مرحباً، $userName', style: const TextStyle(fontSize: 24, fontWeight: FontWeight.bold)),
                      Row(
                        children: [
                          Icon(canConnect ? Icons.check_circle : Icons.error, color: canConnect ? Colors.green : Colors.red, size: 16),
                          const SizedBox(width: 8),
                          Text(canConnect ? 'الإنترنت متاح' : 'الإنترنت محظور', style: TextStyle(color: canConnect ? Colors.green : Colors.red)),
                        ],
                      ),
                    ],
                  ),
                  GestureDetector(
                    onTap: _toggleVpn,
                    child: Container(
                      padding: const EdgeInsets.all(12),
                      decoration: BoxDecoration(
                        color: _vpnConnected ? const Color(0xFF10B981) : const Color(0xFF374151),
                        borderRadius: BorderRadius.circular(16),
                      ),
                      child: Icon(
                        _vpnConnected ? Icons.wifi : Icons.wifi_off,
                        color: Colors.white,
                        size: 28,
                      ),
                    ),
                  ),
                ],
              ),
            ),
            Expanded(
              child: ListView(
                padding: const EdgeInsets.symmetric(horizontal: 24),
                children: [
                  _buildQuotaCard('الحصة اليومية', usedMB, limitMB, const Color(0xFFFFEFB3)),
                  const SizedBox(height: 16),
                  _buildQuotaCard('الحصة الأسبوعية', wUsedMB, wLimitMB, const Color(0xFFE6D38A)),
                  const SizedBox(height: 24),
                ],
              ),
            )
          ],
        ),
      ),
    );
  }

  Widget _buildQuotaCard(String title, int usedMB, int totalMB, Color color) {
    double percent = totalMB > 0 ? usedMB / totalMB : 0;
    if (percent > 1.0) percent = 1.0;
    
    return Container(
      padding: const EdgeInsets.all(24),
      decoration: BoxDecoration(
        color: const Color(0xFF002823), 
        borderRadius: BorderRadius.circular(24),
        boxShadow: const [
          BoxShadow(
            color: Colors.black45,
            blurRadius: 10,
            offset: Offset(0, 4),
          )
        ]
      ),
      child: Column(
        children: [
          Text(title, style: const TextStyle(fontSize: 22, fontWeight: FontWeight.bold, color: Colors.white)),
          const SizedBox(height: 32),
          SizedBox(
            width: 200,
            height: 200,
            child: Stack(
              fit: StackFit.expand,
              children: [
                CircularProgressIndicator(
                  value: percent,
                  strokeWidth: 20,
                  backgroundColor: color.withOpacity(0.1),
                  color: color,
                ),
                Center(
                  child: Column(
                    mainAxisAlignment: MainAxisAlignment.center,
                    children: [
                      Text(
                        '${(totalMB - usedMB > 0) ? (totalMB - usedMB) : 0}',
                        style: TextStyle(fontSize: 36, fontWeight: FontWeight.bold, color: color),
                      ),
                      const Text('ميجابايت متبقية', style: TextStyle(fontSize: 16, color: Colors.white70)),
                    ],
                  ),
                ),
              ],
            ),
          ),
          const SizedBox(height: 32),
          Text('تم استهلاك $usedMB من $totalMB ميجابايت', style: const TextStyle(color: Colors.white, fontSize: 18)),
        ],
      ),
    );
  }
}
