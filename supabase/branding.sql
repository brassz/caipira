-- Rode se o schema principal já foi aplicado.
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
