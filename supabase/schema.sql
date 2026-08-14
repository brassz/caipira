-- Cole no SQL Editor do Supabase e execute.
-- Depois torne um usuário admin:
-- update public.profiles set role = 'admin' where email = 'seu@email.com';

create extension if not exists "pgcrypto";

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text,
  username text,
  balance numeric(12,2) not null default 0,
  role text not null default 'user' check (role in ('user','admin')),
  created_at timestamptz not null default now()
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

create table if not exists public.deposits (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  amount numeric(12,2) not null check (amount > 0),
  receipt_path text,
  status text not null default 'pending' check (status in ('pending','approved','rejected')),
  created_at timestamptz not null default now(),
  reviewed_at timestamptz,
  reviewed_by uuid
);

create table if not exists public.withdrawals (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  amount numeric(12,2) not null check (amount > 0),
  pix_key text not null,
  status text not null default 'pending' check (status in ('pending','paid','rejected')),
  available_at timestamptz not null default (now() + interval '2 hours'),
  created_at timestamptz not null default now(),
  paid_at timestamptz
);

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and role = 'admin'
  );
$$;

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, email, username, balance, role)
  values (
    new.id,
    coalesce(new.email, ''),
    coalesce(
      nullif(trim(new.raw_user_meta_data->>'username'), ''),
      split_part(coalesce(new.email, 'jogador'), '@', 1)
    ),
    0,
    'user'
  )
  on conflict (id) do nothing;
  return new;
exception when others then
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;

create or replace function public.protect_profile()
returns trigger
language plpgsql
as $$
begin
  if not public.is_admin() then
    new.balance := old.balance;
    new.role := old.role;
    new.email := old.email;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_protect_profile on public.profiles;
create trigger trg_protect_profile
  before update on public.profiles
  for each row execute procedure public.protect_profile();

create or replace function public.buy_in(p_table text)
returns numeric
language plpgsql
security definer
set search_path = public
as $$
declare
  v_buy numeric;
  v_bal numeric;
begin
  select buyin into v_buy from public.poker_tables where id = p_table;
  if v_buy is null then raise exception 'Mesa inválida'; end if;
  select balance into v_bal from public.profiles where id = auth.uid() for update;
  if v_bal is null then raise exception 'Conta não encontrada'; end if;
  if v_bal < v_buy then raise exception 'Saldo insuficiente'; end if;
  update public.profiles set balance = balance - v_buy where id = auth.uid();
  return v_buy;
end;
$$;

create or replace function public.cash_out(p_amount numeric)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_amount is null or p_amount <= 0 then return; end if;
  update public.profiles set balance = balance + p_amount where id = auth.uid();
end;
$$;

create or replace function public.request_withdraw(p_amount numeric, p_pix text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_bal numeric;
  v_id uuid;
begin
  if p_amount is null or p_amount <= 0 then raise exception 'Valor inválido'; end if;
  if p_pix is null or length(trim(p_pix)) < 5 then raise exception 'Chave PIX inválida'; end if;
  select balance into v_bal from public.profiles where id = auth.uid() for update;
  if v_bal < p_amount then raise exception 'Saldo insuficiente'; end if;
  update public.profiles set balance = balance - p_amount where id = auth.uid();
  insert into public.withdrawals (user_id, amount, pix_key)
  values (auth.uid(), p_amount, trim(p_pix))
  returning id into v_id;
  return v_id;
end;
$$;

create or replace function public.approve_deposit(p_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare d public.deposits%rowtype;
begin
  if not public.is_admin() then raise exception 'Sem permissão'; end if;
  select * into d from public.deposits where id = p_id and status = 'pending' for update;
  if not found then raise exception 'Depósito não encontrado'; end if;
  update public.deposits
    set status = 'approved', reviewed_at = now(), reviewed_by = auth.uid()
    where id = p_id;
  update public.profiles set balance = balance + d.amount where id = d.user_id;
end;
$$;

create or replace function public.reject_deposit(p_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then raise exception 'Sem permissão'; end if;
  update public.deposits
    set status = 'rejected', reviewed_at = now(), reviewed_by = auth.uid()
    where id = p_id and status = 'pending';
end;
$$;

create or replace function public.pay_withdrawal(p_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare w public.withdrawals%rowtype;
begin
  if not public.is_admin() then raise exception 'Sem permissão'; end if;
  select * into w from public.withdrawals where id = p_id and status = 'pending' for update;
  if not found then raise exception 'Saque não encontrado'; end if;
  if now() < w.available_at then raise exception 'Aguarde 2 horas após o pedido'; end if;
  update public.withdrawals set status = 'paid', paid_at = now() where id = p_id;
end;
$$;

create or replace function public.reject_withdrawal(p_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare w public.withdrawals%rowtype;
begin
  if not public.is_admin() then raise exception 'Sem permissão'; end if;
  select * into w from public.withdrawals where id = p_id and status = 'pending' for update;
  if not found then raise exception 'Saque não encontrado'; end if;
  update public.withdrawals set status = 'rejected' where id = p_id;
  update public.profiles set balance = balance + w.amount where id = w.user_id;
end;
$$;

create or replace function public.admin_set_balance(p_user uuid, p_balance numeric)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then raise exception 'Sem permissão'; end if;
  if p_balance < 0 then raise exception 'Saldo inválido'; end if;
  update public.profiles set balance = p_balance where id = p_user;
end;
$$;

alter table public.profiles enable row level security;
alter table public.poker_tables enable row level security;
alter table public.deposits enable row level security;
alter table public.withdrawals enable row level security;

drop policy if exists profiles_select on public.profiles;
create policy profiles_select on public.profiles for select using (id = auth.uid() or public.is_admin());
drop policy if exists profiles_update on public.profiles;
create policy profiles_update on public.profiles for update using (id = auth.uid() or public.is_admin());
drop policy if exists profiles_insert on public.profiles;
create policy profiles_insert on public.profiles for insert with check (id = auth.uid());

drop policy if exists tables_select on public.poker_tables;
create policy tables_select on public.poker_tables for select using (true);

drop policy if exists deposits_select on public.deposits;
create policy deposits_select on public.deposits for select using (user_id = auth.uid() or public.is_admin());
drop policy if exists deposits_insert on public.deposits;
create policy deposits_insert on public.deposits for insert with check (user_id = auth.uid());

drop policy if exists withdrawals_select on public.withdrawals;
create policy withdrawals_select on public.withdrawals for select using (user_id = auth.uid() or public.is_admin());

grant execute on function public.buy_in(text) to authenticated;
grant execute on function public.cash_out(numeric) to authenticated;
grant execute on function public.request_withdraw(numeric, text) to authenticated;
grant execute on function public.approve_deposit(uuid) to authenticated;
grant execute on function public.reject_deposit(uuid) to authenticated;
grant execute on function public.pay_withdrawal(uuid) to authenticated;
grant execute on function public.reject_withdrawal(uuid) to authenticated;
grant execute on function public.admin_set_balance(uuid, numeric) to authenticated;

insert into storage.buckets (id, name, public)
values ('receipts', 'receipts', false)
on conflict (id) do nothing;

drop policy if exists receipts_insert on storage.objects;
create policy receipts_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'receipts' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists receipts_select on storage.objects;
create policy receipts_select on storage.objects for select to authenticated
  using (bucket_id = 'receipts' and ((storage.foldername(name))[1] = auth.uid()::text or public.is_admin()));

insert into storage.buckets (id, name, public)
values ('branding', 'branding', true)
on conflict (id) do nothing;

drop policy if exists branding_public_read on storage.objects;
create policy branding_public_read on storage.objects for select
  using (bucket_id = 'branding');

drop policy if exists branding_admin_write on storage.objects;
create policy branding_admin_write on storage.objects for all to authenticated
  using (public.is_admin())
  with check (public.is_admin());
