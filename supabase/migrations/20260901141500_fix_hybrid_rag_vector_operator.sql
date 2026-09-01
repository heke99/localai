begin;

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
  lexical_query tsquery;
begin
  if coalesce(auth.jwt()->>'role','') <> 'service_role' then
    raise exception 'service_role_required' using errcode='42501';
  end if;
  if nullif(trim(coalesce(target_query_text,'')), '') is null then raise exception 'knowledge_query_required'; end if;
  if target_query_embedding is null then raise exception 'query_embedding_required'; end if;
  if nullif(trim(coalesce(target_embedding_model,'')), '') is null then raise exception 'embedding_model_required'; end if;

  select r.organization_id, c.workspace_id, c.project_id
  into run_org, run_workspace, run_project
  from internal.agent_runs r
  join public.conversations c on c.id = r.conversation_id
  where r.id = target_run_id;
  if run_org is null then raise exception 'agent_run_not_found'; end if;

  lexical_query := plainto_tsquery('simple'::regconfig, target_query_text);

  return query
  with semantic as (
    select
      k.id as chunk_id,
      row_number() over(order by e.embedding OPERATOR(extensions.<=>) target_query_embedding, k.id) as semantic_rank
    from internal.knowledge_embeddings e
    join internal.knowledge_chunks k on k.id = e.chunk_id
    join internal.knowledge_items i on i.id = k.item_id
    join internal.knowledge_sources s on s.id = i.source_id
    where e.embedding_model = target_embedding_model
      and s.approval_status = 'approved'
      and (i.valid_from is null or i.valid_from <= now())
      and (i.valid_to is null or i.valid_to > now())
      and (
        (s.scope_type = 'global' and s.scope_id is null)
        or (s.scope_type = 'organization' and s.scope_id = run_org)
        or (s.scope_type = 'workspace' and s.scope_id = run_workspace)
        or (s.scope_type = 'project' and run_project is not null and s.scope_id = run_project)
      )
    order by e.embedding OPERATOR(extensions.<=>) target_query_embedding, k.id
    limit candidate_limit
  ),
  lexical_candidates as (
    select
      k.id as chunk_id,
      ts_rank_cd(to_tsvector('simple'::regconfig, k.content), lexical_query, 32) as lexical_score
    from internal.knowledge_chunks k
    join internal.knowledge_items i on i.id = k.item_id
    join internal.knowledge_sources s on s.id = i.source_id
    join internal.knowledge_embeddings e on e.chunk_id = k.id
    where e.embedding_model = target_embedding_model
      and s.approval_status = 'approved'
      and (i.valid_from is null or i.valid_from <= now())
      and (i.valid_to is null or i.valid_to > now())
      and to_tsvector('simple'::regconfig, k.content) @@ lexical_query
      and (
        (s.scope_type = 'global' and s.scope_id is null)
        or (s.scope_type = 'organization' and s.scope_id = run_org)
        or (s.scope_type = 'workspace' and s.scope_id = run_workspace)
        or (s.scope_type = 'project' and run_project is not null and s.scope_id = run_project)
      )
  ),
  lexical as (
    select
      lc.chunk_id,
      lc.lexical_score,
      row_number() over(order by lc.lexical_score desc, lc.chunk_id) as lexical_rank
    from lexical_candidates lc
    order by lc.lexical_score desc, lc.chunk_id
    limit candidate_limit
  ),
  ranks as (
    select s.chunk_id, 1.0 / (60.0 + s.semantic_rank::double precision) as score from semantic s
    union all
    select l.chunk_id, 1.0 / (60.0 + l.lexical_rank::double precision) as score from lexical l
  ),
  fused as (
    select r.chunk_id, sum(r.score)::double precision as score
    from ranks r
    group by r.chunk_id
  )
  select
    k.id as chunk_id,
    s.id as source_id,
    i.title,
    s.source_uri,
    k.content,
    s.provenance,
    greatest(-1.0, least(1.0, 1.0 - (e.embedding OPERATOR(extensions.<=>) target_query_embedding)))::double precision as vector_similarity,
    coalesce(l.lexical_score, 0)::real as lexical_score,
    f.score as rrf_score
  from fused f
  join internal.knowledge_chunks k on k.id = f.chunk_id
  join internal.knowledge_items i on i.id = k.item_id
  join internal.knowledge_sources s on s.id = i.source_id
  join internal.knowledge_embeddings e on e.chunk_id = k.id and e.embedding_model = target_embedding_model
  left join lexical l on l.chunk_id = k.id
  order by f.score desc, e.embedding OPERATOR(extensions.<=>) target_query_embedding, k.id
  limit result_limit;
end
$$;

revoke all on function public.worker_retrieve_knowledge(uuid,text,extensions.vector,text,integer) from public, anon, authenticated;
grant execute on function public.worker_retrieve_knowledge(uuid,text,extensions.vector,text,integer) to service_role;

notify pgrst, 'reload schema';

commit;
