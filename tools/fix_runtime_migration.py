from pathlib import Path

path = Path(__file__).with_name('apply_runtime_security.py')
text = path.read_text(encoding='utf-8')

old_https_pattern = r'''r"try \{\n    const https = require\('https'\);.*?\n\}\n\nproxyServer\.listen"'''
new_https_pattern = r'''r"const localIP = getLocalIP\(\);.*?\nproxyServer\.listen"'''

if old_https_pattern in text:
    text = text.replace(old_https_pattern, new_https_pattern, 1)
    pattern_index = text.index(new_https_pattern)
    replacement_index = text.index('    """try {', pattern_index)
    text = text[:replacement_index] + '    """const localIP = getLocalIP();\n\ntry {' + text[replacement_index + len('    """try {'):]

vpn_block_start = text.index('vpn = re.sub(', text.index('private fun reportPhysicalIp'))
vpn_block_end = text.index('vpn = vpn.replace(', vpn_block_start)
new_vpn_block = '''vpn = re.sub(
    r'(\\s+val body = [^\\n]+\\n)(\\s+val request = "POST /api/network_ping HTTP/1\\.1\\\\r\\\\n" \\+)',
    lambda match: (
        match.group(1)
        + match.group(2).split('val request', 1)[0]
        + 'val timestamp = System.currentTimeMillis().toString()\\n'
        + match.group(2).split('val request', 1)[0]
        + 'val mac = Mac.getInstance("HmacSHA256")\\n'
        + match.group(2).split('val request', 1)[0]
        + 'mac.init(SecretKeySpec(deviceToken.toByteArray(Charsets.UTF_8), "HmacSHA256"))\\n'
        + match.group(2).split('val request', 1)[0]
        + 'val signature = mac.doFinal("$deviceId:$timestamp".toByteArray(Charsets.UTF_8))\\n'
        + match.group(2).split('val request', 1)[0]
        + '    .joinToString("") { byte -> "%02x".format(byte.toInt() and 0xff) }\\n'
        + match.group(2)
    ),
    vpn,
    count=1,
)
'''
text = text[:vpn_block_start] + new_vpn_block + text[vpn_block_end:]

path.write_text(text, encoding='utf-8')
workflow = Path(__file__).resolve().parents[1] / '.github/workflows/runtime-migration.yml'
if workflow.exists():
    workflow.unlink()
Path(__file__).unlink()
print('Runtime migration matchers fixed')
