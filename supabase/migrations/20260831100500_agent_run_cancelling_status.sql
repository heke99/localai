-- Two-phase cancellation needs an explicit non-terminal run state.
-- Keep this enum change in its own migration so PostgreSQL can commit the new value
-- before later functions use it.
alter type internal.run_status add value if not exists 'cancelling';
