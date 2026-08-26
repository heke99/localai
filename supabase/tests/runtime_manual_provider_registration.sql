do $$
declare
  register_definition text;
begin
  select pg_get_functiondef('public.runtime_register_worker(text,text,integer,text,text,text,text,text,text,text,text,integer,bigint,integer,jsonb)'::regprocedure)
    into register_definition;

  if position('insert into internal.gpu_providers' in lower(register_definition)) = 0
     or position('on conflict (key) do nothing' in lower(register_definition)) = 0 then
    raise exception 'runtime registration cannot onboard a previously unknown GPU provider';
  end if;

  if position('target_provider_key' in lower(register_definition)) = 0
     or position('target_model_alias' in lower(register_definition)) = 0
     or position('internal.model_runtime_routes' in lower(register_definition)) = 0 then
    raise exception 'runtime registration is not provider/alias neutral';
  end if;
end $$;
