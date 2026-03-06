# Build Checkpoint: v1.0 — PrijsWijzer

**Tagged:** 2026-03-06  
**Tag:** `v1.0-checkpoint`

---

## What's built

### App identity
- Name: **PrijsWijzer** ("Price Wizard")
- Logo: `assets/logo.svg` — basket + price-tag icon
- Favicon set, branded header with nav links

### Frontend (`landing.html`)
- Single-page app — responsive (mobile + web), 3-per-row result grid
- Animated green banner with tagline
- **Header nav:** "0/25 free" counter chip · Sign up / Log in · About the app · Report an issue
- **Search:** location (text or GPS), radius selector, item/product input with autocomplete suggestions, Compare 4+ / Specific supermarket modes
- **Results:** dark store cards with price (bold), store name (bold), distance, address, "Tap for categories & directions"
- Store detail modal with categories table, Aldi/AH price comparisons, Google Maps link
- **Dutch orange** (#FF6600) Search button
- About the app modal
- Report an issue modal → saves to backend DB

### Authentication & access control
- **25 free anonymous searches** tracked in localStorage (`pw_anon_count`)
- Free-check counter chip in header (turns red at 1 remaining)
- After 25 searches → Login gate modal with benefits list
- **Magic-code login** (email + 6-digit code, 15-min expiry):
  - `POST /api/auth/send-code` → sends code via Gmail SMTP (nodemailer)
  - `POST /api/auth/verify` → validates code, creates session
  - `GET /api/me` → validates bearer token
  - `POST /api/auth/logout` → invalidates session
- **Security:** magic codes and session tokens stored as SHA-256 hashes in DB (never plaintext)
- After login: "Welcome, Name" + Log out in header; unlimited searches
- Session persisted in localStorage; validated against `/api/me` on page load

### Backend (`server.js`)
| Endpoint | Purpose |
|---|---|
| `GET /api/health` | Status check |
| `GET /api/geocode` | OpenCage geocoding |
| `GET /api/compare` | Price comparison (Apify + fallback demo data) |
| `POST /api/issues` | Save user-reported issues to DB |
| `POST /api/auth/send-code` | Generate + email 6-digit login code |
| `POST /api/auth/verify` | Verify code → create session |
| `GET /api/me` | Return current user from bearer token |
| `POST /api/auth/logout` | Delete session |

### Database (`data/app.db` — SQLite via better-sqlite3)
| Table | Contents |
|---|---|
| `users` | id, email, created_at |
| `sessions` | user_id, SHA-256(token), expires_at (30 days) |
| `magic_codes` | email, SHA-256(code), expires_at (15 min) |
| `magic_links` | (legacy, unused) |
| `issues` | type, description, context, user_agent, created_at |

### Config (`.env` — not committed)
```
OPENCAGE_API_KEY=...
APIFY_TOKEN=...
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=sumansinha.nl@gmail.com
SMTP_PASS=<gmail-app-password>
MAIL_FROM=PrijsWijzer <sumansinha.nl@gmail.com>
```

### Dependencies
`express`, `cors`, `better-sqlite3`, `nodemailer`, `dotenv`

---

## Known limitations at this tag
- Apify API returning 403 (plan/quota issue) — app falls back to demo price data
- No admin UI — user data viewable via `sqlite3 data/app.db`
- App runs locally only (`http://localhost:4000`)
