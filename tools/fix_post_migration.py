from pathlib import Path

root = Path(__file__).resolve().parents[1]
server_path = root / 'server/index.js'
source = server_path.read_text(encoding='utf-8')

broken = "fs.writeFileSync(rotationMarker, 'per-installation TLS key v2\n');"
fixed = "fs.writeFileSync(rotationMarker, 'per-installation TLS key v2\\n');"

if broken not in source:
    raise RuntimeError('Broken TLS rotation marker was not found')
server_path.write_text(source.replace(broken, fixed, 1), encoding='utf-8')
Path(__file__).unlink()
print('Post-migration syntax fixed')
