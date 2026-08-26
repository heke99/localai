begin;

update internal.gpu_providers
set enabled = true,
    provider_kind = 'managed',
    priority = 200,
    updated_at = now()
where key = 'hyperstack';

commit;
