alter type internal.run_status add value if not exists 'planning';
alter type internal.run_status add value if not exists 'waiting_for_user';
alter type internal.run_status add value if not exists 'waiting_for_tool';
alter type internal.run_status add value if not exists 'verifying';
alter type internal.run_status add value if not exists 'retrying';
alter type internal.run_status add value if not exists 'timed_out';
