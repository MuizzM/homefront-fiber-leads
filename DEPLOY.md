# Deploying HomeFront Fiber to Render (→ homefrontsolutionsllc.com)

This app is a stateful Node server (Express + SQLite + file uploads), so it needs
a host with a **persistent disk**. Render fits that and deploys straight from GitHub.

## 1. Push the code to GitHub
From this folder:
```bash
git init                # if not already a repo
git add -A
git commit -m "HomeFront Fiber"
git branch -M main
git remote add origin https://github.com/<you>/<repo>.git
git push -u origin main
```
> `.env`, `data.db*`, `uploads/`, and `node_modules/` are gitignored — good, secrets and local data stay off GitHub.

## 2. Create the service on Render
1. Go to https://render.com → **New → Blueprint**.
2. Connect your GitHub and pick this repo. Render reads `render.yaml` and creates a
   web service **with a 1 GB persistent disk mounted at `/data`**.
3. Click **Apply**.

## 3. Set the secret env vars
In the new service → **Environment**, add the values (copy from your local `.env`):
`MAPBOX_TOKEN`, `KFS_AUTH_URL`, `KFS_AUTH_BASIC`, `SCANNER_SUBMIT_SECRET`,
`PROXY_URL`, `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SUPER_ADMIN_EMAILS`.
(`NODE_ENV`, `DATA_DIR`, `TRUST_PROXY`, `APP_ORIGIN` are already set by the blueprint.)

Save → Render builds and deploys. You'll get a `https://homefront-fiber.onrender.com`
URL. Open it and confirm the login screen loads.

## 4. First-run admin setup
The production database starts **empty**. On first load the app runs first-run setup —
create your admin account with your email (the one in `SUPER_ADMIN_EMAILS`). Then run a
scan to populate leads. (If you'd rather migrate your existing local data, see §7.)

## 5. Attach the portal subdomain (portal.homefrontsolutionsllc.com)
The app lives on its own subdomain so your main site at www stays untouched.
1. Render service → **Settings → Custom Domains → Add** `portal.homefrontsolutionsllc.com`.
2. Render shows a **CNAME target** like `homefront-fiber.onrender.com`.
3. At your domain's DNS (registrar / Cloudflare / etc.) add one record:
   - **Type:** CNAME  **Name:** `portal`  **Value:** `<the …onrender.com target>`
4. DNS propagates → Render auto-issues HTTPS. Live at `https://portal.homefrontsolutionsllc.com`.

## 5b. Add the "Portal" button to your main site
On `www.homefrontsolutionsllc.com`, add a link/button pointing at the portal. On any
site builder (WordPress, Wix, Squarespace, custom HTML) it's just a hyperlink:
```html
<a href="https://portal.homefrontsolutionsllc.com" class="portal-btn">Rep Login →</a>
```
Clicking it drops the user straight on the app's login page.

## 6. Lock down the Mapbox token
In the Mapbox dashboard, restrict your public token to `homefrontsolutionsllc.com`
(and `*.homefrontsolutionsllc.com`) so it can't be reused elsewhere.

## 7. (Optional) Migrate existing local data
To bring your current leads/admin instead of starting fresh: open the Render service
**Shell**, then upload/replace `/data/data.db` with your local `data.db` (stop traffic
first). Ask and I'll give you the exact commands.

## Redeploys
Every `git push` to `main` auto-deploys. The `/data` disk (database + uploads) persists
across deploys, so no data is lost.
