#!/usr/bin/env bash
set -Eeuo pipefail

log() { printf '[tool-calling-runtime] %s\n' "$*"; }
fatal() { log "$*" >&2; exit 1; }

ROOT_DIR="${DIV3RSA_LEGACY_ROOT_DIR:-/root/autodl-tmp/localai}"
REPO_DIR="${DIV3RSA_LEGACY_APP_DIR:-${ROOT_DIR}/app}"
MODEL_PORT="${DIV3RSA_MODEL_PORT:-6006}"
MODEL_ALIAS="${DIV3RSA_MODEL_RUNTIME_ALIAS:-localai-qwen38-v3-q8}"
API_KEY_FILE="${DIV3RSA_INFERENCE_API_KEY_FILE:-${ROOT_DIR}/secrets/inference-api-key}"
RECOVERY_SCRIPT="${REPO_DIR}/infra/runtime/recover-legacy-gpuhub.sh"

[[ -r "$API_KEY_FILE" ]] || fatal "inference API key file missing: $API_KEY_FILE"
[[ -f "$RECOVERY_SCRIPT" ]] || fatal "GPUHub recovery script missing: $RECOVERY_SCRIPT"

probe() {
  local api_key payload response
  api_key="$(head -n1 "$API_KEY_FILE")"
  payload="$(cat <<JSON
{
  "model": "${MODEL_ALIAS}",
  "messages": [
    {"role":"system","content":"RUNTIME FORCED TOOL CALL MODE. Do not answer normally. Return only the JSON object required by the output grammar."},
    {"role":"user","content":"Select div3rsa_runtime_probe with nonce TOOL_CALL_OK."}
  ],
  "json_schema": {
    "type":"object",
    "additionalProperties":false,
    "required":["name","arguments"],
    "properties":{
      "name":{"type":"string","enum":["div3rsa_runtime_probe"]},
      "arguments":{
        "type":"object",
        "additionalProperties":false,
        "required":["nonce"],
        "properties":{"nonce":{"type":"string","enum":["TOOL_CALL_OK"]}}
      }
    }
  },
  "temperature":0,
  "max_tokens":256,
  "stream":false,
  "reasoning_effort":"none",
  "chat_template_kwargs":{"enable_thinking":false}
}
JSON
)"
  response="$(curl --fail --silent --show-error --max-time 60 \
    -H "Authorization: Bearer ${api_key}" \
    -H 'Content-Type: application/json' \
    -d "$payload" \
    "http://127.0.0.1:${MODEL_PORT}/v1/chat/completions")" || return 1
  python3 - "$response" <<'PY'
import json, sys
body=json.loads(sys.argv[1])
choices=body.get("choices") or []
assert choices, "choices_missing"
message=choices[0].get("message") or {}
content=message.get("content")
assert isinstance(content,str) and content.strip(), f"schema_content_missing:{message}"
call=json.loads(content)
assert call.get("name")=="div3rsa_runtime_probe", f"tool_name_mismatch:{call.get('name')}"
args=call.get("arguments")
assert isinstance(args,dict), "tool_arguments_invalid"
assert args.get("nonce")=="TOOL_CALL_OK", f"tool_nonce_mismatch:{args}"
assert set(call)=={"name","arguments"}, f"tool_envelope_extra_fields:{call}"
assert set(args)=={"nonce"}, f"tool_arguments_extra_fields:{args}"
PY
}

curl --fail --silent --show-error --max-time 5 "http://127.0.0.1:${MODEL_PORT}/health" >/dev/null \
  || fatal "generation runtime is unhealthy before forced-tool schema probe"

if probe; then
  log "Qwen3.8 forced-tool JSON-schema protocol healthy on 127.0.0.1:${MODEL_PORT}"
  exit 0
fi

log "forced-tool schema probe failed; restarting llama-server with the tracked Jinja profile"
LLAMA_ARG_JINJA=true DIV3RSA_MODEL_JINJA=true DIV3RSA_FORCE_MODEL_RESTART=1 bash "$RECOVERY_SCRIPT"

probe || fatal "Qwen3.8 forced-tool JSON-schema protocol still failed after recovery"
log "Qwen3.8 forced-tool JSON-schema protocol recovered and verified"
