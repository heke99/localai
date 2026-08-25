#!/usr/bin/env bash
set -euo pipefail

revision="768dd4ca58e1af3593605d93abef2c1c45647a07"
filename="Qwen3.8-27B-OBLITERATED-Q8_0.gguf"
expected_sha="afa839b2fa5bc890e5735031dda2c6239d3b6bba3b6ffa29477cbc14a2e1f221"
expected_bytes="29047075872"
model_dir="${DIV3RSA_MODEL_DIR:-./var/models/qwen3.8-27b-obliterated-v3}"
target="${model_dir}/${filename}"
url="https://huggingface.co/OBLITERATUS/Qwen3.8-27B-OBLITERATED/resolve/${revision}/${filename}"

mkdir -p "${model_dir}"
curl --fail --location --continue-at - --output "${target}" "${url}"
actual_sha="$(sha256sum "${target}" | cut -d ' ' -f 1)"
actual_bytes="$(wc -c < "${target}" | tr -d ' ')"
if [[ "${actual_sha}" != "${expected_sha}" ]]; then
  echo "Model checksum mismatch: expected ${expected_sha}, got ${actual_sha}" >&2
  exit 1
fi
if [[ "${actual_bytes}" != "${expected_bytes}" ]]; then
  echo "Model size mismatch: expected ${expected_bytes}, got ${actual_bytes}" >&2
  exit 1
fi
echo "Verified ${target} (${actual_sha}, ${actual_bytes} bytes)"
