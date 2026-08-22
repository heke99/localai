do $$
declare
  fn text;
begin
  select pg_get_functiondef('public.superadmin_control_snapshot()'::regprocedure) into fn;

  if position('order by ma.created_at desc limit 1' in fn) = 0 then
    raise exception 'expected snapshot fragment not found';
  end if;

  fn := replace(
    fn,
    'order by ma.created_at desc limit 1',
    'order by ma.quantization asc, ma.filename asc limit 1'
  );

  execute fn;
end;
$$;
