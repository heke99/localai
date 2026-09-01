do $$
begin
  if to_regprocedure('public.worker_knowledge_available(uuid,text)') is null then raise exception 'worker_knowledge_available_missing'; end if;
  if to_regprocedure('public.worker_retrieve_knowledge(uuid,text,extensions.vector,text,integer)') is null then raise exception 'worker_retrieve_knowledge_missing'; end if;
  if to_regprocedure('public.service_replace_knowledge_document(text,uuid,text,text,text,text,text,jsonb,text,jsonb,timestamptz,timestamptz)') is null then raise exception 'service_replace_knowledge_document_missing'; end if;
  if to_regprocedure('public.service_delete_knowledge_source(uuid)') is null then raise exception 'service_delete_knowledge_source_missing'; end if;

  if has_function_privilege('anon','public.worker_knowledge_available(uuid,text)','EXECUTE') then raise exception 'anon_worker_knowledge_available_execute'; end if;
  if has_function_privilege('authenticated','public.worker_knowledge_available(uuid,text)','EXECUTE') then raise exception 'authenticated_worker_knowledge_available_execute'; end if;
  if not has_function_privilege('service_role','public.worker_knowledge_available(uuid,text)','EXECUTE') then raise exception 'service_worker_knowledge_available_missing'; end if;

  if has_function_privilege('anon','public.worker_retrieve_knowledge(uuid,text,extensions.vector,text,integer)','EXECUTE') then raise exception 'anon_worker_retrieve_knowledge_execute'; end if;
  if has_function_privilege('authenticated','public.worker_retrieve_knowledge(uuid,text,extensions.vector,text,integer)','EXECUTE') then raise exception 'authenticated_worker_retrieve_knowledge_execute'; end if;
  if not has_function_privilege('service_role','public.worker_retrieve_knowledge(uuid,text,extensions.vector,text,integer)','EXECUTE') then raise exception 'service_worker_retrieve_knowledge_missing'; end if;

  if not exists(select 1 from pg_indexes where schemaname='internal' and tablename='knowledge_chunks' and indexname='knowledge_chunks_search_idx') then raise exception 'knowledge_chunks_search_idx_missing'; end if;
  if not exists(select 1 from pg_indexes where schemaname='internal' and tablename='knowledge_embeddings' and indexdef ilike '%vector_cosine_ops%') then raise exception 'knowledge_cosine_hnsw_missing'; end if;
end $$;
