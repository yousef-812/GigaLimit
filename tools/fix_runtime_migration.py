from pathlib import Path

path = Path(__file__).with_name('apply_runtime_security.py')
text = path.read_text(encoding='utf-8')

marker = '"Content-Type: application/json\\\\r\\\\n"'
marker_index = text.index(marker, text.index('vpn = re.sub('))
block_start = text.rfind('vpn = vpn.replace(', 0, marker_index)
block_end = text.index('vpn = vpn.replace(', marker_index)

replacement = '''vpn = re.sub(
    r'(\\s+"Content-Type: application/json\\\\r\\\\n" \\+\\n)(\\s+"Content-Length: \\${body\\.toByteArray\\(\\)\\.size}\\\\r\\\\n" \\+)',
    lambda match: (
        match.group(1)
        + match.group(2).split('"Content-Length', 1)[0]
        + '"X-Device-Timestamp: $timestamp\\\\r\\\\n" +\\n'
        + match.group(2).split('"Content-Length', 1)[0]
        + '"X-Device-Signature: $signature\\\\r\\\\n" +\\n'
        + match.group(2)
    ),
    vpn,
    count=1,
)
'''

text = text[:block_start] + replacement + text[block_end:]
path.write_text(text, encoding='utf-8')
Path(__file__).unlink()
print('Signed report header migration fixed')
