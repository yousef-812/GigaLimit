from pathlib import Path

path = Path(__file__).resolve().parents[1] / "mobile_app/lib/main.dart"
source = path.read_text(encoding="utf-8")

old = """  final certificate = socket.peerCertificate;
  socket.destroy();
  if (certificate == null) throw HandshakeException('Server certificate unavailable');

  final prefs = await SharedPreferences.getInstance();
  await prefs.setString('server_cert_sha1', certificate.sha1);
  trustedServerCertificateSha1
    ..clear()
    ..add(certificate.sha1);
  return certificate.sha1;
"""
new = """  final certificate = socket.peerCertificate;
  socket.destroy();
  if (certificate == null) throw HandshakeException('Server certificate unavailable');

  final fingerprint = base64Encode(certificate.sha1);
  final prefs = await SharedPreferences.getInstance();
  await prefs.setString('server_cert_sha1', fingerprint);
  trustedServerCertificateSha1
    ..clear()
    ..add(fingerprint);
  return fingerprint;
"""

if old not in source:
    raise RuntimeError("Could not find certificate persistence block")
source = source.replace(old, new, 1)

old_callback = "return port == 3000 && trustedServerCertificateSha1.contains(cert.sha1);"
new_callback = "return port == 3000 && trustedServerCertificateSha1.contains(base64Encode(cert.sha1));"
if old_callback not in source:
    raise RuntimeError("Could not find pinned-certificate callback")
source = source.replace(old_callback, new_callback, 1)

path.write_text(source, encoding="utf-8")
print("Flutter certificate fingerprint conversion fixed")

# Trigger after workflow registration.
