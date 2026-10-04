#!/bin/sh
set -eu
cd /opt/stacks/gods-eye-view

status_file=i18n-update-status
log_file=i18n-build.log
archive=i18n-update.tar.gz
new_image=gods-eye-view:88b8406-cf-i18n
old_tag=gods-eye-view:88b8406-cf-before-i18n
switched=0
backup=

on_exit() {
  code=$?
  trap - EXIT
  if [ "$code" -ne 0 ]; then
    if [ "$switched" -eq 1 ] && [ -n "$backup" ]; then
      cp "$backup/compose.yaml" compose.yaml
      if docker compose up -d --no-build >> "$log_file" 2>&1; then
        printf rolled-back > "$status_file"
      else
        printf rollback-failed > "$status_file"
      fi
    else
      printf failed > "$status_file"
    fi
  fi
  exit "$code"
}
trap on_exit EXIT

test -f "$archive"
printf preparing > "$status_file"
mkdir -p backups
chmod 700 backups
stamp=$(date -u +%Y%m%dT%H%M%SZ)
backup="backups/i18n-$stamp"
mkdir -m 700 "$backup"
cp .env "$backup/env"
chmod 600 "$backup/env"
cp compose.yaml "$backup/compose.yaml"
docker inspect --format '{{.Image}}' gods-eye-view > "$backup/image-id"
docker image tag "$(cat "$backup/image-id")" "$old_tag"
printf '%s' "$backup" > i18n-backup-path

# Only the reviewed source overlay is archived; credentials stay separate.
tar -tzf "$archive" > "$backup/overlay-files"
python3 - "$backup/overlay-files" "$backup/source-files" <<'PY'
from pathlib import Path, PurePosixPath
import sys
files = []
for name in Path(sys.argv[1]).read_text().splitlines():
    path = PurePosixPath(name)
    if path.is_absolute() or '..' in path.parts:
        raise ValueError('Invalid overlay path')
    current = Path('source', name)
    if current.is_file():
        files.append(name)
Path(sys.argv[2]).write_text('\n'.join(files) + '\n')
PY
tar -czf "$backup/source-files.tar.gz" -C source -T "$backup/source-files"
tar -xzf "$archive" -C source

printf building > "$status_file"
DOCKER_BUILDKIT=1 docker build --progress plain \
  --secret id=gev-build-env,src=.env \
  -f source/deployment/Dockerfile.i18n -t "$new_image" source > "$log_file" 2>&1

# Preserve all runtime settings and networks, changing only the image tag.
# Mark the switch before editing Compose so a validation failure restores it.
switched=1
python3 - "$new_image" <<'PY'
from pathlib import Path
import re, sys
path = Path('compose.yaml')
current = path.read_text()
updated, count = re.subn(r'(?m)^(    image: )gods-eye-view:[^\s]+$', lambda match: match[1] + sys.argv[1], current)
if count != 1:
    raise ValueError('Expected one gods-eye-view image entry')
Path('compose.i18n-new.yaml').write_text(updated)
Path('compose.i18n-new.yaml').replace(path)
PY
docker compose config --quiet
printf restarting > "$status_file"
docker compose up -d --no-build >> "$log_file" 2>&1

printf checking > "$status_file"
attempt=0
while [ "$attempt" -lt 30 ]; do
  health=$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{end}}' gods-eye-view)
  if [ "$health" = healthy ]; then
    printf complete > "$status_file"
    trap - EXIT
    exit 0
  fi
  if [ "$health" = unhealthy ]; then
    exit 1
  fi
  attempt=$((attempt + 1))
  sleep 3
done
exit 1
