begin;

alter table internal.model_artifacts
  alter column tokenizer_sha256 drop not null,
  alter column chat_template_sha256 drop not null;

insert into internal.model_versions (
  model_id,
  version_key,
  repository,
  revision,
  license,
  context_window,
  capabilities,
  status,
  metadata
)
select
  m.id,
  'v3-q8-0',
  'OBLITERATUS/Qwen3.8-27B-OBLITERATED',
  '768dd4ca58e1af3593605d93abef2c1c45647a07',
  'apache-2.0',
  262144,
  array['general','reasoning','coding','security','research','long_context','tool_use','verification'],
  'verified'::internal.lifecycle_status,
  jsonb_build_object(
    'upstream_release', 'V3',
    'runtime_adapter', 'llama.cpp-openai',
    'runtime_model', 'localai-qwen38-v3-q8',
    'verified_llama_cpp_build', 'b10618-eb25b7263',
    'verified_runtime_context', 32768,
    'artifact_checksum_verified', true,
    'artifact_size_verified', true,
    'gpu_offload_layers', '66/66',
    'inference_chat_verified', true,
    'external_endpoint_auth_verified', true,
    'promotion_blocked_until_runtime_pinned', true
  )
from internal.models m
where m.key = 'qwen38-27b-obliterated'
on conflict (model_id, version_key) do update
set repository = excluded.repository,
    revision = excluded.revision,
    license = excluded.license,
    context_window = excluded.context_window,
    capabilities = excluded.capabilities,
    status = excluded.status,
    metadata = excluded.metadata;

insert into internal.model_artifacts (
  model_version_id,
  filename,
  quantization,
  sha256,
  bytes,
  tokenizer_sha256,
  chat_template_sha256
)
select
  mv.id,
  'Qwen3.8-27B-OBLITERATED-Q8_0.gguf',
  'Q8_0',
  'afa839b2fa5bc890e5735031dda2c6239d3b6bba3b6ffa29477cbc14a2e1f221',
  29047075872,
  null,
  null
from internal.model_versions mv
join internal.models m on m.id = mv.model_id
where m.key = 'qwen38-27b-obliterated'
  and mv.version_key = 'v3-q8-0'
on conflict (model_version_id, filename) do update
set quantization = excluded.quantization,
    sha256 = excluded.sha256,
    bytes = excluded.bytes,
    tokenizer_sha256 = excluded.tokenizer_sha256,
    chat_template_sha256 = excluded.chat_template_sha256;

insert into internal.model_aliases (alias, model_version_id)
select aliases.alias, mv.id
from internal.model_versions mv
join internal.models m on m.id = mv.model_id
cross join unnest(array['general-prod','code-prod','lab-prod','reasoner-prod','research-prod','verifier-prod']) as aliases(alias)
where m.key = 'qwen38-27b-obliterated'
  and mv.version_key = 'v3-q8-0'
on conflict (alias) do update
set model_version_id = excluded.model_version_id,
    updated_at = now();

commit;
