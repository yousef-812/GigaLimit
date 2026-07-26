from pathlib import Path

root = Path(__file__).resolve().parents[1]
script_path = Path(__file__).with_name('apply_runtime_security.py')
script = script_path.read_text(encoding='utf-8')

old_block = '''vpn = vpn.replace(
    "                         \\"Content-Type: application/json\\\\r\\\\n\\" +\\n                         \\"Content-Length: ${body.toByteArray().size}\\\\r\\\\n\\" +",
    "                         \\"Content-Type: application/json\\\\r\\\\n\\" +\\n                         \\"X-Device-Timestamp: $timestamp\\\\r\\\\n\\" +\\n                         \\"X-Device-Signature: $signature\\\\r\\\\n\\" +\\n                         \\"Content-Length: ${body.toByteArray().size}\\\\r\\\\n\\" +",
)
'''

new_block = '''def add_signed_report_headers(match):
    indent = match.group(2)[: len(match.group(2)) - len(match.group(2).lstrip())]
    return (
        match.group(1)
        + indent + '"X-Device-Timestamp: $timestamp\\\\r\\\\n" +\\n'
        + indent + '"X-Device-Signature: $signature\\\\r\\\\n" +\\n'
        + match.group(2)
    )

vpn = re.sub(
    r'(\\s+"Content-Type: application/json\\\\r\\\\n" \\+\\n)(\\s+"Content-Length: \\${body\\.toByteArray\\(\\)\\.size}\\\\r\\\\n" \\+)',
    add_signed_report_headers,
    vpn,
    count=1,
)
'''

if old_block not in script:
    raise RuntimeError('The signed-report header migration block was not found')
script = script.replace(old_block, new_block, 1)

namespace = {
    '__file__': str(script_path),
    '__name__': '__main__',
}
exec(compile(script, str(script_path), 'exec'), namespace)

for temporary_path in (
    root / '.github/workflows/runtime-migration.yml',
    root / 'runtime_security_error.txt',
    Path(__file__),
):
    try:
        temporary_path.unlink()
    except FileNotFoundError:
        pass

print('Deterministic runtime security migration completed')
