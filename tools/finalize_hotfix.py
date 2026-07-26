from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

index_path = ROOT / "server/index.js"
index = index_path.read_text(encoding="utf-8")

valid_debug_block = """    const lines = logs.slice(-100)
        .map(log => `${prefix} ${String(log).replace(/[\\r\\n]/g, ' ').slice(0, 2000)}`)
        .join('\\n');
    appendDebugLog(lines);"""
index, debug_count = re.subn(
    r"    const lines = logs\.slice\(-100\).*?    appendDebugLog\(lines\);",
    lambda _: valid_debug_block,
    index,
    count=1,
    flags=re.DOTALL,
)
if debug_count != 1:
    raise RuntimeError("Could not repair the debug log sanitization block")

valid_marker = "fs.writeFileSync(rotationMarker, 'per-installation TLS key v2\\n');"
if valid_marker not in index:
    index, marker_count = re.subn(
        r"fs\.writeFileSync\(rotationMarker, 'per-installation TLS key v2\s*'\);",
        lambda _: valid_marker,
        index,
        count=1,
    )
    if marker_count != 1:
        raise RuntimeError("Could not repair the TLS rotation marker string")
index_path.write_text(index, encoding="utf-8")

main_path = ROOT / "mobile_app/lib/main.dart"
main = main_path.read_text(encoding="utf-8")
main = main.replace(
    "throw const HandshakeException('Server certificate unavailable');",
    "throw HandshakeException('Server certificate unavailable');",
)
main_path.write_text(main, encoding="utf-8")

print("Source fixes applied")
