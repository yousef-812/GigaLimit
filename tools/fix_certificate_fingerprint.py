from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
path = ROOT / "mobile_app/lib/main.dart"
source = path.read_text(encoding="utf-8")

set_line = "final Set<String> trustedServerCertificateSha1 = <String>{};"
helper = """final Set<String> trustedServerCertificateSha1 = <String>{};

String certificateFingerprint(X509Certificate certificate) =>
    base64UrlEncode(certificate.sha1);"""
if "String certificateFingerprint(" not in source:
    if set_line not in source:
        raise RuntimeError("Trusted certificate set declaration not found")
    source = source.replace(set_line, helper, 1)

old_store = """  final prefs = await SharedPreferences.getInstance();
  await prefs.setString('server_cert_sha1', certificate.sha1);
  trustedServerCertificateSha1
    ..clear()
    ..add(certificate.sha1);
  return certificate.sha1;"""
new_store = """  final fingerprint = certificateFingerprint(certificate);
  final prefs = await SharedPreferences.getInstance();
  await prefs.setString('server_cert_sha1', fingerprint);
  trustedServerCertificateSha1
    ..clear()
    ..add(fingerprint);
  return fingerprint;"""
if old_store not in source:
    raise RuntimeError("Certificate persistence block not found")
source = source.replace(old_store, new_store, 1)

old_check = "trustedServerCertificateSha1.contains(cert.sha1)"
new_check = "trustedServerCertificateSha1.contains(certificateFingerprint(cert))"
if old_check not in source:
    raise RuntimeError("Certificate callback comparison not found")
source = source.replace(old_check, new_check, 1)

path.write_text(source, encoding="utf-8")
print("Certificate fingerprint compatibility fix applied")
