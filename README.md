# webmaster2627 — BRAINGAINZ.EDU

AI learning portal for grades 9–12. Static HTML/CSS site + Supabase (auth & database), hosted on Vercel.

| Doc | For |
|---|---|
| [docs/BACKEND_INTEGRATION.md](docs/BACKEND_INTEGRATION.md) | Frontend team: how to use login, progress, XP functions |
| [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) | Setting up Supabase + Vercel, env vars, free-tier limits, privacy checklist |

```bash
cp .env.example .env   # fill in SUPABASE_URL + SUPABASE_PUBLISHABLE_KEY
npm install
npm run dev            # http://localhost:3000/home.html
npm run test:backend   # end-to-end backend tests (needs SUPABASE_SECRET_KEY in .env)
```

Layout: `*.html` / `*.css` pages · `js/` backend client (`auth.js`, `progress.js`) · `supabase/migrations/` database schema · `scripts/` build + tests.
