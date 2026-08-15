-- Rode no SQL Editor.

create or replace function public.api_confirm_deposit_by_path(p_path text)
returns numeric
language plpgsql security definer set search_path = public
as $$
declare d public.deposits%rowtype;
begin
  if p_path is null or length(trim(p_path)) < 4 then raise exception 'Referência inválida'; end if;
  select * into d from public.deposits where receipt_path = p_path and status = 'pending' for update;
  if not found then
    select * into d from public.deposits where receipt_path = p_path limit 1;
    if found then return 0; end if;
    raise exception 'Depósito não encontrado';
  end if;
  update public.deposits set status = 'approved' where id = d.id;
  update public.users set balance = balance + d.amount where id = d.user_id;
  return d.amount;
end;
$$;

alter table public.withdrawals add column if not exists payout_id text;

create or replace function public.api_settle_my_withdrawal(p_token text, p_id uuid, p_status text, p_payout text)
returns void
language plpgsql security definer set search_path = public
as $$
declare uid uuid; w public.withdrawals%rowtype;
begin
  uid := public.uid_from_token(p_token);
  if uid is null then raise exception 'Sessão inválida'; end if;
  select * into w from public.withdrawals where id = p_id and user_id = uid and status = 'pending' for update;
  if not found then raise exception 'Saque não encontrado'; end if;
  if p_payout is not null and length(trim(p_payout)) > 0 then
    update public.withdrawals set payout_id = trim(p_payout) where id = p_id;
  end if;
  if p_status = 'paid' then
    update public.withdrawals set status = 'paid', paid_at = now() where id = p_id;
  elsif p_status = 'rejected' then
    update public.withdrawals set status = 'rejected' where id = p_id;
    update public.users set balance = balance + w.amount where id = w.user_id;
  end if;
end;
$$;

create or replace function public.api_confirm_withdrawal_by_payout(p_payout text, p_ok boolean)
returns void
language plpgsql security definer set search_path = public
as $$
declare w public.withdrawals%rowtype;
begin
  if p_payout is null or length(trim(p_payout)) < 4 then return; end if;
  select * into w from public.withdrawals where payout_id = trim(p_payout) and status = 'pending' for update;
  if not found then return; end if;
  if p_ok then
    update public.withdrawals set status = 'paid', paid_at = now() where id = w.id;
  else
    update public.withdrawals set status = 'rejected' where id = w.id;
    update public.users set balance = balance + w.amount where id = w.user_id;
  end if;
end;
$$;

grant execute on function public.api_confirm_deposit_by_path(text) to anon, authenticated;
grant execute on function public.api_settle_my_withdrawal(text, uuid, text, text) to anon, authenticated;
grant execute on function public.api_confirm_withdrawal_by_payout(text, boolean) to anon, authenticated;
