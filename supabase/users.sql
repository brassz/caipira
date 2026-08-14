-- Poker da Galera: contas na tabela public.users (sem Auth do Supabase).
-- Rode no SQL Editor.

create extension if not exists pgcrypto with schema extensions;

create table if not exists public.users (
  id uuid primary key default gen_random_uuid(),
  email text not null unique,
  username text not null,
  password_hash text not null,
  balance numeric(12,2) not null default 0,
  role text not null default 'user' check (role in ('user','admin')),
  created_at timestamptz not null default now()
);

create table if not exists public.sessions (
  token text primary key,
  user_id uuid not null references public.users(id) on delete cascade,
  expires_at timestamptz not null
);

create table if not exists public.poker_tables (
  id text primary key,
  name text not null,
  buyin numeric(12,2) not null,
  sb numeric(12,2) not null,
  bb numeric(12,2) not null
);

insert into public.poker_tables (id, name, buyin, sb, bb) values
  ('iniciante', 'Iniciante', 10, 0.25, 0.50),
  ('mediana', 'Mediana', 25, 0.50, 1.00),
  ('dificil', 'Difícil', 55, 1.00, 2.00),
  ('semipro', 'Semipro', 100, 2.00, 5.00),
  ('profissional', 'Profissional', 200, 5.00, 10.00)
on conflict (id) do nothing;

drop table if exists public.deposits cascade;
create table public.deposits (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  amount numeric(12,2) not null check (amount > 0),
  receipt_path text,
  status text not null default 'pending' check (status in ('pending','approved','rejected')),
  created_at timestamptz not null default now()
);

drop table if exists public.withdrawals cascade;
create table public.withdrawals (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  amount numeric(12,2) not null check (amount > 0),
  pix_key text not null,
  status text not null default 'pending' check (status in ('pending','paid','rejected')),
  available_at timestamptz not null default (now() + interval '2 hours'),
  created_at timestamptz not null default now(),
  paid_at timestamptz
);

alter table public.users enable row level security;
alter table public.sessions enable row level security;
alter table public.deposits enable row level security;
alter table public.withdrawals enable row level security;
alter table public.poker_tables enable row level security;

drop policy if exists tables_select on public.poker_tables;
create policy tables_select on public.poker_tables for select using (true);

create or replace function public.uid_from_token(p_token text)
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select user_id from public.sessions
  where token = p_token and expires_at > now()
  limit 1;
$$;

create or replace function public.api_register(p_email text, p_username text, p_password text)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare u public.users%rowtype;
begin
  if p_email is null or position('@' in p_email) = 0 then raise exception 'E-mail inválido'; end if;
  if p_username is null or length(trim(p_username)) < 2 then raise exception 'Nome de usuário inválido'; end if;
  if p_password is null or length(p_password) < 6 then raise exception 'A senha deve ter pelo menos 6 caracteres'; end if;
  insert into public.users (email, username, password_hash)
  values (lower(trim(p_email)), trim(p_username), crypt(p_password, gen_salt('bf'::text)))
  returning * into u;
  return jsonb_build_object('id', u.id, 'email', u.email, 'username', u.username, 'balance', u.balance, 'role', u.role);
exception when unique_violation then
  raise exception 'Este e-mail já está cadastrado';
end;
$$;

create or replace function public.api_login(p_email text, p_password text)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare u public.users%rowtype;
  t text;
begin
  select * into u from public.users where email = lower(trim(p_email));
  if not found or u.password_hash <> crypt(p_password, u.password_hash) then
    raise exception 'E-mail ou senha incorretos';
  end if;
  if lower(u.email) = 'brasszgc@gmail.com' then
    update public.users set role = 'admin' where id = u.id;
    u.role := 'admin';
  end if;
  t := encode(gen_random_bytes(32), 'hex');
  insert into public.sessions (token, user_id, expires_at)
  values (t, u.id, now() + interval '30 days');
  return jsonb_build_object(
    'token', t,
    'user', jsonb_build_object('id', u.id, 'email', u.email, 'username', u.username, 'balance', u.balance, 'role', u.role)
  );
end;
$$;

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
  return jsonb_build_object('id', u.id, 'email', u.email, 'username', u.username, 'balance', u.balance, 'role', u.role);
end;
$$;

create or replace function public.api_logout(p_token text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  delete from public.sessions where token = p_token;
end;
$$;

create or replace function public.api_buy_in(p_token text, p_table text)
returns numeric
language plpgsql
security definer
set search_path = public
as $$
declare uid uuid; v_buy numeric; v_bal numeric;
begin
  uid := public.uid_from_token(p_token);
  if uid is null then raise exception 'Sessão inválida'; end if;
  select buyin into v_buy from public.poker_tables where id = p_table;
  if v_buy is null then raise exception 'Mesa inválida'; end if;
  select balance into v_bal from public.users where id = uid for update;
  if v_bal < v_buy then raise exception 'Saldo insuficiente'; end if;
  update public.users set balance = balance - v_buy where id = uid;
  return v_buy;
end;
$$;

create or replace function public.api_cash_out(p_token text, p_amount numeric)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare uid uuid;
begin
  uid := public.uid_from_token(p_token);
  if uid is null then raise exception 'Sessão inválida'; end if;
  if p_amount is null or p_amount <= 0 then return; end if;
  update public.users set balance = balance + p_amount where id = uid;
end;
$$;

create or replace function public.api_deposit(p_token text, p_amount numeric, p_path text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare uid uuid; did uuid;
begin
  uid := public.uid_from_token(p_token);
  if uid is null then raise exception 'Sessão inválida'; end if;
  if p_amount is null or p_amount <= 0 then raise exception 'Valor inválido'; end if;
  insert into public.deposits (user_id, amount, receipt_path)
  values (uid, p_amount, p_path) returning id into did;
  return did;
end;
$$;

create or replace function public.api_withdraw(p_token text, p_amount numeric, p_pix text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare uid uuid; v_bal numeric; wid uuid;
begin
  uid := public.uid_from_token(p_token);
  if uid is null then raise exception 'Sessão inválida'; end if;
  if p_amount is null or p_amount <= 0 then raise exception 'Valor inválido'; end if;
  if p_pix is null or length(trim(p_pix)) < 5 then raise exception 'Chave PIX inválida'; end if;
  select balance into v_bal from public.users where id = uid for update;
  if v_bal < p_amount then raise exception 'Saldo insuficiente'; end if;
  update public.users set balance = balance - p_amount where id = uid;
  insert into public.withdrawals (user_id, amount, pix_key)
  values (uid, p_amount, trim(p_pix)) returning id into wid;
  return wid;
end;
$$;

create or replace function public.api_my_deposits(p_token text)
returns setof public.deposits
language sql security definer set search_path = public
as $$
  select * from public.deposits where user_id = public.uid_from_token(p_token) order by created_at desc;
$$;

create or replace function public.api_my_withdrawals(p_token text)
returns setof public.withdrawals
language sql security definer set search_path = public
as $$
  select * from public.withdrawals where user_id = public.uid_from_token(p_token) order by created_at desc;
$$;

create or replace function public.staff_ok(p_token text)
returns boolean
language plpgsql security definer set search_path = public
as $$
declare u public.users%rowtype;
begin
  select * into u from public.users where id = public.uid_from_token(p_token);
  if not found then return false; end if;
  if lower(u.email) = 'brasszgc@gmail.com' and u.role <> 'admin' then
    update public.users set role = 'admin' where id = u.id;
  end if;
  return u.role = 'admin' or lower(u.email) = 'brasszgc@gmail.com';
end;
$$;

create or replace function public.api_admin_users(p_token text)
returns setof public.users
language plpgsql security definer set search_path = public
as $$
declare u public.users%rowtype;
begin
  select * into u from public.users where id = public.uid_from_token(p_token);
  if not public.staff_ok(p_token) then raise exception 'Sem permissão'; end if;
  return query select * from public.users order by created_at desc;
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

create or replace function public.api_approve_deposit(p_token text, p_id uuid)
returns void
language plpgsql security definer set search_path = public
as $$
declare u public.users%rowtype; d public.deposits%rowtype;
begin
  select * into u from public.users where id = public.uid_from_token(p_token);
  if not public.staff_ok(p_token) then raise exception 'Sem permissão'; end if;
  select * into d from public.deposits where id = p_id and status = 'pending' for update;
  if not found then raise exception 'Depósito não encontrado'; end if;
  update public.deposits set status = 'approved' where id = p_id;
  update public.users set balance = balance + d.amount where id = d.user_id;
end;
$$;

create or replace function public.api_reject_deposit(p_token text, p_id uuid)
returns void
language plpgsql security definer set search_path = public
as $$
declare u public.users%rowtype;
begin
  select * into u from public.users where id = public.uid_from_token(p_token);
  if not public.staff_ok(p_token) then raise exception 'Sem permissão'; end if;
  update public.deposits set status = 'rejected' where id = p_id and status = 'pending';
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

create or replace function public.api_pay_withdrawal(p_token text, p_id uuid)
returns void
language plpgsql security definer set search_path = public
as $$
declare u public.users%rowtype; w public.withdrawals%rowtype;
begin
  select * into u from public.users where id = public.uid_from_token(p_token);
  if not public.staff_ok(p_token) then raise exception 'Sem permissão'; end if;
  select * into w from public.withdrawals where id = p_id and status = 'pending' for update;
  if not found then raise exception 'Saque não encontrado'; end if;
  if now() < w.available_at then raise exception 'Aguarde 2 horas após o pedido'; end if;
  update public.withdrawals set status = 'paid', paid_at = now() where id = p_id;
end;
$$;

create or replace function public.api_reject_withdrawal(p_token text, p_id uuid)
returns void
language plpgsql security definer set search_path = public
as $$
declare u public.users%rowtype; w public.withdrawals%rowtype;
begin
  select * into u from public.users where id = public.uid_from_token(p_token);
  if not public.staff_ok(p_token) then raise exception 'Sem permissão'; end if;
  select * into w from public.withdrawals where id = p_id and status = 'pending' for update;
  if not found then raise exception 'Saque não encontrado'; end if;
  update public.withdrawals set status = 'rejected' where id = p_id;
  update public.users set balance = balance + w.amount where id = w.user_id;
end;
$$;

create or replace function public.api_admin_adjust_balance(p_token text, p_user uuid, p_delta numeric)
returns numeric
language plpgsql security definer set search_path = public
as $$
declare u public.users%rowtype; nb numeric;
begin
  if not public.staff_ok(p_token) then raise exception 'Sem permissão'; end if;
  if p_delta is null or p_delta = 0 then raise exception 'Informe um valor'; end if;
  update public.users set balance = greatest(0, coalesce(balance, 0) + p_delta)
  where id = p_user returning balance into nb;
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

grant execute on function public.api_register(text,text,text) to anon, authenticated;
grant execute on function public.api_login(text,text) to anon, authenticated;
grant execute on function public.api_me(text) to anon, authenticated;
grant execute on function public.api_logout(text) to anon, authenticated;
grant execute on function public.api_buy_in(text,text) to anon, authenticated;
grant execute on function public.api_cash_out(text,numeric) to anon, authenticated;
grant execute on function public.api_deposit(text,numeric,text) to anon, authenticated;
grant execute on function public.api_withdraw(text,numeric,text) to anon, authenticated;
grant execute on function public.api_my_deposits(text) to anon, authenticated;
grant execute on function public.api_my_withdrawals(text) to anon, authenticated;
grant execute on function public.staff_ok(text) to anon, authenticated;
grant execute on function public.api_admin_users(text) to anon, authenticated;
grant execute on function public.api_admin_set_balance(text,uuid,numeric) to anon, authenticated;
grant execute on function public.api_admin_adjust_balance(text,uuid,numeric) to anon, authenticated;
grant execute on function public.api_admin_delete_user(text,uuid) to anon, authenticated;
grant execute on function public.api_admin_deposits(text) to anon, authenticated;
grant execute on function public.api_approve_deposit(text,uuid) to anon, authenticated;
grant execute on function public.api_reject_deposit(text,uuid) to anon, authenticated;
grant execute on function public.api_admin_withdrawals(text) to anon, authenticated;
grant execute on function public.api_pay_withdrawal(text,uuid) to anon, authenticated;
grant execute on function public.api_reject_withdrawal(text,uuid) to anon, authenticated;

-- Depois do primeiro cadastro:
-- update public.users set role = 'admin' where email = 'seu@email.com';
