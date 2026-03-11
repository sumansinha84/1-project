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
const fs = require('fs');
const isVercel = Boolean(process.env.VERCEL);
const dataDir = isVercel ? require('os').tmpdir() : path.join(__dirname, 'data');
const dbPath = path.join(dataDir, 'app.db');
let db;
try {
  if (!isVercel) fs.mkdirSync(path.join(__dirname, 'data'), { recursive: true });
  db = new Database(dbPath);
  db.exec(`
    CREATE TABLE IF NOT EXISTS issues (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL,
      description TEXT NOT NULL,
      context TEXT,
      user_agent TEXT,
      attachment TEXT,
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
    CREATE TABLE IF NOT EXISTS activity_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      endpoint TEXT NOT NULL,
      method TEXT NOT NULL,
      status_code INTEGER,
      ip TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);
  try {
    db.exec(`ALTER TABLE users ADD COLUMN is_admin INTEGER DEFAULT 0`);
  } catch (_) {
    // Column may already exist
  }
  const adminEmail = 'sumansinha.nl@gmail.com';
  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(adminEmail);
  if (existing) {
    db.prepare('UPDATE users SET is_admin = 1 WHERE email = ?').run(adminEmail);
  } else {
    db.prepare('INSERT INTO users (email, is_admin) VALUES (?, 1)').run(adminEmail);
  }
} catch (err) {
  // eslint-disable-next-line no-console
  console.warn('SQLite init failed:', err.message, '- issue reporting will fail');
  db = null;
}
if (db) {
  try {
    db.exec('ALTER TABLE issues ADD COLUMN attachment TEXT');
  } catch (e) {
    // Column already exists
  }
}
app.use(cors());
app.use(express.json());
// Serve app at root (local dev; on Vercel, public/index.html is served for /)
if (!isVercel) {
  app.get('/', (_req, res) => {
    res.sendFile(path.join(__dirname, 'landing.html'));
  });
  app.use(express.static(path.join(__dirname)));
}

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

// ── Demo pricing ─────────────────────────────────────────────────────────────
// English → Dutch product name aliases (matches landing.html EN_TO_NL)
const EN_TO_NL_MAP = {
  potato:'aardappel', carrot:'wortel', cucumber:'komkommer',
  tomato:'tomaat', onion:'ui', broccoli:'broccoli', spinach:'spinazie',
  cauliflower:'bloemkool', mushroom:'champignon', garlic:'knoflook',
  apple:'appel', pear:'peer', banana:'banaan', orange:'sinaasappel',
  lemon:'citroen', lime:'limoen', strawberry:'aardbei', grape:'druif',
  mango:'mango', pineapple:'ananas', kiwi:'kiwi', watermelon:'watermeloen',
  peach:'perzik', milk:'melk', cheese:'kaas', eggs:'eieren', egg:'eieren',
  butter:'boter', yogurt:'yoghurt', cream:'slagroom',
  bread:'brood', rice:'rijst', pasta:'pasta', flour:'bloem',
  sugar:'suiker', salt:'zout', oil:'olie',
  chicken:'kipfilet', beef:'rundergehakt', ham:'ham', salmon:'zalm',
  tuna:'tonijn', coffee:'koffie', tea:'thee', juice:'sap',
  water:'water', beer:'bier', wine:'wijn',
  chips:'chips', chocolate:'chocolade', icecream:'ijs', fries:'friet',
};

// Base prices per Dutch product key (matches landing.html PRICES base values)
const DEMO_PRICES_BASE = {
  aardappel:{base:1.39,unit:'per kg'},      wortel:{base:0.99,unit:'per 500g'},
  komkommer:{base:0.69,unit:'per stuk'},    tomaat:{base:1.19,unit:'per 500g'},
  paprika:{base:0.79,unit:'per stuk'},      ui:{base:0.79,unit:'per kg'},
  broccoli:{base:0.99,unit:'per stuk'},     spinazie:{base:1.19,unit:'per 250g'},
  bloemkool:{base:1.29,unit:'per stuk'},    champignon:{base:1.49,unit:'per 500g'},
  knoflook:{base:0.59,unit:'per bol'},      courgette:{base:0.89,unit:'per stuk'},
  prei:{base:0.79,unit:'per stuk'},         pompoen:{base:1.49,unit:'per stuk'},
  appel:{base:0.35,unit:'per stuk'},        peer:{base:0.39,unit:'per stuk'},
  banaan:{base:0.22,unit:'per stuk'},       sinaasappel:{base:0.45,unit:'per stuk'},
  citroen:{base:0.35,unit:'per stuk'},      aardbei:{base:2.49,unit:'per 400g'},
  druif:{base:2.29,unit:'per 500g'},        mango:{base:0.99,unit:'per stuk'},
  ananas:{base:1.49,unit:'per stuk'},       kiwi:{base:0.39,unit:'per stuk'},
  watermeloen:{base:3.99,unit:'per stuk'},  perzik:{base:0.69,unit:'per stuk'},
  melk:{base:1.05,unit:'per liter'},        kaas:{base:2.39,unit:'per 500g'},
  eieren:{base:2.69,unit:'per 10 st'},      yoghurt:{base:0.79,unit:'per 500g'},
  boter:{base:2.19,unit:'per 250g'},        slagroom:{base:0.99,unit:'per 250ml'},
  karnemelk:{base:0.89,unit:'per liter'},   kwark:{base:1.19,unit:'per 500g'},
  brood:{base:1.79,unit:'per brood'},       beschuit:{base:1.29,unit:'per pak'},
  crackers:{base:1.49,unit:'per pak'},      croissant:{base:1.89,unit:'per 6 st'},
  kipfilet:{base:4.99,unit:'per 500g'},     kippendijen:{base:3.99,unit:'per kg'},
  gehakt:{base:3.49,unit:'per 500g'},       rundergehakt:{base:4.49,unit:'per 500g'},
  ham:{base:1.49,unit:'per 150g'},          spek:{base:1.89,unit:'per 150g'},
  worst:{base:1.69,unit:'per 250g'},        rookworst:{base:2.49,unit:'per 300g'},
  zalm:{base:3.99,unit:'per 200g'},         tonijn:{base:1.29,unit:'per blikje'},
  vissticks:{base:2.49,unit:'per 250g'},    garnalen:{base:3.49,unit:'per 150g'},
  koffie:{base:3.99,unit:'per 500g'},       thee:{base:1.79,unit:'per 40 st'},
  frisdrank:{base:0.99,unit:'per 1.5L'},    cola:{base:1.09,unit:'per 1.5L'},
  water:{base:0.49,unit:'per 1.5L'},        sap:{base:1.29,unit:'per liter'},
  appelsap:{base:1.29,unit:'per liter'},    bier:{base:1.09,unit:'per fles'},
  wijn:{base:4.99,unit:'per fles'},
  rijst:{base:1.79,unit:'per kg'},          pasta:{base:0.99,unit:'per 500g'},
  macaroni:{base:0.89,unit:'per 500g'},     bloem:{base:0.89,unit:'per kg'},
  suiker:{base:1.19,unit:'per kg'},         zout:{base:0.59,unit:'per 500g'},
  olie:{base:2.29,unit:'per liter'},        olijfolie:{base:3.99,unit:'per 500ml'},
  mayonaise:{base:1.79,unit:'per pot'},     ketchup:{base:1.29,unit:'per fles'},
  mosterd:{base:0.99,unit:'per pot'},       pindakaas:{base:2.29,unit:'per pot'},
  jam:{base:1.79,unit:'per pot'},           hagelslag:{base:1.49,unit:'per pak'},
  soep:{base:1.29,unit:'per pak'},
  chips:{base:1.49,unit:'per zak'},         koek:{base:1.49,unit:'per pak'},
  chocolade:{base:1.69,unit:'per reep'},    noten:{base:2.49,unit:'per 200g'},
  diepvriesgroenten:{base:1.29,unit:'per 450g'}, friet:{base:1.49,unit:'per kg'},
  pizza:{base:2.49,unit:'per stuk'},        ijs:{base:3.29,unit:'per 900ml'},
  shampoo:{base:2.99,unit:'per fles'},      tandpasta:{base:1.99,unit:'per tube'},
  zeep:{base:0.99,unit:'per stuk'},         douchegel:{base:1.99,unit:'per fles'},
  deodorant:{base:2.49,unit:'per stuk'},    wasmiddel:{base:6.99,unit:'per 25 beurt'},
  afwasmiddel:{base:1.49,unit:'per fles'},  wc_papier:{base:3.49,unit:'per 8 rol'},
};

// Per-chain price multipliers (matches landing.html CF)
const CHAIN_FACTORS = {
  'Albert Heijn': 1.00, 'Jumbo': 0.97, 'Lidl': 0.87, 'Aldi': 0.85,
  'Dirk': 0.88, 'Plus': 0.99, 'SPAR': 1.12, 'Hoogvliet': 0.95,
  'DekaMarkt': 0.97, 'Vomar': 0.92, 'Poiesz': 0.96,
};

// Local Dutch city/postcode geocoding — no external API needed
const CITY_COORDS_LOCAL = {
  amsterdam:    { lat: 52.3676, lon: 4.9041 },
  rotterdam:    { lat: 51.9225, lon: 4.4792 },
  utrecht:      { lat: 52.0907, lon: 5.1214 },
  'den haag':   { lat: 52.0705, lon: 4.3007 },
  'the hague':  { lat: 52.0705, lon: 4.3007 },
  'haag':       { lat: 52.0705, lon: 4.3007 },
  eindhoven:    { lat: 51.4416, lon: 5.4697 },
  tilburg:      { lat: 51.5555, lon: 5.0913 },
  groningen:    { lat: 53.2194, lon: 6.5665 },
  almere:       { lat: 52.3508, lon: 5.2647 },
  breda:        { lat: 51.5719, lon: 4.7683 },
  nijmegen:     { lat: 51.8426, lon: 5.8546 },
  haarlem:      { lat: 52.3874, lon: 4.6462 },
  enschede:     { lat: 52.2215, lon: 6.8937 },
  arnhem:       { lat: 51.9851, lon: 5.8987 },
  zaandam:      { lat: 52.4390, lon: 4.8313 },
  amersfoort:   { lat: 52.1561, lon: 5.3878 },
  apeldoorn:    { lat: 52.2112, lon: 5.9699 },
  dordrecht:    { lat: 51.8133, lon: 4.6901 },
  leiden:       { lat: 52.1601, lon: 4.4970 },
  maastricht:   { lat: 50.8514, lon: 5.6909 },
  delft:        { lat: 52.0116, lon: 4.3571 },
  alkmaar:      { lat: 52.6324, lon: 4.7534 },
  deventer:     { lat: 52.2552, lon: 6.1638 },
  leeuwarden:   { lat: 53.2012, lon: 5.7999 },
  zwolle:       { lat: 52.5168, lon: 6.0830 },
  zoetermeer:   { lat: 52.0705, lon: 4.4928 },
  helmond:      { lat: 51.4750, lon: 5.6558 },
  venlo:        { lat: 51.3704, lon: 6.1724 },
  hilversum:    { lat: 52.2292, lon: 5.1686 },
  assen:        { lat: 52.9925, lon: 6.5640 },
  middelburg:   { lat: 51.4988, lon: 3.6136 },
  lelystad:     { lat: 52.5185, lon: 5.4714 },
  emmen:        { lat: 52.7791, lon: 6.9009 },
  zaanstreek:   { lat: 52.4390, lon: 4.8313 },
  purmerend:    { lat: 52.5028, lon: 4.9572 },
  nieuwegein:   { lat: 52.0296, lon: 5.0786 },
  veenendaal:   { lat: 52.0261, lon: 5.5564 },
  sneek:        { lat: 53.0382, lon: 5.6600 },
};

function geocodeLocationLocal(query) {
  const q = (query || '').toLowerCase().replace(/[,]+/g, ' ').replace(/\s+/g, ' ').trim();
  // Try city/area name match
  const cityKey = Object.keys(CITY_COORDS_LOCAL).find(k => q.includes(k));
  if (cityKey) return CITY_COORDS_LOCAL[cityKey];
  // 4-digit Dutch postcode — return approximate centre of the Netherlands
  if (/\b[1-9][0-9]{3}\b/.test(q)) return { lat: 52.1326, lon: 5.2913 };
  return null;
}

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
  // Try local lookup first — no API key needed
  const local = geocodeLocationLocal(query);
  if (local) return local;

  if (!OPENCAGE_API_KEY) {
    throw new Error('Location not recognised. Try a Dutch city name (e.g. Amsterdam, Utrecht) or postcode.');
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
    if (runRes.status === 403) {
      throw new Error(
        'Apify access denied. Check that APIFY_TOKEN is valid and your Apify account has access to this actor (or sufficient credits).',
      );
    }
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

// Report an issue (optional attachment: base64 image string or data URL, max ~1.5MB)
const MAX_ATTACHMENT_LENGTH = 2000000;
app.post('/api/issues', (req, res) => {
  const { type, description, context, user_agent, attachment } = req.body || {};
  const t = (type || '').toString().trim();
  const d = (description || '').toString().trim();
  if (!t || !d) {
    return res.status(400).json({ error: 'type and description are required.' });
  }
  if (!db) {
    return res.status(503).json({ error: 'Issue reporting is temporarily unavailable.' });
  }
  let attachmentVal = null;
  if (attachment && typeof attachment === 'string') {
    const base64 = attachment.replace(/^data:image\/[a-z]+;base64,/, '').trim();
    if (base64.length > 0 && base64.length <= MAX_ATTACHMENT_LENGTH) {
      attachmentVal = 'data:image/png;base64,' + base64;
    }
  }
  try {
    const stmt = db.prepare(
      'INSERT INTO issues (type, description, context, user_agent, attachment) VALUES (?, ?, ?, ?, ?)',
    );
    const info = stmt.run(t, d, (context || '').toString().trim(), (user_agent || '').toString().trim(), attachmentVal);
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

function getAuthenticatedUser(token) {
  if (!db || !token) return null;
  try {
    const sessionRow = db.prepare(
      "SELECT user_id FROM sessions WHERE token = ? AND datetime(expires_at) > datetime('now')",
    ).get(sha256(token.trim()));
    if (!sessionRow) return null;
    const user = db.prepare('SELECT id, email, is_admin FROM users WHERE id = ?').get(sessionRow.user_id);
    return user || null;
  } catch {
    return null;
  }
}

function requireAdmin(req, res, next) {
  const auth = req.headers.authorization;
  const token = auth && auth.startsWith('Bearer ') ? auth.slice(7) : null;
  const user = getAuthenticatedUser(token);
  if (!user) return res.status(401).json({ error: 'Not authenticated.' });
  if (user.is_admin !== 1) return res.status(403).json({ error: 'Admin access required.' });
  req.adminUser = user;
  next();
}

function requestLogger(req, res, next) {
  if (req.path === '/api/health') return next();
  const start = Date.now();
  res.on('finish', () => {
    if (!db) return;
    try {
      const auth = req.headers.authorization;
      const token = auth && auth.startsWith('Bearer ') ? auth.slice(7) : null;
      const userId = getUserIdFromToken(token);
      const ip = req.ip || req.socket?.remoteAddress || null;
      db.prepare(
        'INSERT INTO activity_log (user_id, endpoint, method, status_code, ip) VALUES (?, ?, ?, ?, ?)',
      ).run(
        userId ?? null,
        req.originalUrl || req.path,
        req.method,
        res.statusCode,
        ip,
      );
    } catch (_) {}
  });
  next();
}
app.use('/api', requestLogger);

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
        if (process.env.NODE_ENV !== 'production') {
          // Development fallback: log code to console so login still works when SMTP is misconfigured
          // eslint-disable-next-line no-console
          console.log('[Auth] Magic code for', email, ':', code, '(SMTP failed — use this code to log in)');
          return res.json({
            ok: true,
            message: 'SMTP failed. Check the server terminal for your one-time code and enter it below.',
          });
        }
        return res.status(500).json({
          error: 'Could not send email. Check server SMTP settings or try again later.',
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
  const user = db.prepare('SELECT id, email, is_admin FROM users WHERE id = ?').get(userId);
  if (!user) return res.status(401).json({ error: 'Not authenticated.' });
  res.json({
    user: {
      id: user.id,
      email: user.email,
      is_admin: user.is_admin === 1,
    },
  });
});

// ----- Admin API (all require admin) -----
app.get('/api/admin/users', requireAdmin, (req, res) => {
  if (!db) return res.status(503).json({ error: 'Service unavailable.' });
  try {
    const users = db.prepare(`
      SELECT u.id, u.email, u.created_at,
        (SELECT COUNT(*) FROM sessions s WHERE s.user_id = u.id AND datetime(s.expires_at) > datetime('now')) AS session_count,
        (SELECT MIN(s.expires_at) FROM sessions s WHERE s.user_id = u.id) AS first_seen,
        (SELECT MAX(s.expires_at) FROM sessions s WHERE s.user_id = u.id) AS last_seen
      FROM users u
      ORDER BY u.created_at DESC
    `).all();
    const now = new Date().toISOString().slice(0, 10);
    const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const monthAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const total = users.length;
    const today = users.filter((u) => (u.created_at || '').toString().slice(0, 10) === now).length;
    const thisWeek = users.filter((u) => (u.created_at || '').toString().slice(0, 10) >= weekAgo).length;
    const thisMonth = users.filter((u) => (u.created_at || '').toString().slice(0, 10) >= monthAgo).length;
    res.json({
      total,
      today,
      thisWeek,
      thisMonth,
      users: users.map((u) => ({
        id: u.id,
        email: u.email,
        created_at: u.created_at,
        session_count: u.session_count || 0,
        first_seen: u.first_seen || null,
        last_seen: u.last_seen || null,
      })),
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch users.' });
  }
});

app.get('/api/admin/usage', requireAdmin, (req, res) => {
  if (!db) return res.status(503).json({ error: 'Service unavailable.' });
  try {
    const totalRequests = db.prepare('SELECT COUNT(*) AS n FROM activity_log').get().n;
    const todayStart = new Date().toISOString().slice(0, 10) + 'T00:00:00.000Z';
    const requestsToday = db.prepare(
      "SELECT COUNT(*) AS n FROM activity_log WHERE created_at >= ?",
    ).get(todayStart).n;
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const activeUsersLast7 = db.prepare(
      "SELECT COUNT(DISTINCT user_id) AS n FROM activity_log WHERE created_at >= ? AND user_id IS NOT NULL",
    ).get(sevenDaysAgo).n;
    const byDay = db.prepare(`
      SELECT date(created_at) AS day, COUNT(*) AS count
      FROM activity_log
      WHERE created_at >= date('now', '-14 days')
      GROUP BY date(created_at)
      ORDER BY day ASC
    `).all();
    const topEndpoints = db.prepare(`
      SELECT endpoint, method, COUNT(*) AS count
      FROM activity_log
      GROUP BY endpoint, method
      ORDER BY count DESC
      LIMIT 5
    `).all();
    const userSpans = db.prepare(`
      SELECT user_id, MIN(created_at) AS first_at, MAX(created_at) AS last_at
      FROM activity_log
      WHERE user_id IS NOT NULL
      GROUP BY user_id
    `).all();
    let avgSessionMinutes = 0;
    if (userSpans.length > 0) {
      let totalMs = 0;
      for (const row of userSpans) {
        const first = new Date(row.first_at).getTime();
        const last = new Date(row.last_at).getTime();
        if (Number.isFinite(first) && Number.isFinite(last) && last >= first) {
          totalMs += (last - first) / (60 * 1000);
        }
      }
      avgSessionMinutes = Math.round(totalMs / userSpans.length);
    }
    res.json({
      totalRequests,
      requestsToday,
      activeUsersLast7,
      byDay,
      topEndpoints,
      avgSessionMinutes: Math.round(avgSessionMinutes),
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch usage.' });
  }
});

app.get('/api/admin/reports/registrations', requireAdmin, (req, res) => {
  if (!db) return res.status(503).json({ error: 'Service unavailable.' });
  try {
    const from = (req.query.from || '').toString().slice(0, 10) || new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const to = (req.query.to || '').toString().slice(0, 10) || new Date().toISOString().slice(0, 10);
    const rows = db.prepare(`
      SELECT date(created_at) AS registration_date, COUNT(*) AS count
      FROM users
      WHERE date(created_at) >= ? AND date(created_at) <= ?
      GROUP BY date(created_at)
      ORDER BY registration_date DESC
    `).all(from, to);
    res.json({ from, to, byDate: rows });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch report.' });
  }
});

app.get('/api/admin/reports/registrations/:date', requireAdmin, (req, res) => {
  if (!db) return res.status(503).json({ error: 'Service unavailable.' });
  const date = (req.params.date || '').toString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: 'Invalid date format (use YYYY-MM-DD).' });
  }
  try {
    const users = db.prepare(`
      SELECT id, email, created_at
      FROM users
      WHERE date(created_at) = ?
      ORDER BY created_at ASC
    `).all(date);
    res.json({ date, users });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch users for date.' });
  }
});

app.get('/api/admin/issues', requireAdmin, (req, res) => {
  if (!db) return res.status(503).json({ error: 'Service unavailable.' });
  try {
    const typeFilter = (req.query.type || '').toString().trim().toLowerCase();
    let rows = db.prepare(
      `SELECT id, type, description, context, user_agent, created_at,
       (CASE WHEN attachment IS NOT NULL AND length(attachment) > 0 THEN 1 ELSE 0 END) as has_attachment
       FROM issues ORDER BY created_at DESC`,
    ).all();
    if (typeFilter) {
      rows = rows.filter((r) => (r.type || '').toLowerCase() === typeFilter);
    }
    res.json({ issues: rows });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch issues.' });
  }
});

app.get('/api/admin/issues/:id/attachment', requireAdmin, (req, res) => {
  if (!db) return res.status(503).end();
  try {
    const id = parseInt(req.params.id, 10);
    const row = db.prepare('SELECT attachment FROM issues WHERE id = ?').get(id);
    if (!row || !row.attachment) return res.status(404).end();
    const dataUrl = row.attachment;
    const match = dataUrl.match(/^data:(image\/[a-z]+);base64,(.+)$/);
    if (!match) return res.status(400).end();
    const contentType = match[1];
    const buf = Buffer.from(match[2], 'base64');
    res.setHeader('Content-Type', contentType);
    res.send(buf);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(err);
    res.status(500).end();
  }
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
      'aardappel';
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

    // Use demo pricing: resolve English alias → Dutch key, look up base price
    const nlKey = EN_TO_NL_MAP[query] || query;
    const priceInfo = DEMO_PRICES_BASE[nlKey] || DEMO_PRICES_BASE['aardappel'];

    // Build one price summary per chain using per-chain price factors
    const summaries = Object.entries(CHAIN_FACTORS).map(([chain, factor]) => ({
      chain,
      productName: nlKey,
      query: nlKey,
      price: Math.round(priceInfo.base * factor * 100) / 100,
      unitPrice: null,
      unit: priceInfo.unit,
      unitSize: null,
      url: null,
    }));

    const results = buildNearbyResults(summaries, lat, lon, radiusKm);
    if (!results.length) {
      return res.status(404).json({
        error:
          'No nearby supermarkets found within the selected radius. Try a larger radius.',
      });
    }

    res.json({ supermarkets: results });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(err);
    res.status(500).json({ error: err.message || 'Unexpected error while fetching supermarket prices.' });
  }
});

if (!isVercel) {
  app.listen(PORT, () => {
    // eslint-disable-next-line no-console
    console.log(`Backend listening on http://localhost:${PORT}`);
  });
}

module.exports = app;

