from pathlib import Path

path = Path(__file__).with_name('apply_runtime_security.py')
text = path.read_text(encoding='utf-8')

old_pattern = r'''r"try \{\n    const https = require\('https'\);.*?\n\}\n\nproxyServer\.listen"'''
new_pattern = r'''r"const localIP = getLocalIP\(\);.*?\nproxyServer\.listen"'''

if old_pattern not in text:
    raise RuntimeError('Original HTTPS matcher was not found')
text = text.replace(old_pattern, new_pattern, 1)

pattern_index = text.index(new_pattern)
replacement_index = text.index('    """try {', pattern_index)
text = text[:replacement_index] + '    """const localIP = getLocalIP();\n\ntry {' + text[replacement_index + len('    """try {'):]

path.write_text(text, encoding='utf-8')
workflow = Path(__file__).resolve().parents[1] / '.github/workflows/runtime-migration.yml'
if workflow.exists():
    workflow.unlink()
Path(__file__).unlink()
print('Runtime migration matcher fixed')
