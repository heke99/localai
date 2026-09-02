#!/usr/bin/env bash
set -Eeuo pipefail

log() { printf '[nuclei-templates] %s\n' "$*"; }
fatal() { log "$*" >&2; exit 1; }

TOOLS_ROOT="${DIV3RSA_SECURITY_TOOLS_ROOT:-/opt/div3rsa/security-tools}"
TEMPLATE_REPO="${DIV3RSA_NUCLEI_TEMPLATES_REPO:-https://github.com/projectdiscovery/nuclei-templates.git}"
TEMPLATE_COMMIT="${DIV3RSA_NUCLEI_TEMPLATES_COMMIT:-b98e6097cb84e73e7a480436062d685a8f898824}"
SNAPSHOT_ROOT="${DIV3RSA_NUCLEI_TEMPLATE_SNAPSHOT_ROOT:-${TOOLS_ROOT}/nuclei-template-snapshots}"
MIN_TEMPLATE_COUNT="${DIV3RSA_NUCLEI_MIN_TEMPLATE_COUNT:-200}"

SAFE_DIRS=(
  cves
  exposed-panels
  exposures
  misconfiguration
  technologies
  vulnerabilities
)

[[ "${EUID}" -eq 0 ]] || fatal "run as root on the runtime host"
[[ "$TEMPLATE_COMMIT" =~ ^[0-9a-fA-F]{40}$ ]] || fatal "template commit must be an exact 40-character sha"
[[ "$MIN_TEMPLATE_COUNT" =~ ^[0-9]+$ ]] || fatal "invalid minimum template count"
for cmd in git find grep cp install wc; do command -v "$cmd" >/dev/null 2>&1 || fatal "required command missing: $cmd"; done
id -u div3rsa-security >/dev/null 2>&1 || fatal "div3rsa-security account must exist before template provisioning"

install -d -o root -g div3rsa-security -m 0750 "$SNAPSHOT_ROOT"
destination="$SNAPSHOT_ROOT/$TEMPLATE_COMMIT"
marker="$destination/.snapshot-commit"

snapshot_valid() {
  [[ -f "$marker" ]] || return 1
  [[ "$(tr -d '\r\n' < "$marker")" == "$TEMPLATE_COMMIT" ]] || return 1
  for dir in "${SAFE_DIRS[@]}"; do [[ -d "$destination/http/$dir" ]] || return 1; done
  local count
  count="$(find "$destination/http" -type f \( -name '*.yaml' -o -name '*.yml' \) | wc -l | tr -d '[:space:]')"
  [[ "$count" =~ ^[0-9]+$ ]] && (( count >= MIN_TEMPLATE_COUNT ))
}

if snapshot_valid; then
  ln -sfn "$destination" "$SNAPSHOT_ROOT/current"
  log "snapshot already valid commit=$TEMPLATE_COMMIT"
  exit 0
fi

worktree="$(mktemp -d "${SNAPSHOT_ROOT}/.source.XXXXXX")"
staging="$(mktemp -d "${SNAPSHOT_ROOT}/.snapshot.XXXXXX")"
cleanup() { rm -rf "$worktree" "$staging"; }
trap cleanup EXIT

log "fetching pinned ProjectDiscovery template commit=$TEMPLATE_COMMIT"
git -C "$worktree" init -q
git -C "$worktree" remote add origin "$TEMPLATE_REPO"
git -C "$worktree" sparse-checkout init --cone
git -C "$worktree" sparse-checkout set "${SAFE_DIRS[@]/#/http/}"
git -C "$worktree" fetch --depth=1 --no-tags origin "$TEMPLATE_COMMIT"
actual_commit="$(git -C "$worktree" rev-parse FETCH_HEAD)"
[[ "$actual_commit" == "$TEMPLATE_COMMIT" ]] || fatal "template commit verification failed expected=$TEMPLATE_COMMIT actual=$actual_commit"
git -C "$worktree" checkout --detach -q FETCH_HEAD

install -d -o root -g div3rsa-security -m 0750 "$staging/http"
for dir in "${SAFE_DIRS[@]}"; do
  [[ -d "$worktree/http/$dir" ]] || fatal "pinned snapshot missing expected directory: http/$dir"
  cp -a "$worktree/http/$dir" "$staging/http/$dir"
done

# Keep the runtime snapshot HTTP-only and remove templates that explicitly
# require an external callback, brute-force/spray behavior, fuzzing, DoS,
# headless/code execution, or any non-HTTP protocol. Runtime flags repeat these
# restrictions, so this is a second independent deployment-time gate.
while IFS= read -r -d '' template; do
  if grep -Eqi \
    '^[[:space:]]*(dns|tcp|network|headless|code|javascript|file|ssl|websocket|whois):|interactsh-url|tags:[^#]*(credential-stuffing|token-spray|fuzz|intrusive|dos)' \
    "$template"; then
    rm -f "$template"
  fi
done < <(find "$staging/http" -type f \( -name '*.yaml' -o -name '*.yml' \) -print0)
find "$staging/http" -type d -empty -delete

template_count="$(find "$staging/http" -type f \( -name '*.yaml' -o -name '*.yml' \) | wc -l | tr -d '[:space:]')"
[[ "$template_count" =~ ^[0-9]+$ ]] || fatal "unable to count curated templates"
(( template_count >= MIN_TEMPLATE_COUNT )) || fatal "curated template snapshot unexpectedly small: $template_count"

printf '%s\n' "$TEMPLATE_COMMIT" > "$staging/.snapshot-commit"
{
  printf 'schema_version=1\n'
  printf 'source_repo=%s\n' "$TEMPLATE_REPO"
  printf 'source_commit=%s\n' "$TEMPLATE_COMMIT"
  printf 'template_count=%s\n' "$template_count"
  printf 'protocol=http\n'
  printf 'directories=%s\n' "$(IFS=,; echo "${SAFE_DIRS[*]}")"
} > "$staging/manifest.env"

chown -R root:div3rsa-security "$staging"
find "$staging" -type d -exec chmod 0750 {} +
find "$staging" -type f -exec chmod 0640 {} +

rm -rf "$destination"
mv "$staging" "$destination"
staging=""
ln -sfn "$destination" "$SNAPSHOT_ROOT/current"
trap - EXIT
rm -rf "$worktree"
worktree=""

log "pinned curated HTTP snapshot ready commit=$TEMPLATE_COMMIT templates=$template_count"
