begin;

create index if not exists knowledge_chunks_search_idx
  on internal.knowledge_chunks using gin (to_tsvector('simple'::regconfig, content));

create index if not exists knowledge_sources_scope_approval_idx
  on internal.knowledge_sources(scope_type, scope_id, approval_status);

create index if not exists knowledge_embeddings_model_chunk_idx
  on internal.knowledge_embeddings(embedding_model, chunk_id);

create or replace function public.worker_knowledge_available(
  target_run_id uuid,
  target_embedding_model text
)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  run_org uuid;
  run_workspace uuid;
  run_project uuid;
begin
  if coalesce(auth.jwt()->>'role','') <> 'service_role' then
    raise exception 'service_role_required' using errcode='42501';
  end if;

  select r.organization_id, c.workspace_id, c.project_id
  into run_org, run_workspace, run_project
  from internal.agent_runs r
  join public.conversations c on c.id = r.conversation_id
  where r.id = target_run_id;

  if run_org is null then return false; end if;
  if nullif(trim(coalesce(target_embedding_model,'')), '') is null then return false; end if;

  return exists (
    select 1
    from internal.knowledge_sources s
    join internal.knowledge_items i on i.source_id = s.id
    join internal.knowledge_chunks k on k.item_id = i.id
    join internal.knowledge_embeddings e on e.chunk_id = k.id
    where s.approval_status = 'approved'
      and e.embedding_model = target_embedding_model
      and (i.valid_from is null or i.valid_from <= now())
      and (i.valid_to is null or i.valid_to > now())
      and (
        (s.scope_type = 'global' and s.scope_id is null)
        or (s.scope_type = 'organization' and s.scope_id = run_org)
        or (s.scope_type = 'workspace' and s.scope_id = run_workspace)
        or (s.scope_type = 'project' and run_project is not null and s.scope_id = run_project)
      )
  );
end
$$;

revoke all on function public.worker_knowledge_available(uuid,text) from public, anon, authenticated;
grant execute on function public.worker_knowledge_available(uuid,text) to service_role;

create or replace function public.worker_retrieve_knowledge(
  target_run_id uuid,
  target_query_text text,
  target_query_embedding extensions.vector(1024),
  target_embedding_model text,
  target_match_count integer default 8
)
returns table(
  chunk_id uuid,
  source_id uuid,
  title text,
  source_uri text,
  content text,
  provenance jsonb,
  vector_similarity double precision,
  lexical_score real,
  rrf_score double precision
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  run_org uuid;
  run_workspace uuid;
  run_project uuid;
  result_limit integer := greatest(1, least(coalesce(target_match_count,8), 20));
  candidate_limit integer := greatest(20, least(greatest(1, coalesce(target_match_count,8)) * 8, 160));
begin
  if coalesce(auth.jwt()->>'role','') <> 'service_role' then
    raise exception 'service_role_required' using errcode='42501';
  end if;
  if nullif(trim(coalesce(target_query_text,'')), '') is null then
    raise exception 'knowledge_query_required';
  end if;
  if target_query_embedding is null then raise exception 'query_embedding_required'; end if;
  if nullif(trim(coalesce(target_embedding_model,'')), '') is null then raise exception 'embedding_model_required'; end if;

  select r.organization_id, c.workspace_id, c.project_id
  into run_org, run_workspace, run_project
  from internal.agent_runs r
  join public.conversations c on c.id = r.conversation_id
  where r.id = target_run_id;
  if run_org is null then raise exception 'agent_run_not_found'; end if;

  return query
  with eligible as (
    select
      k.id as chunk_id,
      s.id as source_id,
      i.title,
      s.source_uri,
      k.content,
      s.provenance,
      (e.embedding <=> target_query_embedding) as vector_distance,
      ts_rank_cd(
        to_tsvector('simple'::regconfig, k.content),
        plainto_tsquery('simple'::regconfig, target_query_text),
        32
      ) as lexical_score
    from internal.knowledge_sources s
    join internal.knowledge_items i on i.source_id = s.id
    join internal.knowledge_chunks k on k.item_id = i.id
    join internal.knowledge_embeddings e on e.chunk_id = k.id
    where s.approval_status = 'approved'
      and e.embedding_model = target_embedding_model
      and (i.valid_from is null or i.valid_from <= now())
      and (i.valid_to is null or i.valid_to > now())
      and (
        (s.scope_type = 'global' and s.scope_id is null)
        or (s.scope_type = 'organization' and s.scope_id = run_org)
        or (s.scope_type = 'workspace' and s.scope_id = run_workspace)
        or (s.scope_type = 'project' and run_project is not null and s.scope_id = run_project)
      )
  ),
  semantic as (
    select e.chunk_id, row_number() over(order by e.vector_distance asc, e.chunk_id) as semantic_rank
    from eligible e
    order by e.vector_distance asc, e.chunk_id
    limit candidate_limit
  ),
  lexical as (
    select e.chunk_id, row_number() over(order by e.lexical_score desc, e.chunk_id) as lexical_rank
    from eligible e
    where e.lexical_score > 0
    order by e.lexical_score desc, e.chunk_id
    limit candidate_limit
  ),
  fused as (
    select ranks.chunk_id,
      sum(case when ranks.rank_kind = 'semantic' then 1.0 / (60.0 + ranks.rank_value) else 0 end)
      + sum(case when ranks.rank_kind = 'lexical' then 1.0 / (60.0 + ranks.rank_value) else 0 end) as score
    from (
      select s.chunk_id, 'semantic'::text as rank_kind, s.semantic_rank::double precision as rank_value from semantic s
      union all
      select l.chunk_id, 'lexical'::text as rank_kind, l.lexical_rank::double precision as rank_value from lexical l
    ) ranks
    group by ranks.chunk_id
  )
  select
    e.chunk_id,
    e.source_id,
    e.title,
    e.source_uri,
    e.content,
    e.provenance,
    greatest(-1.0, least(1.0, 1.0 - e.vector_distance))::double precision as vector_similarity,
    e.lexical_score,
    f.score::double precision as rrf_score
  from fused f
  join eligible e on e.chunk_id = f.chunk_id
  order by f.score desc, e.vector_distance asc, e.chunk_id
  limit result_limit;
end
$$;

revoke all on function public.worker_retrieve_knowledge(uuid,text,extensions.vector,text,integer) from public, anon, authenticated;
grant execute on function public.worker_retrieve_knowledge(uuid,text,extensions.vector,text,integer) to service_role;

create or replace function public.service_replace_knowledge_document(
  target_scope_type text,
  target_scope_id uuid,
  target_source_type text,
  target_source_uri text,
  target_content_hash text,
  target_title text,
  target_body text,
  target_provenance jsonb,
  target_embedding_model text,
  target_chunks jsonb,
  target_valid_from timestamptz default null,
  target_valid_to timestamptz default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  created_source_id uuid;
  created_item_id uuid;
  created_chunk_id uuid;
  chunk_record jsonb;
  chunk_count integer := 0;
begin
  if coalesce(auth.jwt()->>'role','') <> 'service_role' then
    raise exception 'service_role_required' using errcode='42501';
  end if;
  if target_scope_type not in ('global','organization','workspace','project') then raise exception 'invalid_knowledge_scope'; end if;
  if target_scope_type = 'global' and target_scope_id is not null then raise exception 'global_scope_id_must_be_null'; end if;
  if target_scope_type <> 'global' and target_scope_id is null then raise exception 'knowledge_scope_id_required'; end if;
  if nullif(trim(coalesce(target_source_type,'')), '') is null then raise exception 'knowledge_source_type_required'; end if;
  if nullif(trim(coalesce(target_source_uri,'')), '') is null then raise exception 'knowledge_source_uri_required'; end if;
  if nullif(trim(coalesce(target_content_hash,'')), '') is null then raise exception 'knowledge_content_hash_required'; end if;
  if nullif(trim(coalesce(target_title,'')), '') is null then raise exception 'knowledge_title_required'; end if;
  if nullif(trim(coalesce(target_body,'')), '') is null then raise exception 'knowledge_body_required'; end if;
  if nullif(trim(coalesce(target_embedding_model,'')), '') is null then raise exception 'embedding_model_required'; end if;
  if jsonb_typeof(target_chunks) <> 'array' or jsonb_array_length(target_chunks) = 0 then raise exception 'knowledge_chunks_required'; end if;
  if target_valid_to is not null and target_valid_from is not null and target_valid_to <= target_valid_from then raise exception 'invalid_knowledge_validity_window'; end if;

  if target_scope_type = 'organization' and not exists(select 1 from public.organizations where id=target_scope_id) then raise exception 'knowledge_scope_not_found'; end if;
  if target_scope_type = 'workspace' and not exists(select 1 from public.workspaces where id=target_scope_id) then raise exception 'knowledge_scope_not_found'; end if;
  if target_scope_type = 'project' and not exists(select 1 from public.projects where id=target_scope_id) then raise exception 'knowledge_scope_not_found'; end if;

  update internal.knowledge_sources s
  set approval_status = 'superseded'
  where s.scope_type = target_scope_type
    and s.scope_id is not distinct from target_scope_id
    and s.source_uri = target_source_uri
    and s.approval_status = 'approved';

  insert into internal.knowledge_sources(scope_type,scope_id,source_type,source_uri,content_hash,provenance,approval_status)
  values(target_scope_type,target_scope_id,target_source_type,target_source_uri,target_content_hash,coalesce(target_provenance,'{}'::jsonb),'approved')
  returning id into created_source_id;

  insert into internal.knowledge_items(source_id,title,body,metadata,valid_from,valid_to)
  values(created_source_id,target_title,target_body,'{}'::jsonb,target_valid_from,target_valid_to)
  returning id into created_item_id;

  for chunk_record in select value from jsonb_array_elements(target_chunks)
  loop
    if jsonb_typeof(chunk_record) <> 'object' then raise exception 'invalid_knowledge_chunk'; end if;
    if nullif(trim(coalesce(chunk_record->>'content','')), '') is null then raise exception 'knowledge_chunk_content_required'; end if;
    if nullif(trim(coalesce(chunk_record->>'contentHash','')), '') is null then raise exception 'knowledge_chunk_hash_required'; end if;
    if jsonb_typeof(chunk_record->'embedding') <> 'array' or jsonb_array_length(chunk_record->'embedding') <> 1024 then raise exception 'knowledge_embedding_dimension_invalid'; end if;

    insert into internal.knowledge_chunks(item_id,chunk_index,content,token_count,content_hash)
    values(
      created_item_id,
      chunk_count,
      chunk_record->>'content',
      greatest(0, coalesce((chunk_record->>'tokenCount')::integer,0)),
      chunk_record->>'contentHash'
    ) returning id into created_chunk_id;

    insert into internal.knowledge_embeddings(chunk_id,embedding,embedding_model)
    values(created_chunk_id,(chunk_record->'embedding')::text::extensions.vector,target_embedding_model);

    chunk_count := chunk_count + 1;
  end loop;

  insert into internal.knowledge_ingestion_runs(source_id,status,report,finished_at)
  values(created_source_id,'completed',jsonb_build_object('chunks',chunk_count,'embeddingModel',target_embedding_model),now());

  return created_source_id;
end
$$;

revoke all on function public.service_replace_knowledge_document(text,uuid,text,text,text,text,text,jsonb,text,jsonb,timestamptz,timestamptz) from public, anon, authenticated;
grant execute on function public.service_replace_knowledge_document(text,uuid,text,text,text,text,text,jsonb,text,jsonb,timestamptz,timestamptz) to service_role;

create or replace function public.service_delete_knowledge_source(target_source_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  existed boolean;
begin
  if coalesce(auth.jwt()->>'role','') <> 'service_role' then
    raise exception 'service_role_required' using errcode='42501';
  end if;
  select exists(select 1 from internal.knowledge_sources where id=target_source_id) into existed;
  if not existed then return false; end if;

  delete from internal.knowledge_embeddings e using internal.knowledge_chunks k, internal.knowledge_items i
    where e.chunk_id=k.id and k.item_id=i.id and i.source_id=target_source_id;
  delete from internal.knowledge_chunks k using internal.knowledge_items i
    where k.item_id=i.id and i.source_id=target_source_id;
  delete from internal.knowledge_ingestion_runs where source_id=target_source_id;
  delete from internal.knowledge_items where source_id=target_source_id;
  delete from internal.knowledge_sources where id=target_source_id;
  return true;
end
$$;

revoke all on function public.service_delete_knowledge_source(uuid) from public, anon, authenticated;
grant execute on function public.service_delete_knowledge_source(uuid) to service_role;

-- Function signatures are consumed through PostgREST by the worker. Force the
-- schema cache to refresh in the same migration so a newly deployed worker
-- cannot race a stale REST schema cache after DDL.
notify pgrst, 'reload schema';

commit;
