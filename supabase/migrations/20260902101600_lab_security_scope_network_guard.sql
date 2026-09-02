begin;

-- Defense in depth at the storage boundary. The executor independently blocks
-- infrastructure addresses, but a persisted security_scope must also be incapable
-- of containing IPv4 CIDRs that overlap reserved infrastructure ranges. This
-- catches narrow variants such as 127.0.0.1/32 and 169.254.169.254/32 as well as
-- broad ranges such as 0.0.0.0/0.
create or replace function internal.security_scope_network_metadata_safe(target_metadata jsonb)
returns boolean
language plpgsql
immutable
set search_path = ''
as $$
declare
  cidr_text text;
  parsed cidr;
begin
  if jsonb_typeof(coalesce(target_metadata->'allowIpv4Cidrs', '[]'::jsonb)) <> 'array' then
    return false;
  end if;

  for cidr_text in
    select cidr_values.value
    from jsonb_array_elements_text(coalesce(target_metadata->'allowIpv4Cidrs', '[]'::jsonb)) as cidr_values(value)
  loop
    begin
      parsed := trim(cidr_text)::cidr;
    exception when others then
      return false;
    end;

    if family(parsed) <> 4 then
      return false;
    end if;

    if parsed && '0.0.0.0/8'::cidr
       or parsed && '127.0.0.0/8'::cidr
       or parsed && '169.254.0.0/16'::cidr
       or parsed && '224.0.0.0/4'::cidr then
      return false;
    end if;
  end loop;

  return true;
end;
$$;

revoke all on function internal.security_scope_network_metadata_safe(jsonb) from public, anon, authenticated;
grant execute on function internal.security_scope_network_metadata_safe(jsonb) to service_role;

alter table internal.integration_resources
  drop constraint if exists integration_resources_security_scope_network_safety_check;

alter table internal.integration_resources
  add constraint integration_resources_security_scope_network_safety_check
  check (
    resource_type <> 'security_scope'
    or internal.security_scope_network_metadata_safe(metadata)
  );

commit;
