#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="${DIV3RSA_LEGACY_ROOT_DIR:-/root/autodl-tmp/localai}"
REPO_DIR="${DIV3RSA_LEGACY_APP_DIR:-${ROOT_DIR}/app}"
COMMIT="1b3f6b2286981381a5cc0566551ef3bb6bc38383"
REPOSITORY="mukul975/Anthropic-Cybersecurity-Skills"
BASE_DIR="${DIV3RSA_SECURITY_SKILL_BASE_DIR:-${ROOT_DIR}/runtime/security-skills}"
FINAL_DIR="${DIV3RSA_SECURITY_SKILL_ROOT:-${BASE_DIR}/${COMMIT}}"
ARCHIVE_URL="https://github.com/${REPOSITORY}/archive/${COMMIT}.tar.gz"

mkdir -p "$BASE_DIR"
TMP_DIR="$(mktemp -d "${BASE_DIR}/.sync-${COMMIT}.XXXXXX")"
ARCHIVE="${TMP_DIR}/upstream.tar.gz"
EXTRACTED="${TMP_DIR}/extracted"
SNAPSHOT="${TMP_DIR}/snapshot"

cleanup() { rm -rf "$TMP_DIR"; }
trap cleanup EXIT

mkdir -p "$EXTRACTED" "$SNAPSHOT/skills"

if [[ -f "$FINAL_DIR/source.json" && -f "$FINAL_DIR/index.json" ]]; then
  if node "$REPO_DIR/scripts/validate_security_skill_snapshot.mjs" "$FINAL_DIR" >/dev/null; then
    printf '[security-skills] snapshot already valid commit=%s root=%s\n' "$COMMIT" "$FINAL_DIR"
    exit 0
  fi
fi

command -v curl >/dev/null 2>&1 || { echo "curl is required for security skill sync" >&2; exit 1; }
command -v tar >/dev/null 2>&1 || { echo "tar is required for security skill sync" >&2; exit 1; }

curl --fail --location --silent --show-error \
  --retry 3 --retry-all-errors --connect-timeout 10 --max-time 180 \
  "$ARCHIVE_URL" -o "$ARCHIVE"

tar --extract --gzip --file "$ARCHIVE" --directory "$EXTRACTED" --no-same-owner --no-same-permissions
UPSTREAM_ROOT="$(find "$EXTRACTED" -mindepth 1 -maxdepth 1 -type d | head -n1)"
[[ -n "$UPSTREAM_ROOT" && -f "$UPSTREAM_ROOT/index.json" ]] || { echo "pinned upstream archive missing index.json" >&2; exit 1; }

cp "$UPSTREAM_ROOT/index.json" "$SNAPSHOT/index.json"
printf '{"repository":"%s","commit":"%s","license":"Apache-2.0","execution_class":"knowledge_only"}\n' \
  "$REPOSITORY" "$COMMIT" > "$SNAPSHOT/source.json"

while IFS= read -r skill_file; do
  rel="${skill_file#${UPSTREAM_ROOT}/}"
  [[ "$rel" == skills/*/SKILL.md ]] || continue
  destination="$SNAPSHOT/$rel"
  mkdir -p "$(dirname "$destination")"
  cp "$skill_file" "$destination"
done < <(find "$UPSTREAM_ROOT/skills" -mindepth 2 -maxdepth 2 -type f -name SKILL.md -print | sort)

node "$REPO_DIR/scripts/validate_security_skill_snapshot.mjs" "$SNAPSHOT"

rm -rf "${FINAL_DIR}.new"
mv "$SNAPSHOT" "${FINAL_DIR}.new"
rm -rf "$FINAL_DIR"
mv "${FINAL_DIR}.new" "$FINAL_DIR"
printf '[security-skills] synced commit=%s root=%s\n' "$COMMIT" "$FINAL_DIR"
