-- GLB assets cannot live in the image bucket because it deliberately restricts
-- uploads to image MIME types. Models remain publicly readable for player
-- camera mode, while only authenticated creators may write or delete them.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('models', 'models', true, 26214400, array['model/gltf-binary'])
on conflict (id) do update
set public = excluded.public,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "Auth users upload models" on storage.objects;
create policy "Auth users upload models"
on storage.objects for insert to authenticated
with check (bucket_id = 'models');

drop policy if exists "Auth users delete own models" on storage.objects;
create policy "Auth users delete own models"
on storage.objects for delete to authenticated
using (bucket_id = 'models' and owner = (select auth.uid()));
