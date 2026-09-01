#!/usr/bin/env bash
set -euo pipefail

revision="d20cf9c16f82914a21dbd9c645f56895fb1d7750"
filename="Qwen3-Embedding-0.6B-Q8_0.gguf"
expected_sha="06507c7b42688469c4e7298b0a1e16deff06caf291cf0a5b278c308249c3e439"
expected_bytes="639150592"
model_dir="${DIV3RSA_EMBEDDING_MODEL_DIR:-./var/models/qwen3-embedding-0.6b}"
target="${model_dir}/${filename}"
url="https://huggingface.co/Qwen/Qwen3-Embedding-0.6B-GGUF/resolve/${revision}/${filename}"

mkdir -p "${model_dir}"
curl --fail --location --continue-at - --output "${target}" "${url}"
actual_sha="$(sha256sum "${target}" | cut -d ' ' -f 1)"
actual_bytes="$(wc -c < "${target}" | tr -d ' ')"
if [[ "${actual_sha}" != "${expected_sha}" ]]; then
  echo "Embedding model checksum mismatch: expected ${expected_sha}, got ${actual_sha}" >&2
  exit 1
fi
if [[ "${actual_bytes}" != "${expected_bytes}" ]]; then
  echo "Embedding model size mismatch: expected ${expected_bytes}, got ${actual_bytes}" >&2
  exit 1
fi
echo "Verified ${target} (${actual_sha}, ${actual_bytes} bytes)"
