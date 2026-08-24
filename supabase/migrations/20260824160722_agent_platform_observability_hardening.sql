begin;

drop index if exists internal.agent_repository_index_nodes_path_idx;

alter table internal.agent_repository_index_nodes
  add constraint agent_repository_index_nodes_key_bytes_check check (octet_length(node_key) <= 512);
alter table internal.agent_repository_index_edges
  add constraint agent_repository_index_edges_from_key_bytes_check check (octet_length(from_key) <= 512),
  add constraint agent_repository_index_edges_to_key_bytes_check check (octet_length(to_key) <= 512);
alter table internal.agent_impact_nodes
  add constraint agent_impact_nodes_key_bytes_check check (octet_length(node_key) <= 512);

commit;
