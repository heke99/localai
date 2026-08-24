begin;

drop index if exists internal.repository_index_nodes_path_idx;

alter table internal.repository_index_nodes
  add constraint repository_index_nodes_key_bytes_check check (octet_length(node_key) <= 512);
alter table internal.repository_index_edges
  add constraint repository_index_edges_from_key_bytes_check check (octet_length(from_key) <= 512),
  add constraint repository_index_edges_to_key_bytes_check check (octet_length(to_key) <= 512);
alter table internal.impact_nodes
  add constraint impact_nodes_key_bytes_check check (octet_length(node_key) <= 512);

commit;
