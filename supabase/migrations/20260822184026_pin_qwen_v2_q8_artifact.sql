begin;

update internal.model_versions
set revision = 'e335d239dbdfae590687e24b800e81a18d070ebe',
    metadata = metadata || '{"upstream_release":"V2","thinking_default":false}'::jsonb
where version_key = 'v2-q8-0'
  and repository = 'OBLITERATUS/Qwen3.8-27B-OBLITERATED';

update internal.model_artifacts ma
set sha256 = '4cfb568f17fb58a0373279cc3b73602a350e25aea2953ce087dcea6b51fa6f3c',
    bytes = 29047084320,
    tokenizer_sha256 = '0997f410c57a1f4e53b09e4be8f4a172d90edd9564368fb0847030937229b9f3',
    chat_template_sha256 = '1bffd744ab18e11623af60636410ca4a1f3e544c9fc52d3ddee6bf3da341419f'
from internal.model_versions mv
where ma.model_version_id = mv.id
  and mv.version_key = 'v2-q8-0'
  and ma.filename = 'Qwen3.8-27B-OBLITERATED-Q8_0.gguf';

commit;
