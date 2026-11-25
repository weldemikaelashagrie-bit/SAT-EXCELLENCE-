# SAT EXCELLENCE V2.34 — Release Candidate

This package builds on the recovered V2.33 application and preserves the later GitHub fixes already present in `v2-development`.

## Package contents

- `index.html` — main application, authentication, practice, question bank, administration, settings, and home screen.
- `collections.js` — private annual collection drafts, readiness, review, and manual publishing workflow.
- `shared-data.js` — Supabase question/submission sync, student progress sync, and offline queues.
- `sw.js` — V2.34 app-shell cache and cached Supabase client support.
- `manifest.webmanifest` — installable PWA metadata.
- `icon-192.png`, `icon-512.png`, `icon-512-maskable.png` — existing application icons.
- `supabase_v234_migration.sql` — additive database migration required for V2.34 shared data.

## Required deployment order

1. **Back up the Supabase project first.** Do not skip the backup.
2. Open the Supabase SQL Editor for the existing SAT EXCELLENCE project.
3. Review and run `supabase_v234_migration.sql`. This migration depends on the existing `profiles`, `questions`, and `submissions` tables and the existing `is_main_admin()` and `has_admin_permission(text)` functions.
4. Confirm that the SQL finishes without errors. If it fails, stop and inspect the error before retrying.
5. Upload the application files to the root of the existing `v2-development` branch in the existing GitHub repository. Keep the SQL file available as a project migration record; it does not need to be served as a public page.
6. Wait for GitHub Pages to finish deploying, then open the app while online and sign in.
7. As Main Admin or an Additional Admin with `add_questions`, open **Settings → Upload local questions to shared bank** to migrate any questions that are still stored only on the device. Review the count before confirming.
8. Test a student account, an Additional Admin with limited permissions, and the Main Admin account before relying on the new shared workflow.

## Annual collection workflow

1. In **Add a question**, choose **Private annual collection (unpublished)**.
2. Add questions for the relevant examination year. They remain private in the annual collection.
3. A collection becomes **ready** when it contains at least 60 questions or the examination is marked completed.
4. An authorized question administrator reviews the entire collection and records that review.
5. Publishing is a separate, explicit confirmation. Once published, the collection is locked and its questions enter the official shared Question Bank.

## Data and numbering notes

- Existing local questions are retained. The first online sync merges the server bank into the existing local order rather than replacing the local list.
- The migration adds a stable `display_order` value so new devices can retrieve the same stored question order. The library still displays English before Mathematics and preserves each part's order.
- Existing local student progress is merged on the first V2.34 workspace sync. Later progress snapshots synchronize scores, mistakes, bookmarks, and resumable exams.
- Offline submissions and question changes are kept locally and queued where the signed-in account is available. They synchronize when connectivity returns.
- The app does not contain a Supabase service-role key. Database access uses the existing publishable key, RLS policies, and server-side RPC checks.

## Important verification boundary

The application code and SQL migration have been prepared and locally checked. The SQL migration has **not** been executed against the live Supabase project, and the real project has not yet been tested end-to-end with multiple accounts. Complete those steps before treating this release candidate as production-ready.
