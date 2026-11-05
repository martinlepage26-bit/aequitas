#!/usr/bin/env bash
# Take an application-consistent backup, then copy and verify it on the
# penguin-backups NFS store through Martin's pinned mtl-00-pve SSH route.
set -euo pipefail

cd "$(dirname "$0")"
backup_output="$(./backup.sh)"
printf '%s\n' "$backup_output"
backup_dir="${backup_output##*backup ok: }"
[[ -d "$backup_dir" && -f "$backup_dir/SHA256SUMS" ]] || {
  echo 'backup.sh did not return a complete backup directory' >&2
  exit 1
}

stamp="$(basename "$backup_dir")"
[[ "$stamp" =~ ^[0-9]{8}-[0-9]{4}$ ]] || {
  echo 'Unexpected backup directory name' >&2
  exit 1
}

remote_root=/mnt/pve/penguin-backups/aequitas/ct920
ssh -o BatchMode=yes mtl-00-pve \
  "findmnt -rn -T /mnt/pve/penguin-backups -t nfs4 >/dev/null && install -d -m 700 '$remote_root/daily/$stamp'"
rsync -a --chmod=D700,F600 "$backup_dir/" "mtl-00-pve:$remote_root/daily/$stamp/"
ssh -o BatchMode=yes mtl-00-pve \
  "cd '$remote_root/daily/$stamp' && sha256sum -c SHA256SUMS"
echo "offbox backup ok: $stamp"
