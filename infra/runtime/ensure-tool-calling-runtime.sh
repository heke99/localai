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
    {"role":"system","content":"This is a runtime protocol probe. Use the required tool exactly once and do not answer in plain text."},
    {"role":"user","content":"Call div3rsa_runtime_probe with nonce TOOL_CALL_OK."}
  ],
  "tools": [
    {
      "type":"function",
      "function":{
        "name":"div3rsa_runtime_probe",
        "description":"Deterministic protocol probe.",
        "parameters":{
          "type":"object",
          "additionalProperties":false,
          "required":["nonce"],
          "properties":{"nonce":{"type":"string"}}
        }
      }
    }
  ],
  "tool_choice":{"type":"function","function":{"name":"div3rsa_runtime_probe"}},
  "temperature":0,
  "max_tokens":256,
  "stream":false,
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
calls=message.get("tool_calls") or []
assert calls, f"tool_calls_missing:{message}"
call=calls[0]
fn=call.get("function") or {}
assert fn.get("name")=="div3rsa_runtime_probe", f"tool_name_mismatch:{fn.get('name')}"
args=fn.get("arguments")
if isinstance(args,str): args=json.loads(args)
assert isinstance(args,dict), "tool_arguments_invalid"
assert args.get("nonce")=="TOOL_CALL_OK", f"tool_nonce_mismatch:{args}"
PY
}

curl --fail --silent --show-error --max-time 5 "http://127.0.0.1:${MODEL_PORT}/health" >/dev/null \
  || fatal "generation runtime is unhealthy before tool-call probe"

if probe; then
  log "structured OpenAI tool calling healthy on 127.0.0.1:${MODEL_PORT}"
  exit 0
fi

log "structured tool-call probe failed; restarting llama-server with documented Jinja tool parsing enabled"
LLAMA_ARG_JINJA=1 DIV3RSA_FORCE_MODEL_RESTART=1 bash "$RECOVERY_SCRIPT"

probe || fatal "structured OpenAI tool calling still failed after Jinja-enabled recovery"
log "structured OpenAI tool calling recovered and verified"
