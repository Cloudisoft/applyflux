-- Private document bucket. Objects are stored at "<user_id>/<document_id>/<file>".
-- Uploads and downloads go through the ApplyFlux API (which validates type,
-- size and content and issues short-lived signed URLs); these policies make
-- sure that even direct Storage access with a user JWT is confined to the
-- user's own folder.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'documents', 'documents', false, 10485760,
  array[
    'application/pdf',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'text/plain', 'text/markdown', 'application/rtf'
  ]
)
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

create policy "documents_read_own" on storage.objects for select to authenticated
  using (bucket_id = 'documents' and (storage.foldername(name))[1] = (select auth.uid())::text);

create policy "documents_delete_own" on storage.objects for delete to authenticated
  using (bucket_id = 'documents' and (storage.foldername(name))[1] = (select auth.uid())::text);

-- No insert/update policy for end users: new documents must pass server-side validation.
