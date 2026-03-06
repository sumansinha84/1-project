require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const nodemailer = require('nodemailer');

const SMTP_HOST = process.env.SMTP_HOST || '';
const SMTP_PORT = parseInt(process.env.SMTP_PORT || '587', 10);
const SMTP_SECURE = process.env.SMTP_SECURE === 'true';
const SMTP_USER = process.env.SMTP_USER || '';
const SMTP_PASS = process.env.SMTP_PASS || '';
const MAIL_FROM = process.env.MAIL_FROM || SMTP_USER || 'PrijsWijzer <noreply@prijswijzer.nl>';

let mailTransporter = null;
if (SMTP_HOST && SMTP_USER && SMTP_PASS) {
  try {
    mailTransporter = nodemailer.createTransport({
      host: SMTP_HOST,
      port: SMTP_PORT,
      secure: SMTP_SECURE,
      auth: { user: SMTP_USER, pass: SMTP_PASS },
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('Mail transporter init failed:', err.message);
  }
}

const app = express();
const dbPath = path.join(__dirname, 'data', 'app.db');
let db;
try {
  const fs = require('fs');
  fs.mkdirSync(path.join(__dirname, 'data'), { recursive: true });
  db = new Database(dbPath);
  db.exec(`
    CREATE TABLE IF NOT EXISTS issues (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL,
      description TEXT NOT NULL,
      context TEXT,
      user_agent TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT UNIQUE NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS magic_codes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL,
      code TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS magic_links (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL,
      token TEXT UNIQUE NOT NULL,
      expires_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id),
      token TEXT UNIQUE NOT NULL,
      expires_at TEXT NOT NULL
    );
  `);
} catch (err) {
  // eslint-disable-next-line no-console
  console.warn('SQLite init failed:', err.message, '- issue reporting will fail');
  db = null;
}
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname)));

const PORT = process.env.PORT || 4000;
const OPENCAGE_API_KEY = process.env.OPENCAGE_API_KEY;
const APIFY_TOKEN = process.env.APIFY_TOKEN;
const APIFY_ACTOR_ID = 'harvestedge/dutch-supermarkets-all-11';

// One-way hash for storing codes and tokens — never store secrets in plaintext.
function sha256(str) {
  return crypto.createHash('sha256').update(str).digest('hex');
}

// Approximate store locations for multiple Dutch supermarket chains.
// These are used only to estimate distance from the user.
const STORES = [
  // Amsterdam
  {
    chain: 'Albert Heijn',
    storeName: 'Albert Heijn · Amsterdam Centrum',
    address: 'Nieuwezijds Voorburgwal 226, Amsterdam',
    lat: 52.372,
    lon: 4.9,
  },
  {
    chain: 'Jumbo',
    storeName: 'Jumbo · Amsterdam Watergraafsmeer',
    address: 'Middenweg 55, Amsterdam',
    lat: 52.35,
    lon: 4.94,
  },
  {
    chain: 'Lidl',
    storeName: 'Lidl · Amsterdam Oost',
    address: 'Molukkenstraat 200, Amsterdam',
    lat: 52.36,
    lon: 4.93,
  },
  {
    chain: 'Dirk',
    storeName: 'Dirk · Amsterdam Noord',
    address: 'Meeuwenlaan 123, Amsterdam',
    lat: 52.4,
    lon: 4.92,
  },
  {
    chain: 'Plus',
    storeName: 'Plus · Amsterdam West',
    address: 'Mercatorplein 85, Amsterdam',
    lat: 52.368,
    lon: 4.853,
  },
  // Rotterdam
  {
    chain: 'Albert Heijn',
    storeName: 'Albert Heijn · Rotterdam Centrum',
    address: 'Coolsingel 42, Rotterdam',
    lat: 51.92,
    lon: 4.48,
  },
  {
    chain: 'Jumbo',
    storeName: 'Jumbo · Rotterdam Noord',
    address: 'Bergweg 150, Rotterdam',
    lat: 51.94,
    lon: 4.47,
  },
  {
    chain: 'Lidl',
    storeName: 'Lidl · Rotterdam Zuid',
    address: 'Brielselaan 85, Rotterdam',
    lat: 51.89,
    lon: 4.48,
  },
  {
    chain: 'Dirk',
    storeName: 'Dirk · Rotterdam Zuidplein',
    address: 'Zuidplein 420, Rotterdam',
    lat: 51.885,
    lon: 4.489,
  },
  {
    chain: 'Plus',
    storeName: 'Plus · Rotterdam Alexander',
    address: 'Prins Alexanderlaan 35, Rotterdam',
    lat: 51.95,
    lon: 4.55,
  },
  // Utrecht
  {
    chain: 'Albert Heijn',
    storeName: 'Albert Heijn · Utrecht Centrum',
    address: 'Lange Viestraat 2, Utrecht',
    lat: 52.09,
    lon: 5.12,
  },
  {
    chain: 'Jumbo',
    storeName: 'Jumbo · Utrecht Overvecht',
    address: 'Zambesidreef 27, Utrecht',
    lat: 52.12,
    lon: 5.11,
  },
  {
    chain: 'Lidl',
    storeName: 'Lidl · Utrecht Leidsche Rijn',
    address: 'Parkwijklaan 20, Utrecht',
    lat: 52.11,
    lon: 5.06,
  },
  {
    chain: 'Plus',
    storeName: 'Plus · Utrecht Lunetten',
    address: 'Henriettedreef 1, Utrecht',
    lat: 52.066,
    lon: 5.145,
  },
  // Other chains – example stores
  {
    chain: 'Aldi',
    storeName: 'Aldi · Amsterdam Slotervaart',
    address: 'Johan Huizingalaan 111, Amsterdam',
    lat: 52.35,
    lon: 4.83,
  },
  {
    chain: 'SPAR',
    storeName: 'SPAR · Utrecht Science Park',
    address: 'Heidelberglaan 15, Utrecht',
    lat: 52.086,
    lon: 5.176,
  },
  {
    chain: 'Hoogvliet',
    storeName: 'Hoogvliet · Rotterdam Nesselande',
    address: 'Kosboulevard 1, Rotterdam',
    lat: 51.97,
    lon: 4.57,
  },
  {
    chain: 'Vomar',
    storeName: 'Vomar · Amsterdam Noord',
    address: 'Boven IJ, Amsterdam',
    lat: 52.405,
    lon: 4.93,
  },
  {
    chain: 'Poiesz',
    storeName: 'Poiesz · Sneek',
    address: 'Prins Hendrikkade 1, Sneek',
    lat: 53.038,
    lon: 5.66,
  },
  {
    chain: 'DekaMarkt',
    storeName: 'DekaMarkt · Haarlem',
    address: 'Schalkwijkerstraat 83, Haarlem',
    lat: 52.373,
    lon: 4.64,
  },
];

function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

function normalizeSupermarketName(raw) {
  const s = (raw || '').toString().toLowerCase();
  if (!s) return null;
  if (s.includes('ah') || s.includes('albert')) return 'Albert Heijn';
  if (s.includes('jumbo')) return 'Jumbo';
  if (s.includes('dirk')) return 'Dirk';
  if (s.includes('lidl')) return 'Lidl';
  if (s.includes('plus')) return 'Plus';
  if (s.includes('aldi')) return 'Aldi';
  if (s.includes('spar')) return 'SPAR';
  if (s.includes('hoogvliet')) return 'Hoogvliet';
  if (s.includes('vomar')) return 'Vomar';
  if (s.includes('poiesz')) return 'Poiesz';
  if (s.includes('deka')) return 'DekaMarkt';
  return null;
}

async function geocodeLocation(query) {
  if (!OPENCAGE_API_KEY) {
    throw new Error('OPENCAGE_API_KEY is not configured.');
  }

  const url = new URL('https://api.opencagedata.com/geocode/v1/json');
  url.searchParams.set('q', query);
  url.searchParams.set('key', OPENCAGE_API_KEY);
  url.searchParams.set('limit', '1');
  url.searchParams.set('countrycode', 'nl');
  url.searchParams.set('no_annotations', '1');

  const response = await fetch(url.toString());
  if (!response.ok) {
    throw new Error(`OpenCage request failed with status ${response.status}`);
  }

  const data = await response.json();
  if (!data.results || !data.results.length) {
    throw new Error('No coordinates found for this location.');
  }

  const { lat, lng } = data.results[0].geometry;
  return { lat, lon: lng };
}

async function runApifyActor(query, maxResults = 80) {
  if (!APIFY_TOKEN) {
    throw new Error('APIFY_TOKEN is not configured.');
  }

  const input = {
    keyterms: [query],
    maxResults,
    supermarkets: [
      'ah',
      'jumbo',
      'dirk',
      'lidl',
      'plus',
      'aldi',
      'spar',
      'hoogvliet',
      'vomar',
      'poiesz',
      'dekamarkt',
    ],
    throttleDelay: 700,
  };

  const runRes = await fetch(
    `https://api.apify.com/v2/acts/${encodeURIComponent(
      APIFY_ACTOR_ID,
    )}/runs?token=${encodeURIComponent(APIFY_TOKEN)}&waitForFinish=1200`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    },
  );

  if (!runRes.ok) {
    throw new Error(
      `Apify actor run failed with status ${runRes.status}`,
    );
  }

  const runBody = await runRes.json();
  const datasetId = runBody?.data?.defaultDatasetId;
  if (!datasetId) {
    throw new Error('Apify run did not return a dataset id.');
  }

  const itemsRes = await fetch(
    `https://api.apify.com/v2/datasets/${encodeURIComponent(
      datasetId,
    )}/items?token=${encodeURIComponent(
      APIFY_TOKEN,
    )}&clean=true&format=json`,
  );

  if (!itemsRes.ok) {
    throw new Error(
      `Unable to fetch Apify dataset items (status ${itemsRes.status})`,
    );
  }

  const items = await itemsRes.json();
  if (!Array.isArray(items)) {
    throw new Error('Unexpected Apify dataset format.');
  }

  return items;
}

function summarisePricesFromApify(items, query) {
  const perChain = new Map();

  for (const item of items) {
    const chain = normalizeSupermarketName(item.supermarket);
    if (!chain) continue;

    const price = Number(item.price_eur);
    if (!Number.isFinite(price)) continue;

    const existing = perChain.get(chain);
    if (!existing || price < existing.price) {
      perChain.set(chain, {
        chain,
        productName: item.name || query,
        query,
        price,
        unitPrice: Number(item.unit_price_eur) || null,
        unit: item.unit || null,
        unitSize: item.unit_size || null,
        url: item.url || null,
      });
    }
  }

  return Array.from(perChain.values());
}

function buildNearbyResults(productSummaries, lat, lon, radiusKm) {
  const withStores = [];

  for (const summary of productSummaries) {
    const candidates = STORES.filter(
      (s) => s.chain === summary.chain,
    );
    if (!candidates.length) continue;

    let bestStore = null;
    let bestDistance = Infinity;
    for (const store of candidates) {
      const d = haversineKm(lat, lon, store.lat, store.lon);
      if (d < bestDistance) {
        bestDistance = d;
        bestStore = store;
      }
    }

    if (!bestStore) continue;

    withStores.push({
      chain: summary.chain,
      storeName: bestStore.storeName,
      address: bestStore.address,
      distanceKm: bestDistance,
      price: summary.price,
      unitPrice: summary.unitPrice,
      unit: summary.unit,
      unitSize: summary.unitSize,
      productName: summary.productName,
      url: summary.url,
    });
  }

  if (!withStores.length) return [];

  // Sort by price ascending, then distance.
  withStores.sort((a, b) => {
    if (a.price === b.price) {
      return a.distanceKm - b.distanceKm;
    }
    return a.price - b.price;
  });

  const withinRadius = withStores.filter(
    (r) => r.distanceKm <= radiusKm,
  );

  if (withinRadius.length >= 4) {
    return withinRadius.slice(0, 4);
  }

  const outsideRadius = withStores.filter(
    (r) => r.distanceKm > radiusKm,
  );
  const combined = withinRadius.concat(outsideRadius);
  return combined.slice(0, 4);
}

// Report an issue
app.post('/api/issues', (req, res) => {
  const { type, description, context, user_agent } = req.body || {};
  const t = (type || '').toString().trim();
  const d = (description || '').toString().trim();
  if (!t || !d) {
    return res.status(400).json({ error: 'type and description are required.' });
  }
  if (!db) {
    return res.status(503).json({ error: 'Issue reporting is temporarily unavailable.' });
  }
  try {
    const stmt = db.prepare(
      'INSERT INTO issues (type, description, context, user_agent) VALUES (?, ?, ?, ?)',
    );
    const info = stmt.run(t, d, (context || '').toString().trim(), (user_agent || '').toString().trim());
    res.status(201).json({ id: info.lastInsertRowid });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(err);
    res.status(500).json({ error: 'Failed to save report.' });
  }
});

// ----- Auth helpers -----
function getUserIdFromToken(token) {
  if (!db || !token) return null;
  try {
    const row = db.prepare(
      "SELECT user_id FROM sessions WHERE token = ? AND datetime(expires_at) > datetime('now')",
    ).get(sha256(token.trim()));
    return row ? row.user_id : null;
  } catch {
    return null;
  }
}

// Send magic code to email (uses SMTP if configured, else logs to console)
app.post('/api/auth/send-code', async (req, res) => {
  const email = (req.body && req.body.email || '').toString().trim().toLowerCase();
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'Valid email is required.' });
  }
  if (!db) return res.status(503).json({ error: 'Auth is temporarily unavailable.' });
  const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();
  try {
    db.prepare('DELETE FROM magic_codes WHERE email = ?').run(email);
    // Store hashed code — never persist the plaintext secret
    db.prepare('INSERT INTO magic_codes (email, code, expires_at) VALUES (?, ?, ?)').run(email, sha256(code), expiresAt);

    const subject = 'Your PrijsWijzer login code';
    const text = `Your verification code is: ${code}\n\nIt expires in 15 minutes. If you didn't request this, you can ignore this email.\n\n— PrijsWijzer`;
    const html = `<p>Your verification code is: <strong>${code}</strong></p><p>It expires in 15 minutes. If you didn't request this, you can ignore this email.</p><p>— PrijsWijzer</p>`;

    if (mailTransporter) {
      try {
        await mailTransporter.sendMail({
          from: MAIL_FROM,
          to: email,
          subject,
          text,
          html,
        });
        return res.json({ ok: true, message: 'Check your email for the code.' });
      } catch (mailErr) {
        // eslint-disable-next-line no-console
        console.error('[Auth] Send mail failed:', mailErr.message);
        return res.status(500).json({
          error: 'Could not send email. Check server SMTP settings or try again later.',
          devHint: process.env.NODE_ENV !== 'production' ? 'Code logged in server console.' : undefined,
        });
      }
    }

    // No SMTP configured: log code to server console for dev/testing
    // eslint-disable-next-line no-console
    console.log('[Auth] Magic code for', email, ':', code, '(configure SMTP in .env to send real emails)');
    res.json({
      ok: true,
      message: 'No email server configured. Code is in the server console. Add SMTP_* to .env to send emails.',
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(err);
    res.status(500).json({ error: 'Failed to send code.' });
  }
});

// Verify magic code and create session
app.post('/api/auth/verify', (req, res) => {
  const email = (req.body && req.body.email || '').toString().trim().toLowerCase();
  const code  = (req.body && req.body.code  || '').toString().trim();
  if (!email || !code) {
    return res.status(400).json({ error: 'Email and code are required.' });
  }
  if (!db) return res.status(503).json({ error: 'Auth is temporarily unavailable.' });
  try {
    // Compare against hashed code stored in DB
    const row = db.prepare(
      "SELECT id FROM magic_codes WHERE email = ? AND code = ? AND datetime(expires_at) > datetime('now')",
    ).get(email, sha256(code));
    if (!row) {
      return res.status(401).json({ error: 'Invalid or expired code.' });
    }
    db.prepare('DELETE FROM magic_codes WHERE email = ?').run(email);
    let user = db.prepare('SELECT id, email FROM users WHERE email = ?').get(email);
    if (!user) {
      db.prepare('INSERT INTO users (email) VALUES (?)').run(email);
      user = db.prepare('SELECT id, email FROM users WHERE email = ?').get(email);
    }
    // Generate raw token to return to client; store only its hash in DB
    const rawToken  = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
    db.prepare('INSERT INTO sessions (user_id, token, expires_at) VALUES (?, ?, ?)').run(user.id, sha256(rawToken), expiresAt);
    res.json({ token: rawToken, user: { id: user.id, email: user.email } });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(err);
    res.status(500).json({ error: 'Verification failed.' });
  }
});

// Log out — invalidate the session token
app.post('/api/auth/logout', (req, res) => {
  const auth = req.headers.authorization;
  const token = auth && auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (token && db) {
    try { db.prepare('DELETE FROM sessions WHERE token = ?').run(sha256(token.trim())); } catch (_) {}
  }
  res.json({ ok: true });
});

// Current user (requires Bearer token)
app.get('/api/me', (req, res) => {
  const auth = req.headers.authorization;
  const token = auth && auth.startsWith('Bearer ') ? auth.slice(7) : null;
  const userId = getUserIdFromToken(token);
  if (!userId || !db) {
    return res.status(401).json({ error: 'Not authenticated.' });
  }
  const user = db.prepare('SELECT id, email FROM users WHERE id = ?').get(userId);
  if (!user) return res.status(401).json({ error: 'Not authenticated.' });
  res.json({ user: { id: user.id, email: user.email } });
});

// Health check
app.get('/api/health', (_req, res) => {
  res.json({
    status: 'ok',
    message: 'Backend is running.',
    hasOpenCage: Boolean(OPENCAGE_API_KEY),
    hasApify: Boolean(APIFY_TOKEN),
  });
});

// Optional: debug geocoding endpoint
app.get('/api/geocode', async (req, res) => {
  try {
    const q = (req.query.q || '').toString().trim();
    if (!q) {
      return res
        .status(400)
        .json({ error: 'Query parameter q is required.' });
    }
    const coords = await geocodeLocation(q);
    res.json(coords);
  } catch (err) {
    res.status(500).json({ error: err.message || 'Geocoding failed.' });
  }
});

// Main comparison endpoint
// 5 free checks for anonymous users; unlimited when logged in (Bearer token).
// Frontend sends X-Anonymous-Checks when not logged in; backend rejects if >= 5.
app.get('/api/compare', (req, res, next) => {
  const auth = req.headers.authorization;
  const token = auth && auth.startsWith('Bearer ') ? auth.slice(7) : null;
  const userId = getUserIdFromToken(token);
  if (userId) return next();
  const count = parseInt(req.headers['x-anonymous-checks'], 10);
  if (Number.isFinite(count) && count >= 25) {
    return res.status(403).json({ error: 'Free limit reached. Please log in to continue.', code: 'FREE_LIMIT' });
  }
  next();
}, async (req, res) => {
  try {
    const query =
      (req.query.q || '').toString().trim().toLowerCase() ||
      'potato';
    const radiusKm = Number(req.query.radiusKm) || 5;

    let lat = Number(req.query.lat);
    let lon = Number(req.query.lon);

    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      const locationText = (req.query.location || '')
        .toString()
        .trim();
      if (!locationText) {
        return res.status(400).json({
          error:
            'Either lat/lon or location query parameter must be provided.',
        });
      }
      const coords = await geocodeLocation(locationText);
      lat = coords.lat;
      lon = coords.lon;
    }

    const items = await runApifyActor(query);
    const summaries = summarisePricesFromApify(items, query);
    if (!summaries.length) {
      return res.status(404).json({
        error:
          'No supermarket prices found for this product in the Apify dataset.',
      });
    }

    const results = buildNearbyResults(summaries, lat, lon, radiusKm);
    if (!results.length) {
      return res.status(404).json({
        error:
          'No nearby supermarkets with this product found within the selected radius.',
      });
    }

    res.json({ supermarkets: results });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(err);
    res.status(500).json({
      error:
        err.message ||
        'Unexpected error while fetching supermarket prices.',
    });
  }
});

app.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`Backend listening on http://localhost:${PORT}`);
});

