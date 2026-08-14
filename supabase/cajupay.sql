-- Rode no SQL Editor. Confirma depósito PIX da CajuPay pelo payment_id.

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

grant execute on function public.api_confirm_deposit_by_path(text) to anon, authenticated;
