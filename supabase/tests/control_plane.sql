do $$
declare
  exposed_without_rls integer;
  alias_count integer;
begin
  select count(*) into exposed_without_rls
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity;
  if exposed_without_rls <> 0 then raise exception 'public tables without RLS: %', exposed_without_rls; end if;

  if not has_table_privilege('anon', 'public.access_requests', 'insert') then
    raise exception 'anon cannot insert access requests';
  end if;
  if has_table_privilege('anon', 'public.access_requests', 'select') then
    raise exception 'anon can read access requests';
  end if;
  if has_schema_privilege('authenticated', 'internal', 'usage') then
    raise exception 'authenticated role can access internal schema';
  end if;

  select count(*) into alias_count
  from internal.model_aliases a
  join internal.model_versions mv on mv.id = a.model_version_id
  join internal.model_artifacts ma on ma.model_version_id = mv.id
  where mv.revision = 'e335d239dbdfae590687e24b800e81a18d070ebe'
    and ma.quantization = 'Q8_0'
    and ma.sha256 = '4cfb568f17fb58a0373279cc3b73602a350e25aea2953ce087dcea6b51fa6f3c';
  if alias_count <> 6 then raise exception 'expected 6 pinned Q8 aliases, got %', alias_count; end if;
end $$;
