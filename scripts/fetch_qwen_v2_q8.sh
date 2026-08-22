#!/usr/bin/env bash
set -euo pipefail

revision="e335d239dbdfae590687e24b800e81a18d070ebe"
filename="Qwen3.8-27B-OBLITERATED-Q8_0.gguf"
expected_sha="4cfb568f17fb58a0373279cc3b73602a350e25aea2953ce087dcea6b51fa6f3c"
model_dir="${DIV3RSA_MODEL_DIR:-./var/models/qwen3.8-27b-obliterated-v2}"
target="${model_dir}/${filename}"
url="https://huggingface.co/OBLITERATUS/Qwen3.8-27B-OBLITERATED/resolve/${revision}/${filename}"

mkdir -p "${model_dir}"
curl --fail --location --continue-at - --output "${target}" "${url}"
actual_sha="$(sha256sum "${target}" | cut -d ' ' -f 1)"
if [[ "${actual_sha}" != "${expected_sha}" ]]; then
  echo "Model checksum mismatch: expected ${expected_sha}, got ${actual_sha}" >&2
  exit 1
fi
echo "Verified ${target} (${actual_sha})"
