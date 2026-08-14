-- Rode TUDO isto no SQL Editor do Supabase.
-- O cadastro 500 acontece porque o trigger em auth.users quebra o signup.
-- Aqui o trigger é removido; o perfil passa a ser criado pelo site após o login.

drop trigger if exists on_auth_user_created on auth.users;

grant usage on schema public to postgres, anon, authenticated, supabase_auth_admin;
grant all on table public.profiles to postgres, supabase_auth_admin;
grant select, insert, update on table public.profiles to authenticated;

alter table public.profiles enable row level security;

drop policy if exists profiles_select on public.profiles;
create policy profiles_select on public.profiles
  for select using (id = auth.uid() or public.is_admin());

drop policy if exists profiles_insert on public.profiles;
create policy profiles_insert on public.profiles
  for insert with check (id = auth.uid());

drop policy if exists profiles_update on public.profiles;
create policy profiles_update on public.profiles
  for update using (id = auth.uid() or public.is_admin());
