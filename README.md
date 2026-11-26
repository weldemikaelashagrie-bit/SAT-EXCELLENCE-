# SAT EXCELLENCE V2.36 — Repair Release

This package is built from the existing V2.35 release source. It preserves the current application structure, Supabase shared-data integration, and existing database.

## Repairs in V2.36

- Keeps the Home learning-statistics card visible to students.
- Hides the Home Backup and Restore card from users without question-management permission.
- Hides the Settings Backup and Restore heading, description, and actions from unauthorized users.
- Adds permission checks inside the backup export, year-export, download, and copy functions.
- Keeps the Question Bank count line visible in both the examination-year view and the selected-year view.
- Updates the application version labels and refreshes the service-worker cache to V2.36.

## Deployment

1. Keep a copy of the current V2.35 files before replacing them.
2. Upload the files in this ZIP to the root of the existing GitHub Pages publishing branch, replacing the matching files.
3. Keep the current GitHub Pages branch and folder settings unchanged.
4. Do not upload any SQL migration and do not rerun a previous Supabase migration for these front-end repairs.
5. After deployment, open the app online and reload it so the V2.36 service worker can install.

## Recommended checks

- Sign in as a student: the Home learning-statistics card and Question Bank count should be visible; Backup and Restore should not be shown.
- Sign in as an administrator with question-management permission: Backup and Restore should remain available.
- Confirm that the service worker has updated and that the app opens normally after one online reload.

## Known issue not included in this repair

The previously reported Supabase signup response `email_address_invalid` has not been diagnosed or fixed by this release. It requires inspection of the Supabase Auth logs/request details. This package does not weaken email validation or change Auth settings.

## Verification boundary

This builder checks source-match counts and key patch assertions before creating the ZIP. It does not deploy to GitHub, modify Supabase, or perform live multi-account/device testing. Test the deployed app before treating the release as production-ready.
