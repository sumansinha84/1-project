# Deploying Supermarket Price Compare

Two ways to get your app in front of friends for feedback:

1. **Web (fastest)** – Deploy the backend + web app so anyone can open a link in their browser.
2. **Play Store (Android)** – Build an Android app and share it via Google Play (e.g. internal testing).

---

## Option 1: Put the app on the internet (web)

Your app is already set up as a **web app**: the Node server serves `landing.html` and the API. Deploy that single project to a host so friends get a URL like `https://your-app.onrender.com`.

### Recommended: Render (free tier)

1. **Push your code to GitHub** (do not commit `.env` or `data/` – they’re in `.gitignore`).

2. **Create a Render account**: [render.com](https://render.com) → Sign up (free).

3. **New Web Service**  
   Dashboard → **New** → **Web Service** → Connect your GitHub repo → Select this project’s repo.

4. **Configure the service**
   - **Name**: e.g. `supermarket-price-compare`
   - **Root directory**: leave blank (or set if the app is in a subfolder).
   - **Runtime**: Node
   - **Build command**: `npm install`
   - **Start command**: `node server.js`
   - **Instance type**: Free

5. **Environment variables** (Render → your service → **Environment**)  
   Add the same variables you have in `.env` (values only, no quotes needed):

   - `OPENCAGE_API_KEY`
   - `APIFY_TOKEN`
   - `SMTP_HOST` (e.g. `smtp.gmail.com`)
   - `SMTP_PORT` (e.g. `587`)
   - `SMTP_SECURE` (e.g. `false`)
   - `SMTP_USER`
   - `SMTP_PASS`
   - `MAIL_FROM` (e.g. `PrijsWijzer <your@gmail.com>`)

   Do **not** paste your whole `.env` file; add each variable separately in the Render UI.

6. **Deploy**  
   Click **Create Web Service**. Render will build and deploy. When it’s done, your app will be at:

   `https://<your-service-name>.onrender.com`

   Opening that URL will show the app (root `/` now serves the landing page).

**Note:** On Render’s free tier, the filesystem is ephemeral: the SQLite file in `data/` can be recreated on each deploy, so user accounts and data may not persist. For long-term data, use a hosted database (e.g. PostgreSQL on Render) or a host with persistent disk (e.g. Railway).

### Alternative: Railway

- [railway.app](https://railway.app) → New project → Deploy from GitHub.
- Set **Start command** to `node server.js` and add the same environment variables as above.
- Railway gives you a public URL; same idea: share that link with friends.

---

## Option 2: Put the app on the Play Store (Android)

To have friends install the app from the Play Store (or at least from a Play Store “internal testing” link), you need to build an Android app and then upload it to Google Play.

### Prerequisites

- **Expo / EAS**: Your app is already an Expo project. You’ll use [EAS Build](https://docs.expo.dev/build/introduction/) to build the Android app.
- **Google Play Developer account**: One-time fee of **$25** – [play.google.com/console](https://play.google.com/console).

### Steps

1. **Install EAS CLI and log in**
   ```bash
   npm install -g eas-cli
   eas login
   ```
   Use your Expo account (or create one at [expo.dev](https://expo.dev)).

2. **Configure the project for EAS**
   ```bash
   eas build:configure
   ```
   This creates or updates `eas.json`.

3. **Point the app at your deployed API**  
   Your Expo app (e.g. `App.js`) or any shared config must call your **deployed** backend URL, not `localhost`. For example, if you deployed to Render, set something like:
   - `https://your-app.onrender.com`
   in your app’s API base URL (environment variable or config constant).  
   If the current Expo app still uses mock data and doesn’t call the backend, you can skip this until you wire it to the live API.

4. **Build an Android app (AAB)**
   ```bash
   eas build --platform android --profile production
   ```
   (Or use a `preview` profile for internal testing – see EAS docs.)  
   EAS will build in the cloud and give you a download link for the `.aab` file.

5. **Create an app in Google Play Console**
   - Go to [Google Play Console](https://play.google.com/console) → **Create app**.
   - Fill in app name, default language, and whether it’s free/paid.
   - Complete the required “App content” and “Policy” sections (e.g. privacy policy URL, data safety form). You can start with a simple privacy policy page.

6. **Upload the build**
   - In Play Console: **Release** → **Testing** → **Internal testing** → **Create new release**.
   - Upload the `.aab` file from the EAS build (or use `eas submit` to send it automatically).
   - Add yourself and your friends as **internal testers** (email list). Save.

7. **Share the link with friends**  
   Once the release is available, internal testers get an opt-in link. Share that link; they open it, accept the invite, and can install the app from the Play Store.

For **production** (public listing), you’d create a production release instead of internal testing and complete store listing, screenshots, and content rating.

---

## Summary

| Goal                         | What to do |
|-----------------------------|------------|
| **Friends try it in a browser** | Deploy backend + `landing.html` to Render (or Railway), add env vars, share the URL. |
| **Friends install on Android**  | EAS Build → Android AAB → Google Play Console → Internal testing → add testers and share the testing link. |

If you tell me which path you want first (web only, or web + Play Store), I can give you the exact commands and checklist for your repo (e.g. Render start command and env list, or an `eas.json` snippet for internal testing).
