#!/usr/bin/env bash
set -Eeuo pipefail

SEARCH_BASE_URL="${1:-${DIV3RSA_SEARCH_BASE_URL:-http://127.0.0.1:8890}}"
SEARCH_QUERY="${2:-IANA example domains}"
TIMEOUT_SECONDS="${DIV3RSA_SEARCH_HEALTH_TIMEOUT_SECONDS:-12}"
MAX_ATTEMPTS="${DIV3RSA_SEARCH_HEALTH_MAX_ATTEMPTS:-4}"
RETRY_DELAY_SECONDS="${DIV3RSA_SEARCH_HEALTH_RETRY_DELAY_SECONDS:-2}"
response_file="$(mktemp)"
trap 'rm -f "$response_file"' EXIT

command -v curl >/dev/null 2>&1 || { echo '[search-capability] curl is required' >&2; exit 2; }
command -v python3 >/dev/null 2>&1 || { echo '[search-capability] python3 is required' >&2; exit 2; }
[[ "$MAX_ATTEMPTS" =~ ^[1-9][0-9]*$ ]] || { echo '[search-capability] DIV3RSA_SEARCH_HEALTH_MAX_ATTEMPTS must be a positive integer' >&2; exit 2; }
[[ "$RETRY_DELAY_SECONDS" =~ ^[0-9]+([.][0-9]+)?$ ]] || { echo '[search-capability] DIV3RSA_SEARCH_HEALTH_RETRY_DELAY_SECONDS must be a non-negative number' >&2; exit 2; }

validate_response() {
  python3 - "$response_file" <<'PY'
import json
import sys

path = sys.argv[1]
try:
    with open(path, encoding="utf-8") as handle:
        payload = json.load(handle)
except (OSError, json.JSONDecodeError) as exc:
    print(f"[search-capability] invalid SearXNG JSON response: {exc}", file=sys.stderr)
    raise SystemExit(1)

results = payload.get("results") or []
unresponsive = payload.get("unresponsive_engines") or []
if not results:
    print(
        "[search-capability] HTTP request succeeded but search returned no usable results; "
        f"unresponsive_engines={json.dumps(unresponsive, ensure_ascii=False)}",
        file=sys.stderr,
    )
    raise SystemExit(1)

engines = sorted({str(item.get("engine")) for item in results if item.get("engine")})
print(
    f"[search-capability] usable_results={len(results)} "
    f"engines={json.dumps(engines, ensure_ascii=False)}"
)
PY
}

for ((attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1)); do
  : >"$response_file"
  request_ok=0
  if curl --get --fail --silent --show-error --max-time "$TIMEOUT_SECONDS" \
    --data-urlencode "q=${SEARCH_QUERY}" \
    --data-urlencode 'format=json' \
    "${SEARCH_BASE_URL%/}/search" >"$response_file"; then
    request_ok=1
  else
    echo "[search-capability] search request failed attempt=${attempt}/${MAX_ATTEMPTS}" >&2
  fi

  if [[ "$request_ok" -eq 1 ]] && validate_response; then
    if [[ "$attempt" -gt 1 ]]; then
      echo "[search-capability] recovered after transient search failure attempt=${attempt}/${MAX_ATTEMPTS}"
    fi
    exit 0
  fi

  if [[ "$attempt" -lt "$MAX_ATTEMPTS" ]]; then
    echo "[search-capability] retrying usable-result probe attempt=$((attempt + 1))/${MAX_ATTEMPTS}" >&2
    sleep "$RETRY_DELAY_SECONDS"
  fi
done

echo "[search-capability] exhausted ${MAX_ATTEMPTS} attempts without a usable search result" >&2
exit 1
