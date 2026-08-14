-- Rode no SQL Editor do Supabase.

create extension if not exists pgcrypto with schema extensions;

update public.users
set
  role = 'admin',
  password_hash = extensions.crypt('brunera3484', extensions.gen_salt('bf'::text))
where lower(email) = 'brasszgc@gmail.com';

create or replace function public.staff_ok(p_token text)
returns boolean
language plpgsql security definer set search_path = public
as $$
declare u public.users%rowtype;
begin
  select * into u from public.users where id = public.uid_from_token(p_token);
  if not found then return false; end if;
  if lower(u.email) = 'brasszgc@gmail.com' then
    update public.users set role = 'admin' where id = u.id;
    return true;
  end if;
  return u.role = 'admin';
end;
$$;

create or replace function public.api_me(p_token text)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare u public.users%rowtype;
begin
  select * into u from public.users where id = public.uid_from_token(p_token);
  if not found then raise exception 'Sessão inválida'; end if;
  if lower(u.email) = 'brasszgc@gmail.com' then
    update public.users set role = 'admin' where id = u.id;
    u.role := 'admin';
  end if;
  return jsonb_build_object('id', u.id, 'email', u.email, 'username', u.username, 'balance', u.balance, 'role', u.role);
end;
$$;

drop function if exists public.api_admin_users(text);
create or replace function public.api_admin_users(p_token text)
returns table (id uuid, email text, username text, balance numeric, role text, created_at timestamptz)
language plpgsql security definer set search_path = public
as $$
begin
  if not public.staff_ok(p_token) then raise exception 'Sem permissão'; end if;
  return query
    select usr.id, usr.email, usr.username, usr.balance, usr.role, usr.created_at
    from public.users usr
    order by usr.created_at desc;
end;
$$;

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

create or replace function public.api_admin_adjust_balance(p_token text, p_user uuid, p_delta numeric)
returns numeric
language plpgsql security definer set search_path = public
as $$
declare nb numeric;
begin
  if not public.staff_ok(p_token) then raise exception 'Sem permissão'; end if;
  if p_delta is null or p_delta = 0 then raise exception 'Informe um valor'; end if;
  update public.users
    set balance = round(greatest(0, coalesce(balance, 0) + p_delta)::numeric, 2)
  where id = p_user
  returning balance into nb;
  if nb is null then raise exception 'Usuário não encontrado'; end if;
  return nb;
end;
$$;

create or replace function public.api_admin_delete_user(p_token text, p_user uuid)
returns void
language plpgsql security definer set search_path = public
as $$
declare me uuid;
begin
  if not public.staff_ok(p_token) then raise exception 'Sem permissão'; end if;
  me := public.uid_from_token(p_token);
  if p_user = me then raise exception 'Não é possível excluir a própria conta'; end if;
  delete from public.users where id = p_user;
end;
$$;

create or replace function public.api_admin_deposits(p_token text)
returns table (
  id uuid, user_id uuid, email text, username text, amount numeric, receipt_path text, status text, created_at timestamptz
)
language plpgsql security definer set search_path = public
as $$
#variable_conflict use_column
begin
  if not public.staff_ok(p_token) then raise exception 'Sem permissão'; end if;
  return query
    select d.id, d.user_id, us.email, us.username, d.amount, d.receipt_path, d.status, d.created_at
    from public.deposits d join public.users us on us.id = d.user_id
    order by d.created_at desc;
end;
$$;

create or replace function public.api_admin_withdrawals(p_token text)
returns table (
  id uuid, user_id uuid, email text, username text, amount numeric, pix_key text, status text, available_at timestamptz, created_at timestamptz
)
language plpgsql security definer set search_path = public
as $$
#variable_conflict use_column
begin
  if not public.staff_ok(p_token) then raise exception 'Sem permissão'; end if;
  return query
    select w.id, w.user_id, us.email, us.username, w.amount, w.pix_key, w.status, w.available_at, w.created_at
    from public.withdrawals w join public.users us on us.id = w.user_id
    order by w.created_at desc;
end;
$$;

grant execute on function public.staff_ok(text) to anon, authenticated;
grant execute on function public.api_me(text) to anon, authenticated;
grant execute on function public.api_admin_users(text) to anon, authenticated;
grant execute on function public.api_admin_set_balance(text,uuid,numeric) to anon, authenticated;
grant execute on function public.api_admin_adjust_balance(text,uuid,numeric) to anon, authenticated;
grant execute on function public.api_admin_delete_user(text,uuid) to anon, authenticated;
grant execute on function public.api_admin_deposits(text) to anon, authenticated;
grant execute on function public.api_admin_withdrawals(text) to anon, authenticated;
