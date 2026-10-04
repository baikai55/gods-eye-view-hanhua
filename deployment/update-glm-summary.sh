#!/bin/sh
set -eu
cd /opt/stacks/gods-eye-view
trap 'printf failed > glm-summary-update-status' EXIT
printf preparing > glm-summary-update-status

mkdir -p backups
chmod 700 backups
stamp=$(date -u +%Y%m%dT%H%M%SZ)
backup="backups/glm-summary-$stamp"
mkdir -m 700 "$backup"
cp .env "$backup/env"
chmod 600 "$backup/env"
cp compose.yaml "$backup/compose.yaml"
cp source/server/providers/openai/hud-summary.js "$backup/hud-summary.js"
cp source/.env.example "$backup/env.example"
docker inspect --format '{{.Image}}' gods-eye-view > "$backup/image-id"
docker image tag "$(cat "$backup/image-id")" gods-eye-view:88b8406-cf-before-glm-summary
printf '%s' "$backup" > glm-summary-backup-path

tar -xzf glm-summary-update.tar.gz -C source
printf building > glm-summary-update-status
docker build --progress plain -f source/deployment/Dockerfile.summary \
  -t gods-eye-view:88b8406-cf-glm-summary source > glm-summary-build.log 2>&1

printf configuring > glm-summary-update-status
python3 - <<'PY'
import os
from pathlib import Path
import yaml

cfg = yaml.safe_load(Path('/opt/stacks/cpa-manager-plus/cpa/config.yaml').read_text()) or {}
keys = cfg.get('api-keys') or []
if not keys or not isinstance(keys[0], str) or not keys[0].strip():
    raise ValueError('No CPA client key available')
key = keys[0].strip()
if any(c in key for c in '\r\n\x00'):
    raise ValueError('Invalid CPA client key format')

values = {
    'OPENAI_HUD_SUMMARY_API_KEY': key,
    'OPENAI_HUD_SUMMARY_BASE_URL': 'http://cli-proxy-api:8317/v1',
    'OPENAI_HUD_SUMMARY_API_FORMAT': 'chat-completions',
    'OPENAI_HUD_SUMMARY_MODEL': 'z-ai/glm-5.3-flash',
    'OPENAI_HUD_SUMMARY_LANGUAGE': 'zh-CN',
    'OPENAI_HUD_SUMMARY_REASONING_EFFORT': 'none',
}
env = Path('.env')
seen = set()
lines = []
for line in env.read_text().splitlines():
    name = line.split('=', 1)[0] if '=' in line and not line.startswith('#') else None
    if name in values:
        if name not in seen:
            lines.append(name + '=' + values[name])
            seen.add(name)
    else:
        lines.append(line)
for name in sorted(values.keys() - seen):
    lines.append(name + '=' + values[name])
# dotenv/Compose interpolation must preserve any literal dollar in a key.
for i, line in enumerate(lines):
    if line.startswith('OPENAI_HUD_SUMMARY_API_KEY='):
        if "'" in key:
            raise ValueError('Unsupported quote in CPA client key')
        lines[i] = "OPENAI_HUD_SUMMARY_API_KEY='" + key + "'"
fd = os.open('.env.glm-new', os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
with os.fdopen(fd, 'w') as file:
    file.write('\n'.join(lines) + '\n')
os.replace('.env.glm-new', env)
env.chmod(0o600)
print('Configured independent Chinese HUD summary provider')
PY

mv compose.glm-summary.yaml compose.yaml
docker compose config --quiet
printf restarting > glm-summary-update-status
docker compose up -d --no-build >> glm-summary-build.log 2>&1
printf complete > glm-summary-update-status
trap - EXIT
