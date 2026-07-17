# saltcorn-large-file-upload

A Saltcorn fieldview, **"Large file upload"**, for `File` fields in edit views.

Pick a file and it starts uploading right away in the background — in chunks, with a
progress bar, and automatic retry if the connection drops. Once it's done, the field is
filled in automatically. Saving the form doesn't re-upload the file; it just links the row
to the file that was already uploaded.

## Limitations

- Works with local disk storage only — not yet supported when S3 storage is enabled.
- Uploads must be finished in one server session; an in-progress upload won't survive a
  server restart. Abandoned uploads are cleaned up automatically after a few hours.
- Who can access an uploaded file afterward follows the same "Role required to access
  added files" setting as any other File field (defaults to admin-only if not set).
- Requires the user to be logged in, with a role allowed to upload files at all (same
  setting used by Saltcorn's built-in file uploads) and with write access to the table
  the field belongs to.
