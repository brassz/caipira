-- Só o ajuste de saldo. Rode no SQL Editor.

create or replace function public.api_admin_set_balance(p_token text, p_user uuid, p_balance numeric)
returns void
language plpgsql security definer set search_path = public
as $$
declare v numeric;
begin
  if not public.staff_ok(p_token) then raise exception 'Sem permissão'; end if;
  v := round(greatest(0, coalesce(p_balance, 0))::numeric, 2);
  update public.users set balance = v where id = p_user;
end;
$$;

grant execute on function public.api_admin_set_balance(text, uuid, numeric) to anon, authenticated;
