from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def read(rel: str) -> str:
    return (ROOT / rel).read_text(encoding="utf-8")


def write(rel: str, content: str) -> None:
    path = ROOT / rel
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")


def replace_once(rel: str, old: str, new: str) -> None:
    text = read(rel)
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"Expected exactly one match in {rel}, found {count}: {old[:80]!r}")
    write(rel, text.replace(old, new, 1))


def sub_once(rel: str, pattern: str, replacement: str, flags: int = re.DOTALL) -> None:
    text = read(rel)
    updated, count = re.subn(pattern, replacement, text, count=1, flags=flags)
    if count != 1:
        raise RuntimeError(f"Expected exactly one regex match in {rel}: {pattern[:100]!r}")
    write(rel, updated)


# ---------------------------------------------------------------------------
# Never bundle TLS private keys into source control or the packaged executable.
# ---------------------------------------------------------------------------
bundle = read("server/build_bundle.js")
bundle = re.sub(
    r"\nlet sslKey = '';\nlet sslCert = '';\ntry \{.*?\n\}\n",
    "\n// TLS keys are generated per installation at runtime and are never bundled.\n",
    bundle,
    count=1,
    flags=re.DOTALL,
)
bundle = bundle.replace(
    "out.push('  },');\nout.push(`  sslKey: ${JSON.stringify(sslKey)},`);\nout.push(`  sslCert: ${JSON.stringify(sslCert)}`);\nout.push('};');",
    "out.push('  }');\nout.push('};');",
)
if "sslKey" in bundle or "sslCert" in bundle:
    raise RuntimeError("TLS key material is still referenced by build_bundle.js")
write("server/build_bundle.js", bundle)

public_bundle = ROOT / "server/public_bundle.js"
if public_bundle.exists():
    public_bundle.unlink()

gitignore = read(".gitignore")
if "server/public_bundle.js" not in gitignore:
    gitignore = gitignore.replace("server/server.cert\n", "server/server.cert\nserver/public_bundle.js\n")
write(".gitignore", gitignore)


# ---------------------------------------------------------------------------
# Persist a random token per device and verify it with constant-time compares.
# ---------------------------------------------------------------------------
replace_once(
    "server/db.js",
    "const generatePassword = () => {\n    return crypto.randomBytes(6).toString('base64url');\n};",
    "const generatePassword = () => {\n    return crypto.randomBytes(6).toString('base64url');\n};\n\nconst generateDeviceToken = () => crypto.randomBytes(32).toString('base64url');",
)

sub_once(
    "server/db.js",
    r"    registerUser: \(name, device_id, ip, default_limit\) => \{.*?\n    \},\n\n    updateUserIp:",
    """    registerUser: (name, device_id, ip, default_limit) => {
        let user = data.users.find(u => u.device_id === device_id);
        if (!user) {
            const existingIpUser = data.users.find(u => u.current_ip === ip && !u.device_id);
            if (existingIpUser) {
                existingIpUser.device_id = device_id;
                if (name) existingIpUser.name = name;
                user = existingIpUser;
            } else {
                const maxId = data.users.reduce((max, u) => Math.max(max, u.id), 0);
                user = {
                    id: maxId + 1,
                    name,
                    device_id,
                    device_token: generateDeviceToken(),
                    current_ip: ip,
                    daily_limit_mb: default_limit,
                    weekly_limit_mb: default_limit * 7,
                    speed_limit_bps: null,
                    exhausted_speed_limit_bps: null,
                    status: 'active',
                    registered_at: getLocalDateString()
                };
                data.users.push(user);
            }
        } else {
            user.current_ip = ip;
            if (name) user.name = name;
        }
        if (!user.device_token) user.device_token = generateDeviceToken();
        save();
        return user;
    },

    updateUserIp:""",
)

replace_once(
    "server/db.js",
    "    getUserByDeviceId: (device_id) => data.users.find(u => u.device_id === device_id),\n    getUserById: (id) => data.users.find(u => u.id === parseInt(id)),",
    """    getUserByDeviceId: (device_id) => data.users.find(u => u.device_id === device_id),
    verifyDeviceToken: (device_id, token) => {
        const user = data.users.find(u => u.device_id === device_id);
        if (!user || !user.device_token || typeof token !== 'string') return false;
        const expected = Buffer.from(user.device_token);
        const supplied = Buffer.from(token);
        return expected.length === supplied.length && crypto.timingSafeEqual(expected, supplied);
    },
    getUserById: (id) => data.users.find(u => u.id === parseInt(id)),""",
)


# ---------------------------------------------------------------------------
# Secure device APIs, physical-IP reports, TLS generation, and rate limiting.
# ---------------------------------------------------------------------------
replace_once(
    "server/index.js",
    "const os = require('os');\nconst { Transform } = require('stream');",
    "const os = require('os');\nconst crypto = require('crypto');\nconst { Transform } = require('stream');",
)

sub_once(
    "server/index.js",
    r"const getCleanIp = \(req\) => \{.*?\n\};",
    """const normalizeIp = (ip = '') => {
    if (ip.startsWith('::ffff:')) return ip.substring(7);
    if (ip === '::1') return '127.0.0.1';
    return ip;
};

// Never trust x-forwarded-for on a directly exposed LAN service.
const getCleanIp = (req) => normalizeIp(req.socket.remoteAddress || '');

const publicUser = (user) => {
    if (!user) return user;
    const { device_token, ...safeUser } = user;
    return safeUser;
};

const requireDevice = (req, res, deviceId) => {
    const token = req.headers['x-device-token'];
    if (!db.verifyDeviceToken(deviceId, token)) {
        res.status(401).json({ error: 'Invalid device credentials' });
        return null;
    }
    return db.getUserByDeviceId(deviceId);
};

const usedNetworkSignatures = new Map();
const verifyNetworkSignature = (deviceId, timestamp, signature) => {
    const user = db.getUserByDeviceId(deviceId);
    const timestampNumber = Number(timestamp);
    if (!user || !user.device_token || !Number.isFinite(timestampNumber) || typeof signature !== 'string') return false;
    if (Math.abs(Date.now() - timestampNumber) > 30_000) return false;

    const now = Date.now();
    for (const [usedSignature, usedAt] of usedNetworkSignatures) {
        if (now - usedAt > 60_000) usedNetworkSignatures.delete(usedSignature);
    }
    if (usedNetworkSignatures.has(signature)) return false;

    const expectedHex = crypto
        .createHmac('sha256', user.device_token)
        .update(`${deviceId}:${timestamp}`)
        .digest('hex');
    const expected = Buffer.from(expectedHex, 'hex');
    const supplied = Buffer.from(signature, 'hex');
    const valid = expected.length === supplied.length && crypto.timingSafeEqual(expected, supplied);
    if (valid) usedNetworkSignatures.set(signature, now);
    return valid;
};""",
)

sub_once(
    "server/index.js",
    r"app\.post\('/api/register'.*?\n\}\);\n\n// --- ADMIN API ---",
    """app.post('/api/register', (req, res) => {
    const { device_id, name, device_token } = req.body;
    const ip = getCleanIp(req);

    if (!device_id || !name) return res.status(400).json({ error: 'device_id and name required' });

    const existing = db.getUserByDeviceId(device_id);
    if (existing && existing.device_token && !db.verifyDeviceToken(device_id, device_token)) {
        return res.status(401).json({ error: 'Device is already registered' });
    }
    if (existing && !existing.device_token && existing.current_ip && existing.current_ip !== ip) {
        return res.status(401).json({ error: 'Legacy device migration must use its registered network address' });
    }

    const defaultLimit = db.getSetting('global_daily_limit_mb') || 1024;
    const user = db.registerUser(name, device_id, ip, defaultLimit);

    res.json({
        success: true,
        user: publicUser(user),
        device_token: user.device_token,
        registered_ip: ip
    });
});

app.post('/api/ping', (req, res) => {
    res.json({ success: true });
});

const handleNetworkPing = (req, res) => {
    const { device_id } = req.body;
    const timestamp = req.headers['x-device-timestamp'];
    const signature = req.headers['x-device-signature'];
    const ip = getCleanIp(req);

    if (!verifyNetworkSignature(device_id, timestamp, signature)) {
        return res.status(401).json({ error: 'Invalid or replayed network signature' });
    }

    const user = db.getUserByDeviceId(device_id);
    if (!user) return res.status(404).json({ error: 'User not found' });

    if (user.current_ip !== ip) {
        db.updateUserIp(device_id, ip);
        appendDebugLog(`${new Date().toISOString()} [NETWORK_PING ${user.name} #${user.id}] ${ip}`);
    }
    res.json({ success: true, registered_ip: ip });
};

app.post('/api/network_ping', handleNetworkPing);

app.post('/api/clear_notification', (req, res) => {
    const { device_id } = req.body;
    const user = requireDevice(req, res, device_id);
    if (!user) return;
    db.clearNotification(user.id);
    res.json({ success: true });
});

app.post('/api/debug', (req, res) => {
    const { device_id, logs } = req.body;
    const user = requireDevice(req, res, device_id);
    if (!user) return;
    if (!Array.isArray(logs)) return res.status(400).json({ error: 'logs must be an array' });

    const prefix = `${new Date().toISOString()} [${user.name} #${user.id}]`;
    const lines = logs.slice(-100)
        .map(log => `${prefix} ${String(log).replace(/[\\r\\n]/g, ' ').slice(0, 2000)}`)
        .join('\\n');
    appendDebugLog(lines);
    res.json({ success: true });
});

app.get('/api/status/:device_id', (req, res) => {
    const deviceId = req.params.device_id;
    const user = requireDevice(req, res, deviceId);
    if (!user) return;
    const today = db.getLocalDateString();

    const bytesUsed = db.getUsage(user.id, today);
    const weeklyBytesUsed = db.getWeeklyUsage(user.id);
    const dailyLimitBytes = user.daily_limit_mb * 1024 * 1024;
    const weeklyLimitBytes = (user.weekly_limit_mb || (user.daily_limit_mb * 7)) * 1024 * 1024;

    res.json({
        user: publicUser(user),
        usage_today_bytes: bytesUsed,
        daily_remaining_bytes: Math.max(0, dailyLimitBytes - bytesUsed),
        weekly_usage_bytes: weeklyBytesUsed,
        weekly_limit_bytes: weeklyLimitBytes,
        can_connect: getEffectiveUserSpeed(user) > 0,
        pending_notification: user.pending_notification || null
    });
});

// --- ADMIN API ---""",
)

replace_once(
    "server/index.js",
    "    res.json(db.getUsersWithUsage(today));",
    "    res.json(db.getUsersWithUsage(today).map(publicUser));",
)

replace_once(
    "server/index.js",
    "            if (bytesPerSecond === Infinity || !bytesPerSecond) return callback(null, chunk);\n            if (bytesPerSecond <= 0) return callback(new Error('User speed limit reached'));",
    "            if (bytesPerSecond <= 0) return callback(new Error('User speed limit reached'));\n            if (bytesPerSecond === Infinity) return callback(null, chunk);",
)

sub_once(
    "server/index.js",
    r"function getSSL\(\) \{.*?\n\}\n\nconst localIP",
    """function getSSL() {
    const keyPath = path.join(appDir, 'server.key');
    const certPath = path.join(appDir, 'server.cert');
    const rotationMarker = path.join(appDir, 'ssl_key_version_2');

    // Rotate the previously bundled/mass-shared key once on upgrade.
    if (!fs.existsSync(rotationMarker)) {
        try { fs.unlinkSync(keyPath); } catch (_) {}
        try { fs.unlinkSync(certPath); } catch (_) {}
    }

    try {
        if (fs.existsSync(keyPath) && fs.existsSync(certPath)) {
            return {
                key: fs.readFileSync(keyPath, 'utf8'),
                cert: fs.readFileSync(certPath, 'utf8')
            };
        }

        const forge = require('node-forge');
        const keys = forge.pki.rsa.generateKeyPair(2048);
        const cert = forge.pki.createCertificate();
        cert.publicKey = keys.publicKey;
        cert.serialNumber = crypto.randomBytes(16).toString('hex');
        cert.validity.notBefore = new Date();
        cert.validity.notAfter = new Date();
        cert.validity.notAfter.setFullYear(cert.validity.notBefore.getFullYear() + 10);
        const ip = getLocalIP();
        const attributes = [{ name: 'commonName', value: ip }];
        cert.setSubject(attributes);
        cert.setIssuer(attributes);
        cert.setExtensions([{
            name: 'subjectAltName',
            altNames: [{ type: 7, ip }]
        }]);
        cert.sign(keys.privateKey, forge.md.sha256.create());
        const keyPem = forge.pki.privateKeyToPem(keys.privateKey);
        const certPem = forge.pki.certificateToPem(cert);
        fs.writeFileSync(keyPath, keyPem, { mode: 0o600 });
        fs.writeFileSync(certPath, certPem);
        fs.writeFileSync(rotationMarker, 'per-installation TLS key v2\\n');
        console.log(`[SSL] Generated a unique self-signed certificate for IP: ${ip}`);
        return { key: keyPem, cert: certPem };
    } catch (error) {
        console.error('[SSL] Failed to prepare certificate:', error.message);
        return null;
    }
}

const localIP""",
)

sub_once(
    "server/index.js",
    r"try \{\n    const https = require\('https'\);.*?\n\}\n\nproxyServer\.listen",
    """try {
    const https = require('https');
    const ssl = getSSL();
    if (!ssl) throw new Error('TLS certificate unavailable');
    https.createServer(ssl, app).listen(API_PORT, '0.0.0.0', () => {
        console.log(`Giga Limit API running securely on HTTPS port ${API_PORT}`);
        console.log(`Admin login: https://${localIP}:${API_PORT} (password in admin_credentials.txt)`);
        console.log(`Local: https://localhost:${API_PORT}`);
    });
} catch (error) {
    console.error(`[SSL] Refusing to expose the admin API without HTTPS: ${error.message}`);
    process.exit(1);
}

// Plain HTTP is restricted to the signed physical-IP report only.
const physicalIpApp = express();
physicalIpApp.use(express.json({ limit: '16kb' }));
physicalIpApp.post('/api/network_ping', handleNetworkPing);
physicalIpApp.listen(3001, '0.0.0.0', () => {
    console.log('Signed physical-IP reporter listening on HTTP port 3001');
});

proxyServer.listen""",
)


# ---------------------------------------------------------------------------
# Pin the server certificate in Flutter and attach device credentials.
# ---------------------------------------------------------------------------
replace_once(
    "mobile_app/lib/main.dart",
    "final FlutterLocalNotificationsPlugin flutterLocalNotificationsPlugin = FlutterLocalNotificationsPlugin();",
    """final FlutterLocalNotificationsPlugin flutterLocalNotificationsPlugin = FlutterLocalNotificationsPlugin();
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
}""",
)

sub_once(
    "mobile_app/lib/main.dart",
    r"class MyHttpOverrides extends HttpOverrides \{.*?\n\}",
    """class MyHttpOverrides extends HttpOverrides {
  @override
  HttpClient createHttpClient(SecurityContext? context) {
    return super.createHttpClient(context)
      ..badCertificateCallback = (X509Certificate cert, String host, int port) {
        return port == 3000 && trustedServerCertificateSha1.contains(cert.sha1);
      };
  }
}""",
)

replace_once(
    "mobile_app/lib/main.dart",
    "  HttpOverrides.global = MyHttpOverrides();\n  await initNotifications();",
    "  await loadTrustedServerCertificate();\n  HttpOverrides.global = MyHttpOverrides();\n  await initNotifications();",
)

sub_once(
    "mobile_app/lib/main.dart",
    r"  Future<void> _checkRegistration\(\) async \{.*?\n  \}\n\n  @override\n  Widget build",
    """  Future<void> _checkRegistration() async {
    final prefs = await SharedPreferences.getInstance();
    final deviceId = prefs.getString('device_id');
    final serverIp = prefs.getString('server_ip');

    if (deviceId != null && deviceId.isNotEmpty &&
        trustedServerCertificateSha1.isEmpty && serverIp != null && serverIp.isNotEmpty) {
      try {
        await trustServerCertificate(serverIp);
      } catch (_) {
        // The dashboard will show the connection failure without trusting a changed certificate silently.
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
  Widget build""",
)

sub_once(
    "mobile_app/lib/main.dart",
    r"  Future<void> _register\(\) async \{.*?\n  \}\n\n  void _showError",
    """  Future<void> _register() async {
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
    } catch (e) {
      _showError('تعذر إنشاء اتصال آمن بالسيرفر على $serverIp');
    } finally {
      if (mounted) setState(() => _isLoading = false);
    }
  }

  void _showError""",
)

replace_once(
    "mobile_app/lib/main.dart",
    "  String deviceId = \"\";\n  Map<String, dynamic> stats",
    "  String deviceId = \"\";\n  String deviceToken = \"\";\n  Map<String, dynamic> stats",
)

replace_once(
    "mobile_app/lib/main.dart",
    "          'device_id': deviceId,\n        });",
    "          'device_id': deviceId,\n          'device_token': deviceToken,\n        });",
)

replace_once(
    "mobile_app/lib/main.dart",
    "        headers: {'Content-Type': 'application/json'},\n        body: jsonEncode({'device_id': deviceId, 'logs': logs}),",
    "        headers: {'Content-Type': 'application/json', 'X-Device-Token': deviceToken},\n        body: jsonEncode({'device_id': deviceId, 'logs': logs}),",
)

sub_once(
    "mobile_app/lib/main.dart",
    r"  Future<void> _pingServer\(\) async \{.*?\n  \}",
    """  Future<void> _pingServer() async {
    if (serverIp.isEmpty || deviceId.isEmpty || deviceToken.isEmpty) return;
    try {
      await http.get(
        Uri.parse('https://$serverIp:3000/api/status/$deviceId'),
        headers: {'X-Device-Token': deviceToken},
      );
    } catch (e) {
      print('Ping failed: $e');
    }
  }""",
)

sub_once(
    "mobile_app/lib/main.dart",
    r"  Future<void> _loadData\(\) async \{.*?\n  \}\n\n  Future<void> _fetchStats",
    """  Future<void> _loadData() async {
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

  Future<void> _fetchStats""",
)

replace_once(
    "mobile_app/lib/main.dart",
    "      final res = await http.get(Uri.parse('https://$serverIp:3000/api/status/$deviceId'));",
    "      final res = await http.get(\n        Uri.parse('https://$serverIp:3000/api/status/$deviceId'),\n        headers: {'X-Device-Token': deviceToken},\n      );",
)

replace_once(
    "mobile_app/lib/main.dart",
    "              headers: {'Content-Type': 'application/json'},\n              body: jsonEncode({'device_id': deviceId})",
    "              headers: {'Content-Type': 'application/json', 'X-Device-Token': deviceToken},\n              body: jsonEncode({'device_id': deviceId})",
)


# ---------------------------------------------------------------------------
# Pass the device token into the VPN service and sign physical-IP reports.
# ---------------------------------------------------------------------------
main_activity = read("mobile_app/android/app/src/main/kotlin/com/example/mobile_app/MainActivity.kt")
main_activity = main_activity.replace(
    "    private var pendingDeviceId: String? = null\n",
    "    private var pendingDeviceId: String? = null\n    private var pendingDeviceToken: String? = null\n",
)
main_activity = main_activity.replace(
    "                        val deviceId = call.argument<String>(\"device_id\")\n                        if (serverIp == null || deviceId == null) {\n                            result.error(\"INVALID_ARGS\", \"server_ip and device_id required\", null)",
    "                        val deviceId = call.argument<String>(\"device_id\")\n                        val deviceToken = call.argument<String>(\"device_token\")\n                        if (serverIp == null || deviceId == null || deviceToken == null) {\n                            result.error(\"INVALID_ARGS\", \"server_ip, device_id and device_token required\", null)",
)
main_activity = main_activity.replace(
    "                            pendingDeviceId = deviceId\n                            vpnResult = result",
    "                            pendingDeviceId = deviceId\n                            pendingDeviceToken = deviceToken\n                            vpnResult = result",
)
main_activity = main_activity.replace(
    "                            startVpnService(serverIp, deviceId)",
    "                            startVpnService(serverIp, deviceId, deviceToken)",
    1,
)
main_activity = main_activity.replace(
    "                val deviceId = pendingDeviceId\n                if (serverIp != null && deviceId != null) {\n                    startVpnService(serverIp, deviceId)",
    "                val deviceId = pendingDeviceId\n                val deviceToken = pendingDeviceToken\n                if (serverIp != null && deviceId != null && deviceToken != null) {\n                    startVpnService(serverIp, deviceId, deviceToken)",
)
main_activity = main_activity.replace(
    "            pendingDeviceId = null\n            vpnResult = null",
    "            pendingDeviceId = null\n            pendingDeviceToken = null\n            vpnResult = null",
)
main_activity = main_activity.replace(
    "    private fun startVpnService(serverIp: String, deviceId: String) {",
    "    private fun startVpnService(serverIp: String, deviceId: String, deviceToken: String) {",
)
main_activity = main_activity.replace(
    "        intent.putExtra(\"device_id\", deviceId)\n",
    "        intent.putExtra(\"device_id\", deviceId)\n        intent.putExtra(\"device_token\", deviceToken)\n",
)
write("mobile_app/android/app/src/main/kotlin/com/example/mobile_app/MainActivity.kt", main_activity)

vpn = read("mobile_app/android/app/src/main/kotlin/com/example/mobile_app/VpnProxyService.kt")
vpn = vpn.replace(
    "import java.util.concurrent.TimeUnit\n",
    "import java.util.concurrent.TimeUnit\nimport javax.crypto.Mac\nimport javax.crypto.spec.SecretKeySpec\n",
)
vpn = vpn.replace(
    "        val deviceId = intent.getStringExtra(\"device_id\") ?: run {\n            addDebug(\"VPN start rejected: missing device ID\")\n            stopSelf()\n            return START_NOT_STICKY\n        }\n\n        startVpn(serverIp, deviceId)",
    "        val deviceId = intent.getStringExtra(\"device_id\") ?: run {\n            addDebug(\"VPN start rejected: missing device ID\")\n            stopSelf()\n            return START_NOT_STICKY\n        }\n        val deviceToken = intent.getStringExtra(\"device_token\") ?: run {\n            addDebug(\"VPN start rejected: missing device token\")\n            stopSelf()\n            return START_NOT_STICKY\n        }\n\n        startVpn(serverIp, deviceId, deviceToken)",
)
vpn = vpn.replace(
    "    private fun startVpn(serverIp: String, deviceId: String) {",
    "    private fun startVpn(serverIp: String, deviceId: String, deviceToken: String) {",
)
vpn = vpn.replace("reportPhysicalIp(serverIp, deviceId)", "reportPhysicalIp(serverIp, deviceId, deviceToken)")
vpn = vpn.replace("monitorNetworkChanges(serverIp, deviceId)", "monitorNetworkChanges(serverIp, deviceId, deviceToken)")
vpn = vpn.replace("startIpReporter(serverIp, deviceId)", "startIpReporter(serverIp, deviceId, deviceToken)")
vpn = vpn.replace(
    "    private fun reportPhysicalIp(serverIp: String, deviceId: String, logSuccess: Boolean = true) {",
    "    private fun reportPhysicalIp(serverIp: String, deviceId: String, deviceToken: String, logSuccess: Boolean = true) {",
)
vpn = vpn.replace(
    "                     val body = \"{\\\"device_id\\\":\\\"${deviceId.replace(\"\\\\\", \"\\\\\\\\\").replace(\"\\\"\", \"\\\\\\\"\")}\\\"}\"\n                     val request = \"POST /api/network_ping HTTP/1.1\\r\\n\" +",
    "                     val body = \"{\\\"device_id\\\":\\\"${deviceId.replace(\"\\\\\", \"\\\\\\\\\").replace(\"\\\"\", \"\\\\\\\"\")}\\\"}\"\n                     val timestamp = System.currentTimeMillis().toString()\n                     val mac = Mac.getInstance(\"HmacSHA256\")\n                     mac.init(SecretKeySpec(deviceToken.toByteArray(Charsets.UTF_8), \"HmacSHA256\"))\n                     val signature = mac.doFinal(\"$deviceId:$timestamp\".toByteArray(Charsets.UTF_8))\n                         .joinToString(\"\") { byte -> \"%02x\".format(byte) }\n                     val request = \"POST /api/network_ping HTTP/1.1\\r\\n\" +",
)
vpn = vpn.replace(
    "                         \"Content-Type: application/json\\r\\n\" +\n                         \"Content-Length: ${body.toByteArray().size}\\r\\n\" +",
    "                         \"Content-Type: application/json\\r\\n\" +\n                         \"X-Device-Timestamp: $timestamp\\r\\n\" +\n                         \"X-Device-Signature: $signature\\r\\n\" +\n                         \"Content-Length: ${body.toByteArray().size}\\r\\n\" +",
)
vpn = vpn.replace(
    "    private fun startIpReporter(serverIp: String, deviceId: String) {",
    "    private fun startIpReporter(serverIp: String, deviceId: String, deviceToken: String) {",
)
vpn = vpn.replace(
    "                { reportPhysicalIp(serverIp, deviceId, logSuccess = false) },",
    "                { reportPhysicalIp(serverIp, deviceId, deviceToken, logSuccess = false) },",
)
vpn = vpn.replace(
    "    private fun monitorNetworkChanges(serverIp: String, deviceId: String) {",
    "    private fun monitorNetworkChanges(serverIp: String, deviceId: String, deviceToken: String) {",
)
vpn = vpn.replace("reportPhysicalIp(serverIp, deviceId)\n", "reportPhysicalIp(serverIp, deviceId, deviceToken)\n")
write("mobile_app/android/app/src/main/kotlin/com/example/mobile_app/VpnProxyService.kt", vpn)


# ---------------------------------------------------------------------------
# Regression tests and CI/release workflow.
# ---------------------------------------------------------------------------
write(
    "server/test/security.test.js",
    """const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..', '..');
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8');

test('TLS private keys are never committed or bundled', () => {
  assert.equal(fs.existsSync(path.join(root, 'server/public_bundle.js')), false);
  const builder = read('server/build_bundle.js');
  assert.doesNotMatch(builder, /server\\.key|sslKey|BEGIN (RSA )?PRIVATE KEY/);
});

test('zero speed blocks a stream before the unlimited branch', () => {
  const source = read('server/index.js');
  const blockIndex = source.indexOf("if (bytesPerSecond <= 0) return callback(new Error('User speed limit reached'))");
  const unlimitedIndex = source.indexOf('if (bytesPerSecond === Infinity) return callback(null, chunk)');
  assert.ok(blockIndex >= 0 && unlimitedIndex > blockIndex);
});

test('device IP is taken from the socket and the HTTP port exposes only signed reporting', () => {
  const source = read('server/index.js');
  assert.match(source, /getCleanIp = \(req\) => normalizeIp\(req\\.socket\\.remoteAddress/);
  assert.doesNotMatch(source, /app\\.listen\(3001|app\\.listen\(HTTP_PORT/);
  assert.match(source, /physicalIpApp\\.post\('\/api\/network_ping', handleNetworkPing\)/);
  assert.match(source, /verifyNetworkSignature/);
});
""",
)

write(
    "mobile_app/test/widget_test.dart",
    """import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:mobile_app/main.dart';

void main() {
  testWidgets('Giga Limit starts on the boot screen', (WidgetTester tester) async {
    SharedPreferences.setMockInitialValues(<String, Object>{});
    await tester.pumpWidget(const GigaLimitApp());
    expect(find.byType(MaterialApp), findsOneWidget);
    expect(find.byType(CircularProgressIndicator), findsOneWidget);
  });
}
""",
)

write(
    ".github/workflows/build.yml",
    """name: Build and Test GigaLimit

on:
  pull_request:
    branches: [main]
  workflow_dispatch:

permissions:
  contents: write

jobs:
  build:
    runs-on: ubuntu-latest

    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Setup Java
        uses: actions/setup-java@v4
        with:
          distribution: temurin
          java-version: '17'

      - name: Setup Flutter
        uses: subosito/flutter-action@v2
        with:
          flutter-version: '3.44.0'
          channel: stable

      - name: Setup Go
        uses: actions/setup-go@v5
        with:
          go-version: '1.24'

      - name: Setup Android SDK
        uses: android-actions/setup-android@v3
        with:
          accept-android-sdk-licenses: true

      - name: Install Android NDK
        run: |
          sdkmanager "ndk;27.2.12479018"
          echo "NDK_HOME=$ANDROID_HOME/ndk/27.2.12479018" >> "$GITHUB_ENV"

      - name: Install server dependencies
        working-directory: server
        run: npm ci

      - name: Check server syntax
        working-directory: server
        run: |
          node --check index.js
          node --check db.js
          node --check build_bundle.js

      - name: Run server security tests
        working-directory: server
        run: node --test test/*.test.js

      - name: Build tun2socks c-shared for arm64-v8a
        working-directory: mobile_app/tun2socks
        run: |
          export CGO_ENABLED=1 GOOS=android GOARCH=arm64
          export CC=$ANDROID_HOME/ndk/27.2.12479018/toolchains/llvm/prebuilt/linux-x86_64/bin/aarch64-linux-android35-clang
          export CXX=$ANDROID_HOME/ndk/27.2.12479018/toolchains/llvm/prebuilt/linux-x86_64/bin/aarch64-linux-android35-clang++
          go build -v -buildmode=c-shared -o ../android/app/src/main/jniLibs/arm64-v8a/libtun2socks.so .

      - name: Build tun2socks c-shared for armeabi-v7a
        working-directory: mobile_app/tun2socks
        run: |
          export CGO_ENABLED=1 GOOS=android GOARCH=arm GOARM=7
          export CC=$ANDROID_HOME/ndk/27.2.12479018/toolchains/llvm/prebuilt/linux-x86_64/bin/armv7a-linux-androideabi35-clang
          export CXX=$ANDROID_HOME/ndk/27.2.12479018/toolchains/llvm/prebuilt/linux-x86_64/bin/armv7a-linux-androideabi35-clang++
          go build -v -buildmode=c-shared -o ../android/app/src/main/jniLibs/armeabi-v7a/libtun2socks.so .

      - name: Build tun2socks c-shared for x86_64
        working-directory: mobile_app/tun2socks
        run: |
          export CGO_ENABLED=1 GOOS=android GOARCH=amd64
          export CC=$ANDROID_HOME/ndk/27.2.12479018/toolchains/llvm/prebuilt/linux-x86_64/bin/x86_64-linux-android35-clang
          export CXX=$ANDROID_HOME/ndk/27.2.12479018/toolchains/llvm/prebuilt/linux-x86_64/bin/x86_64-linux-android35-clang++
          go build -v -buildmode=c-shared -o ../android/app/src/main/jniLibs/x86_64/libtun2socks.so .

      - name: Remove Go headers
        run: rm -f mobile_app/android/app/src/main/jniLibs/*/libtun2socks.h

      - name: Flutter dependencies
        working-directory: mobile_app
        run: flutter pub get

      - name: Flutter analyze
        working-directory: mobile_app
        run: flutter analyze

      - name: Flutter tests
        working-directory: mobile_app
        run: flutter test

      - name: Build Android APK
        working-directory: mobile_app
        run: |
          flutter build apk --release
          cp build/app/outputs/flutter-apk/app-release.apk build/app/outputs/flutter-apk/GigaLimit_App.apk

      - name: Build Windows server executable
        working-directory: server
        run: npm run build:exe

      - name: Create release tag
        if: github.event_name == 'workflow_dispatch'
        run: |
          TAG="v1.0.0-${{ github.run_number }}"
          git tag "$TAG"
          git push origin "$TAG"

      - name: Release matching server and app
        if: github.event_name == 'workflow_dispatch'
        uses: softprops/action-gh-release@v2
        with:
          tag_name: v1.0.0-${{ github.run_number }}
          name: GigaLimit v1.0.0-${{ github.run_number }}
          files: |
            mobile_app/build/app/outputs/flutter-apk/GigaLimit_App.apk
            server/GigaLimit_Server.exe
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
""",
)

# Remove the one-shot patch machinery after it has produced the real source changes.
workflow = ROOT / ".github/workflows/security-hotfix.yml"
if workflow.exists():
    workflow.unlink()
Path(__file__).unlink()

print("Security hotfix applied successfully")
