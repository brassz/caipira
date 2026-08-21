-- Rode no SQL Editor do Supabase.

alter table public.users drop constraint if exists users_role_check;
alter table public.users
  add constraint users_role_check check (role in ('user','admin','proplayer'));

create or replace function public.api_admin_set_role(p_token text, p_user uuid, p_role text)
returns void
language plpgsql security definer set search_path = public
as $$
begin
  if not public.staff_ok(p_token) then raise exception 'Sem permissão'; end if;
  if p_role is null or p_role not in ('user','admin','proplayer') then
    raise exception 'Papel inválido';
  end if;
  if p_user = public.uid_from_token(p_token) then
    raise exception 'Não é possível alterar o próprio papel';
  end if;
  update public.users set role = p_role where id = p_user;
  if not found then raise exception 'Usuário não encontrado'; end if;
end;
$$;

grant execute on function public.api_admin_set_role(text, uuid, text) to anon, authenticated;
