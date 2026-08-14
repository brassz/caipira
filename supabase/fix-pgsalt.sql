-- Rode só isto no SQL Editor para corrigir o gen_salt.

create extension if not exists pgcrypto with schema extensions;

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
  t := encode(gen_random_bytes(32), 'hex');
  insert into public.sessions (token, user_id, expires_at)
  values (t, u.id, now() + interval '30 days');
  return jsonb_build_object(
    'token', t,
    'user', jsonb_build_object('id', u.id, 'email', u.email, 'username', u.username, 'balance', u.balance, 'role', u.role)
  );
end;
$$;

grant execute on function public.api_register(text,text,text) to anon, authenticated;
grant execute on function public.api_login(text,text) to anon, authenticated;
