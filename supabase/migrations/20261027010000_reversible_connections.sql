-- Let editors reverse a connection's direction. Its two ends may be swapped, but never replaced,
-- so a connection still can't be re-pointed at other elements (or into another project).

create function private.connection_ends_fixed()
returns trigger
language plpgsql set search_path = ''
as $$
begin
  if not ((new.from_element_id = old.from_element_id and new.to_element_id = old.to_element_id)
       or (new.from_element_id = old.to_element_id and new.to_element_id = old.from_element_id)) then
    raise exception 'A connection can be reversed, but not moved to other elements.' using errcode = 'P0001';
  end if;
  return new;
end;
$$;
revoke all on function private.connection_ends_fixed() from public, anon, authenticated;

create trigger connections_ends_fixed before update of from_element_id, to_element_id on public.connections
  for each row execute function private.connection_ends_fixed();

grant update (from_element_id, to_element_id) on public.connections to authenticated;
