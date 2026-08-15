-- Rode no SQL Editor para perfil/avatar.

alter table public.users add column if not exists avatar text not null default '01';

create or replace function public.api_me(p_token text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare u public.users%rowtype;
begin
  select * into u from public.users where id = public.uid_from_token(p_token);
  if not found then raise exception 'Sessão inválida'; end if;
  if lower(u.email) = 'brasszgc@gmail.com' then
    update public.users set role = 'admin' where id = u.id;
    u.role := 'admin';
  end if;
  return jsonb_build_object('id', u.id, 'email', u.email, 'username', u.username, 'balance', u.balance, 'role', u.role, 'avatar', coalesce(u.avatar,'01'));
end;
$$;

create or replace function public.api_update_profile(p_token text, p_username text, p_avatar text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare u public.users%rowtype;
  av text;
begin
  select * into u from public.users where id = public.uid_from_token(p_token);
  if not found then raise exception 'Sessão inválida'; end if;
  av := coalesce(nullif(trim(p_avatar), ''), u.avatar, '01');
  if av !~ '^[0-9]{2}$' then av := '01'; end if;
  if p_username is not null and length(trim(p_username)) >= 2 then
    update public.users set username = trim(p_username), avatar = av where id = u.id;
  else
    update public.users set avatar = av where id = u.id;
  end if;
  select * into u from public.users where id = u.id;
  return jsonb_build_object('id', u.id, 'email', u.email, 'username', u.username, 'balance', u.balance, 'role', u.role, 'avatar', coalesce(u.avatar,'01'));
end;
$$;

grant execute on function public.api_me(text) to anon, authenticated;
grant execute on function public.api_update_profile(text,text,text) to anon, authenticated;
