# Deployment & Operations

Architecture: **Vercel Hobby (static hosting) + Supabase Free (Auth + Postgres) + GitHub**. Expected cost: **$0/month** (plus an optional ~$10–15/year for a custom domain).

```
GitHub (main) ──push──▶ Vercel build: `npm run build`
                          ├─ writes js/config.js from env vars
                          └─ serves dist/ over HTTPS (CDN)
Browser ──HTTPS──▶ Supabase Auth + Postgres (RLS)
```

There are no servers or serverless functions of our own. The browser talks to Supabase directly with the **public** key, and Row Level Security plus the database functions enforce all rules.

---

## 1. Supabase setup (one-time)

1. **Create the project** at <https://supabase.com/dashboard> → New project (Free plan).
   * Region: closest to students (e.g. *West US* or *East US*).
   * Save the database password in a password manager. It's needed only for the CLI.
2. **Apply the schema** from this repo:
   ```bash
   supabase login
   supabase link --project-ref <your-project-ref>   # asks for the DB password
   supabase db push                                 # applies supabase/migrations/*.sql
   ```
   (Alternative: paste `supabase/migrations/20261122000000_initial_schema.sql` into Dashboard → SQL Editor → Run.)
3. **Authentication → Sign In / Providers → Email:**
   * Email provider: **enabled**
   * **Confirm email: ON** (required)
   * Minimum password length: **8**. Password requirements: *letters and digits*.
   * Secure password change: ON
4. **Authentication → URL Configuration:**
   * **Site URL:** `https://<your-vercel-domain>` (update once a custom domain exists)
   * **Redirect URLs** (add all):
     ```
     https://<your-vercel-domain>/**
     https://<your-project>-*-<your-team>.vercel.app/**     # preview deployments (optional)
     http://localhost:3000/**
     ```
5. **Custom SMTP (required for real students).** Supabase's built-in email sender only delivers to your Supabase **team members** and is capped at about **2 emails/hour**. Without custom SMTP, students won't receive verification or password-reset emails.
   * Free option: [Resend](https://resend.com) (free tier ~3,000 emails/month, 100/day). Verify a sending domain, create an API key.
   * Dashboard → Authentication → **Emails → SMTP Settings** → enable custom SMTP:
     host `smtp.resend.com`, port `465`, user `resend`, password = API key, sender e.g. `no-reply@yourdomain.org`, sender name `BRAINGAINZ.EDU`.
   * Then Authentication → **Rate Limits**: set emails/hour to something like 30.
   * A verified sending domain is needed, which in practice means owning a domain (see §4).
6. **Email templates (optional):** Authentication → Emails → Templates. Keep the `{{ .ConfirmationURL }}` link; you can reword the text and add the site name.
7. **API keys:** Project Settings → API Keys. Copy the **Publishable key** (`sb_publishable_…`) and the Project URL. **Never** put the Secret key (`sb_secret_…` / `service_role`) in Vercel or any browser code.

## 2. Vercel setup (one-time)

1. <https://vercel.com/new> → **Import** the GitHub repo `webmaster2627`. The GitHub repo owner (or a collaborator with admin rights) must authorize the Vercel GitHub app.
2. Framework preset: **Other**. Build/output settings come from `vercel.json` (`npm run build` → `dist/`), so leave the overrides off.
3. **Environment Variables** (Production + Preview + Development):

   | Name | Value | Public? |
   |---|---|---|
   | `SUPABASE_URL` | `https://<ref>.supabase.co` | yes (sent to browsers) |
   | `SUPABASE_PUBLISHABLE_KEY` | `sb_publishable_…` | yes (sent to browsers) |

   The build **fails on purpose** if a secret/service-role key is pasted here by mistake.
4. **Deploy.** Every push to `main` then redeploys production, and every other branch or PR gets a preview URL.
5. After the first deploy, put the real URL into Supabase → URL Configuration (step 1.4).
6. HTTPS is automatic. Security headers are set in `vercel.json`.

### Custom domain (optional)
Vercel → Project → Settings → Domains → add `yourdomain.org`, then create the DNS records it shows. Afterwards:
* update Supabase **Site URL** and **Redirect URLs**, and
* use the same domain for the Resend sending domain.

## 3. Environment variables

| Variable | Where | Purpose |
|---|---|---|
| `SUPABASE_URL` | Vercel, `.env` | Project URL (public) |
| `SUPABASE_PUBLISHABLE_KEY` | Vercel, `.env` | Public client key. Safe in browsers because RLS protects data. `SUPABASE_ANON_KEY` (legacy) is also accepted |
| `SUPABASE_SECRET_KEY` | **local `.env` only** | Used only by `npm run test:backend` to create and delete test users. Never deploy it |
| `TEST_EMAIL_BASE` | local `.env` only | Optional real mailbox for test emails |

`.env`, `js/config.js` and `dist/` are git-ignored.

## 4. Hosting terms: is Vercel Hobby allowed?

Vercel's Terms limit Hobby to **"personal or non-commercial use."** Their Fair Use Guidelines define commercial use as a deployment that brings anyone involved financial gain.

* ✅ **A student team's free, non-commercial learning portal** (no ads, no paid features, nobody paid to build it) fits Hobby.
* ⚠️ **If the school or district officially operates it**, or it starts charging, running ads, or paying developers, it's no longer clearly "personal/non-commercial." Vercel hasn't answered organizational-but-unpaid cases definitively. Then either:
  * move to **Vercel Pro** (from $20/month per member), or
  * move to a free host that allows organizational/commercial use. Because this is a plain static site, **Cloudflare Pages** or **Netlify Free** take about 10 minutes to switch to (same build command and output folder), and the Supabase part doesn't change.
* Vercel may change Hobby terms at any time. Re-check <https://vercel.com/legal/terms> and <https://vercel.com/docs/limits/fair-use-guidelines> before launch.

## 5. Free-tier limits & when to upgrade

| Limit (Free) | Our expected use | Upgrade trigger |
|---|---|---|
| **Supabase pauses a project after ~1 week of low activity** | Likely over school breaks | Restore from the dashboard (one click; data kept, restorable for 90 days). For guaranteed uptime: Supabase Pro ($25/month) |
| Supabase DB size 500 MB | Each progress row is ~200 bytes, so roughly 2M rows | Unlikely |
| Supabase 50,000 monthly active users | ~10–100 | Unlikely |
| Supabase 2 active free projects per org | 1 | — |
| Supabase built-in email: 2/hour, team only | Not usable for students | **Custom SMTP (free) is required** |
| Resend free ~100 emails/day | Signups + resets | Large class sign-up day → stagger, or a paid email plan |
| Supabase Free has no automatic backups you can download | — | Export periodically (Dashboard → Database → Backups, or `supabase db dump`), or Pro for daily backups |
| Vercel Hobby bandwidth/requests (generous for a static site) | Tiny | Only if the site goes viral. Note: `logo.png` is 690 KB; compressing it would help |
| Vercel Hobby: non-commercial only | See §4 | Organizational/commercial use |

**Keeping the project awake:** any real student activity counts. Over long breaks, expect a pause and restore it before classes resume. Don't build "keep-alive" pingers, since they work against Supabase's fair-use intent.

## 6. Privacy & compliance checklist (review before public launch)

> This is **not** legal advice, and nothing here certifies compliance. Have a teacher or administrator (and, if the school operates the site, the district's privacy or IT office) review it.

What we collect: **email, display name, password (hashed by Supabase, never visible to us), learning progress, and timestamps.** Supabase Auth also records IP addresses and user agents in its auth logs. We don't collect real names, birthdays, phone numbers, locations or school names.

Items to review:
1. **COPPA (US, under 13):** grades 9–12 are typically 14–18, but some 9th graders are 13. If anyone under 13 could sign up, COPPA (parental consent) applies. Consider an "I am 13 or older" checkbox on signup, or restricting signups.
2. **FERPA / district agreements:** if a school or district directs students to use this, progress data may count as education records. Districts often require a signed **Data Privacy Agreement** with vendors (here: Supabase, Vercel, Resend).
3. **State student-privacy laws:** e.g. Colorado's Student Data Transparency and Security Act, if Colorado students use it under school direction, plus whichever states your users are in.
4. **Privacy policy page:** say what's collected, why, who processes it (Supabase, Vercel, email provider), how long it's kept, and how to delete it. The backend already supports self-service deletion (`deleteAccount()` → removes everything); the frontend needs a button for it.
5. **Data location:** Supabase/Vercel store data in the region you choose (pick a US region for US students).
6. **Display names** are only visible to the student themselves (no leaderboards exist). If a public leaderboard is added later, that changes the privacy picture and needs a review.
7. **Retention:** decide how long inactive accounts are kept (e.g. delete after graduation or after 1 year inactive).
8. **Footer contact info:** the site footer shows a phone number and Gmail address. Make sure those are meant to be public.

## 7. Production readiness checklist

- [ ] Migration applied (`supabase db push`), and Dashboard → Advisors → Security shows no RLS warnings
- [ ] Confirm email ON, password min length 8
- [ ] Custom SMTP configured and a test email received
- [ ] Site URL + Redirect URLs set to the production domain
- [ ] Vercel env vars set, production deploy green
- [ ] `npm run test:backend` passes against the production project
- [ ] Manual browser check: signup → verify email → login → modules → logout → forgot password → reset
- [ ] Privacy review (§6) done
