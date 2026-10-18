# License API

Small Vercel function that sits between your portals and Turso, so the Turso token never ships to customers.

## Deploy

1. Put this folder in its own Vercel project (`vercel` from this folder, or import it from Git).
2. Add environment variables (Project → Settings → Environment Variables):

   | Name | Value |
   |---|---|
   | `TURSO_URL` | `libsql://your-db-your-org.turso.io` |
   | `TURSO_TOKEN` | a Turso token for this database |
   | `ALLOWED_ORIGINS` | optional, comma-separated, e.g. `https://billcreator.vercel.app,https://parkingregister.vercel.app` (default `*`) |

3. Redeploy. Your endpoint is `https://<project>.vercel.app/api/license`.
4. In **License Manager → Settings**, set *License API URL* to that endpoint, then re-copy each portal's script from the **Integration** page.

## What it checks

Key exists for that portal · portal enabled · not revoked · started on first use · not expired · device limit. Every activation and new device is written to the Activity log.

## Notes

- Once every portal uses this endpoint, the token you used in the browser-side guard can be rotated or deleted.
- The manager page itself still talks to Turso directly from the admin's browser (token kept in that browser only, behind the admin password).
- Rate limit: 40 requests per minute per IP, per function instance.
