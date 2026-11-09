#!/usr/bin/env bash
# Deletes verification screenshots that are no longer being looked at.
#
# Evidence is captured constantly (adb screencap, CDP) and only matters while
# the round that produced it is still open. Without this, the folders accumulate
# tens of MB of full-screen PNGs nobody reads again.
#
# Deletion is conservative on two axes, because deleting the wrong file costs a
# re-run of the whole verification:
#   * AGE   — only files older than $MAX_AGE_MIN minutes.
#   * KEEP  — always keep the $KEEP newest files, even if they are old.
#
# Both folders are gitignored (see .gitignore: **/_android-evidence/,
# **/_evidence/), so nothing here can delete a tracked file.
#
# Usage: clean-shots.sh [maxAgeMinutes] [keep]
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
MAX_AGE_MIN="${1:-45}"
KEEP="${2:-5}"

DIRS=(
  "$ROOT/clients/mobile/scripts/_android-evidence"
  "$ROOT/server/scripts/_evidence"
)

now=$(date +%s)
total_killed=0
total_bytes=0

for dir in "${DIRS[@]}"; do
  [ -d "$dir" ] || continue

  # Newest-first list; the first $KEEP entries are exempt.
  mapfile -t kept < <(
    find "$dir" -maxdepth 1 -type f \( -name '*.png' -o -name '*.jpg' \) \
      -printf '%T@ %p\n' 2>/dev/null |
      sort -rn | head -n "$KEEP" | sed 's/^[^ ]* //'
  )

  is_kept() {
    local needle="$1"
    local k
    for k in "${kept[@]:-}"; do [ "$k" = "$needle" ] && return 0; done
    return 1
  }

  while IFS= read -r -d '' f; do
    is_kept "$f" && continue
    mtime=$(stat -c %Y "$f" 2>/dev/null) || continue
    age_min=$(( (now - mtime) / 60 ))
    [ "$age_min" -lt "$MAX_AGE_MIN" ] && continue
    size=$(stat -c %s "$f" 2>/dev/null) || size=0
    rm -f "$f" && total_killed=$((total_killed + 1)) && total_bytes=$((total_bytes + size))
  done < <(find "$dir" -maxdepth 1 -type f \( -name '*.png' -o -name '*.jpg' \) -print0 2>/dev/null)
done

if [ "$total_killed" -eq 0 ]; then
  echo "[clean-shots] nothing older than ${MAX_AGE_MIN}m (keeping newest ${KEEP})"
else
  echo "[clean-shots] removed ${total_killed} file(s), $((total_bytes / 1024)) KB"
fi
