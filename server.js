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
// Serve static files from public/ in all environments.
// On Vercel all requests are routed through this Express app,
// so it must handle static assets itself.
app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

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
// Comprehensive store list — 176+ locations across the Netherlands.
// Matches landing.html STORES exactly so /api/compare returns the same
// nearby stores as the frontend demo fallback.
const STORES = [
  // ── AMSTERDAM ────────────────────────────────────────────────────────────────
  // Centrum
  { chain:'Albert Heijn', name:'AH · Amsterdam Centrum (Dam)',     address:'Nieuwezijds Voorburgwal 226, Amsterdam', lat:52.374, lon:4.893 },
  { chain:'Albert Heijn', name:'AH · Amsterdam Centrum (Leidse)', address:'Leidsestraat 56, Amsterdam',            lat:52.364, lon:4.882 },
  { chain:'Jumbo',        name:'Jumbo · Amsterdam Centrum',        address:'Koningsplein 10, Amsterdam',            lat:52.366, lon:4.887 },
  { chain:'Dirk',         name:'Dirk · Amsterdam Centrum',         address:'Bilderdijkstraat 82, Amsterdam',        lat:52.370, lon:4.871 },
  { chain:'SPAR',         name:'SPAR · Amsterdam Jordaan',         address:'Elandsgracht 62, Amsterdam',            lat:52.373, lon:4.882 },
  // West
  { chain:'Albert Heijn', name:'AH · Amsterdam West (Kinkerstraat)',address:'Kinkerstraat 133, Amsterdam',          lat:52.368, lon:4.864 },
  { chain:'Albert Heijn', name:'AH · Amsterdam Geuzenveld',        address:'Slotermeerlaan 103, Amsterdam',         lat:52.376, lon:4.820 },
  { chain:'Albert Heijn', name:'AH · Amsterdam Osdorp',            address:'Osdorpplein 74, Amsterdam',             lat:52.361, lon:4.806 },
  { chain:'Jumbo',        name:'Jumbo · Amsterdam Sloterdijk',     address:'Haarlemmerweg 505, Amsterdam',          lat:52.388, lon:4.843 },
  { chain:'Lidl',         name:'Lidl · Amsterdam West (Mercator)', address:'Postjesweg 47, Amsterdam',              lat:52.365, lon:4.859 },
  { chain:'Lidl',         name:'Lidl · Amsterdam Nieuw-West',      address:'Osdorpplein 172, Amsterdam',            lat:52.358, lon:4.804 },
  { chain:'Aldi',         name:'Aldi · Amsterdam Slotervaart',     address:'Johan Huizingalaan 111, Amsterdam',     lat:52.355, lon:4.830 },
  { chain:'Aldi',         name:'Aldi · Amsterdam Geuzenveld',      address:'Ookmeerweg 30, Amsterdam',              lat:52.379, lon:4.813 },
  { chain:'Plus',         name:'Plus · Amsterdam West (Mercator)', address:'Mercatorplein 85, Amsterdam',           lat:52.368, lon:4.853 },
  { chain:'Dirk',         name:'Dirk · Amsterdam West (Jordaan)',  address:'Rozengracht 174, Amsterdam',            lat:52.372, lon:4.875 },
  // Zuid / Oud-Zuid / Buitenveldert
  { chain:'Albert Heijn', name:'AH · Amsterdam Oud-Zuid',          address:'Van Baerlestraat 33, Amsterdam',        lat:52.356, lon:4.873 },
  { chain:'Albert Heijn', name:'AH · Amsterdam Buitenveldert',     address:'Gelderlandplein 87, Amsterdam',         lat:52.330, lon:4.872 },
  { chain:'Albert Heijn', name:'AH · Amsterdam De Pijp',           address:'Ceintuurbaan 241, Amsterdam',           lat:52.351, lon:4.898 },
  { chain:'Jumbo',        name:'Jumbo · Amsterdam Rivierenbuurt',  address:'Daalwijkdreef 29, Amsterdam',           lat:52.335, lon:4.905 },
  { chain:'Lidl',         name:'Lidl · Amsterdam Zuid',            address:'Parnassusweg 4, Amsterdam',             lat:52.340, lon:4.875 },
  { chain:'Aldi',         name:'Aldi · Amsterdam Buitenveldert',   address:'Amsteldijk 165, Amsterdam',             lat:52.335, lon:4.885 },
  { chain:'Dirk',         name:'Dirk · Amsterdam De Pijp',         address:'Ferdinand Bolstraat 116, Amsterdam',    lat:52.351, lon:4.895 },
  // Oost / Watergraafsmeer
  { chain:'Albert Heijn', name:'AH · Amsterdam Watergraafsmeer',   address:'Middenweg 2, Amsterdam',                lat:52.352, lon:4.937 },
  { chain:'Albert Heijn', name:'AH · Amsterdam Indische Buurt',    address:'Insulindeweg 145, Amsterdam',           lat:52.359, lon:4.945 },
  { chain:'Albert Heijn', name:'AH · Amsterdam IJburg',            address:'Haringbuisdijk 7, Amsterdam',           lat:52.353, lon:5.003 },
  { chain:'Jumbo',        name:'Jumbo · Amsterdam Oost',           address:'Middenweg 55, Amsterdam',               lat:52.350, lon:4.940 },
  { chain:'Lidl',         name:'Lidl · Amsterdam Oost',            address:'Molukkenstraat 200, Amsterdam',         lat:52.360, lon:4.930 },
  { chain:'Aldi',         name:'Aldi · Amsterdam Oost',            address:'Zeeburgerdijk 110, Amsterdam',          lat:52.362, lon:4.944 },
  { chain:'Dirk',         name:'Dirk · Amsterdam Oost',            address:'Linnaeusstraat 56, Amsterdam',          lat:52.358, lon:4.929 },
  // Noord
  { chain:'Albert Heijn', name:'AH · Amsterdam Noord (NDSM)',      address:'Buikslotermeerplein 1, Amsterdam',      lat:52.407, lon:4.940 },
  { chain:'Albert Heijn', name:'AH · Amsterdam Noord (Volendam)',  address:'Volendammerweg 130, Amsterdam',         lat:52.393, lon:4.982 },
  { chain:'Jumbo',        name:'Jumbo · Amsterdam Noord',          address:'Purmerplein 13, Amsterdam',             lat:52.397, lon:4.947 },
  { chain:'Lidl',         name:'Lidl · Amsterdam Noord',           address:'Mosveld 40, Amsterdam',                 lat:52.392, lon:4.938 },
  { chain:'Aldi',         name:'Aldi · Amsterdam Noord',           address:'Purmerweg 48, Amsterdam',               lat:52.406, lon:4.930 },
  { chain:'Dirk',         name:'Dirk · Amsterdam Noord',           address:'Meeuwenlaan 123, Amsterdam',            lat:52.400, lon:4.920 },
  { chain:'Plus',         name:'Plus · Amsterdam Noord',           address:'Nieuwendammerdijk 30, Amsterdam',       lat:52.405, lon:4.960 },
  // Zuidoost / Bijlmer
  { chain:'Albert Heijn', name:'AH · Amsterdam Bijlmer',           address:'Amsterdamse Poort 161, Amsterdam',      lat:52.316, lon:4.963 },
  { chain:'Albert Heijn', name:'AH · Amsterdam Gaasperdam',        address:'Gaasperdammerweg 30, Amsterdam',        lat:52.305, lon:4.992 },
  { chain:'Jumbo',        name:'Jumbo · Amsterdam Bijlmer',        address:'Karspeldreef 8, Amsterdam',             lat:52.311, lon:4.970 },
  { chain:'Lidl',         name:'Lidl · Amsterdam Bijlmer',         address:'Hoekenrode 24, Amsterdam',              lat:52.314, lon:4.965 },
  { chain:'Aldi',         name:'Aldi · Amsterdam Zuidoost',        address:'Anton de Komplein 70, Amsterdam',       lat:52.309, lon:4.979 },
  { chain:'Dirk',         name:'Dirk · Amsterdam Bijlmer',         address:'Bijlmerdreef 1289, Amsterdam',          lat:52.316, lon:4.968 },
  // Amstelveen & Diemen
  { chain:'Albert Heijn', name:'AH · Amstelveen Stadshart',        address:'Stadshart 36, Amstelveen',              lat:52.308, lon:4.874 },
  { chain:'Albert Heijn', name:'AH · Amstelveen Binnenhof',        address:'Binnenhof 65, Amstelveen',              lat:52.296, lon:4.854 },
  { chain:'Jumbo',        name:'Jumbo · Amstelveen',               address:'Koenenkade 5, Amstelveen',              lat:52.296, lon:4.873 },
  { chain:'Lidl',         name:'Lidl · Amstelveen',                address:'Bovenkerkerweg 2, Amstelveen',          lat:52.284, lon:4.861 },
  { chain:'Aldi',         name:'Aldi · Amstelveen',                address:'Uilenstede 60, Amstelveen',             lat:52.302, lon:4.866 },
  { chain:'Albert Heijn', name:'AH · Diemen',                      address:'Diemerhof 26, Diemen',                  lat:52.337, lon:4.975 },
  { chain:'Jumbo',        name:'Jumbo · Diemen',                   address:'Bergwijkpark 20, Diemen',               lat:52.335, lon:4.979 },
  { chain:'Lidl',         name:'Lidl · Diemen',                    address:'Veluweweg 10, Diemen',                  lat:52.331, lon:4.973 },
  // Dirk Amsterdam extra
  { chain:'Dirk',         name:'Dirk · Amsterdam Slotermeer',      address:'Slotermeerlaan 100, Amsterdam',          lat:52.373, lon:4.830 },
  // ── UTRECHT STAD ─────────────────────────────────────────────────────────────
  { chain:'Albert Heijn', name:'AH · Utrecht Centrum (Viestraat)', address:'Lange Viestraat 2, Utrecht',            lat:52.090, lon:5.120 },
  { chain:'Albert Heijn', name:'AH · Utrecht Centrum (Hoog Catharijne)',address:'Stationsplein 10, Utrecht',         lat:52.090, lon:5.111 },
  { chain:'Albert Heijn', name:'AH · Utrecht Wittevrouwen',        address:'Wittevrouwensingel 50, Utrecht',        lat:52.097, lon:5.127 },
  { chain:'Albert Heijn', name:'AH · Utrecht Tuindorp',            address:'Amsterdamsestraatweg 60, Utrecht',      lat:52.107, lon:5.131 },
  { chain:'Albert Heijn', name:'AH · Utrecht Lombok / Oog-in-Al', address:'Kanaalstraat 6, Utrecht',               lat:52.083, lon:5.094 },
  { chain:'Albert Heijn', name:'AH · Utrecht Kanaleneiland',       address:'Siriusdreef 100, Utrecht',              lat:52.072, lon:5.098 },
  { chain:'Albert Heijn', name:'AH · Utrecht Overvecht',           address:'Zambesidreef 125, Utrecht',             lat:52.119, lon:5.110 },
  { chain:'Albert Heijn', name:'AH · Utrecht Hoograven',           address:'Maarsbergenstraat 2, Utrecht',          lat:52.078, lon:5.132 },
  { chain:'Albert Heijn', name:'AH · Utrecht Lunetten',            address:'Astronomielaan 6, Utrecht',             lat:52.065, lon:5.142 },
  { chain:'Jumbo',        name:'Jumbo · Utrecht Overvecht',        address:'Zambesidreef 27, Utrecht',              lat:52.120, lon:5.110 },
  { chain:'Jumbo',        name:'Jumbo · Utrecht Lunetten',         address:'Plutostraat 1, Utrecht',                lat:52.064, lon:5.131 },
  { chain:'Jumbo',        name:'Jumbo · Utrecht Centrum',          address:'Steenweg 25, Utrecht',                  lat:52.092, lon:5.118 },
  { chain:'Jumbo',        name:'Jumbo · Utrecht Zuilen',           address:'Amsterdamsestraatweg 556, Utrecht',     lat:52.107, lon:5.083 },
  { chain:'Lidl',         name:'Lidl · Utrecht Kanaleneiland',     address:'Merwedekanaalzone 50, Utrecht',         lat:52.075, lon:5.100 },
  { chain:'Lidl',         name:'Lidl · Utrecht Zuilen',            address:'Amsterdamsestraatweg 600, Utrecht',     lat:52.107, lon:5.083 },
  { chain:'Lidl',         name:'Lidl · Utrecht Overvecht',         address:'Franciscusdreef 225, Utrecht',          lat:52.122, lon:5.104 },
  { chain:'Lidl',         name:'Lidl · Utrecht Lunetten',          address:'Marsstraat 15, Utrecht',                lat:52.062, lon:5.136 },
  { chain:'Aldi',         name:'Aldi · Utrecht Overvecht',         address:'Nedereindseweg 200, Utrecht',           lat:52.118, lon:5.107 },
  { chain:'Aldi',         name:'Aldi · Utrecht Kanaleneiland',     address:'Lessinglaan 10, Utrecht',               lat:52.073, lon:5.095 },
  { chain:'Aldi',         name:'Aldi · Utrecht Hoograven',         address:'Oprechtstraat 40, Utrecht',             lat:52.076, lon:5.128 },
  { chain:'Plus',         name:'Plus · Utrecht Centrum',           address:'Oudegracht 195, Utrecht',               lat:52.091, lon:5.116 },
  { chain:'DekaMarkt',    name:'DekaMarkt · Utrecht Lunetten',     address:'Asterstraat 3, Utrecht',                lat:52.064, lon:5.140 },
  { chain:'SPAR',         name:'SPAR · Utrecht Science Park',      address:'Heidelberglaan 15, Utrecht',            lat:52.086, lon:5.176 },
  // Dirk Utrecht – all locations
  { chain:'Dirk',         name:'Dirk · Utrecht Leidsche Rijn (Vasco Da Gamalaan)', address:'Vasco Da Gamalaan 1-5, Utrecht', lat:52.082, lon:5.052 },
  { chain:'Dirk',         name:'Dirk · Utrecht Hoograven',         address:'Gildstraat 60, Utrecht',                lat:52.077, lon:5.132 },
  { chain:'Dirk',         name:'Dirk · Utrecht Nieuw Hoograven',   address:'Hindersteinlaan 2, Utrecht',            lat:52.063, lon:5.134 },
  { chain:'Dirk',         name:'Dirk · Utrecht Voordorp',          address:'Roelanddreef 265, Utrecht',             lat:52.115, lon:5.098 },
  { chain:'Dirk',         name:'Dirk · Utrecht Kanaleneiland',     address:'Kanaalweg 50, Utrecht',                 lat:52.072, lon:5.093 },
  { chain:'Dirk',         name:'Dirk · Utrecht Overvecht',         address:'Zambesidreef 100, Utrecht',             lat:52.121, lon:5.107 },
  { chain:'Dirk',         name:'Dirk · Nieuwegein',                address:'Nedereindseweg 2, Nieuwegein',           lat:52.033, lon:5.088 },
  { chain:'Dirk',         name:'Dirk · Maarssen',                  address:'Enghweg 2, Maarssen',                   lat:52.130, lon:5.041 },
  // Hoogvliet Utrecht city stores
  { chain:'Hoogvliet',    name:'Hoogvliet · Utrecht Steenovenweg',  address:'Steenovenweg 2, Utrecht',               lat:52.103, lon:5.042 },
  { chain:'Hoogvliet',    name:'Hoogvliet · Utrecht Hondsrug',      address:'Hondsrug 18, Utrecht',                  lat:52.102, lon:5.131 },
  // ── UTRECHT WEST – Leidsche Rijn / De Meern / Vleuten ────────────────────────
  // Leidsche Rijn Centrum
  { chain:'Albert Heijn', name:'AH · Leidsche Rijn Centrum',       address:'Leidsche Rijn Centrum 100, Utrecht',    lat:52.0755, lon:5.0422 },
  { chain:'Jumbo',        name:'Jumbo · Leidsche Rijn Centrum',    address:'Leidsche Rijn Centrum 50, Utrecht',     lat:52.0762, lon:5.0435 },
  // Terwijde (Ella Fitzgeraldplein)
  { chain:'Albert Heijn', name:'AH · Terwijde (Ella Fitzgeraldplein)', address:'Ella Fitzgeraldplein 6, 3543 EP Utrecht', lat:52.0902, lon:5.0315 },
  { chain:'Lidl',         name:'Lidl · Terwijde',                  address:'Hoge Woerd 50, Utrecht',                lat:52.0842, lon:5.0437 },
  { chain:'Aldi',         name:'Aldi · Terwijde',                  address:'Terwijde 12, Utrecht',                  lat:52.0848, lon:5.0445 },
  { chain:'Plus',         name:'Plus · Leidsche Rijn',             address:'Vleutensewetering 200, Utrecht',        lat:52.079,  lon:5.040  },
  // De Meern – Mereveldplein (primary shopping area for postcode 3454)
  { chain:'Albert Heijn', name:'AH · De Meern (Mereveldplein)',    address:'Mereveldplein 21, De Meern',            lat:52.0748, lon:5.0268 },
  { chain:'Aldi',         name:'Aldi · De Meern',                  address:'Parkdreef 2, De Meern',                 lat:52.0731, lon:5.0244 },
  { chain:'Jumbo',        name:'Jumbo · De Meern',                 address:'Rijnenburgselaan 20, De Meern',         lat:52.077,  lon:5.027  },
  { chain:'DekaMarkt',    name:'DekaMarkt · De Meern',             address:'Dorpsstraat 80, De Meern',              lat:52.073,  lon:5.022  },
  // Vleuten
  { chain:'Albert Heijn', name:'AH · Vleuten',                     address:'Vleutensewetering 2, Vleuten',          lat:52.1009, lon:5.0137 },
  { chain:'Lidl',         name:'Lidl · Vleuten',                   address:'Kampdwarsweg 5, Vleuten',               lat:52.101,  lon:5.013  },
  { chain:'Plus',         name:'Plus · Vleuten',                   address:'Dorpsstraat 45, Vleuten',               lat:52.100,  lon:5.009  },
  { chain:'DekaMarkt',    name:'DekaMarkt · Vleuten',              address:'Verlengde Vleutenseweg 65, Vleuten',    lat:52.097,  lon:5.003  },
  { chain:'Jumbo',        name:'Jumbo · Vleuten',                  address:'Hindersteyn 10, Vleuten',               lat:52.104,  lon:5.016  },
  // ── UTRECHT SURROUNDINGS ─────────────────────────────────────────────────────
  // Nieuwegein
  { chain:'Albert Heijn', name:'AH · Nieuwegein Stadscentrum',     address:'City Plaza 1, Nieuwegein',              lat:52.034, lon:5.083 },
  { chain:'Albert Heijn', name:'AH · Nieuwegein Galecop',          address:'Gaslaan 1, Nieuwegein',                 lat:52.021, lon:5.090 },
  { chain:'Jumbo',        name:'Jumbo · Nieuwegein',               address:'Koningin Julianaplein 10, Nieuwegein',  lat:52.031, lon:5.086 },
  { chain:'Lidl',         name:'Lidl · Nieuwegein',                address:'Blokhoeve 1, Nieuwegein',               lat:52.026, lon:5.094 },
  { chain:'Aldi',         name:'Aldi · Nieuwegein',                address:'Wattbaan 15, Nieuwegein',               lat:52.028, lon:5.089 },
  { chain:'Plus',         name:'Plus · Nieuwegein',                address:'Batau-Noord 40, Nieuwegein',            lat:52.036, lon:5.079 },
  { chain:'Hoogvliet',    name:'Hoogvliet · Nieuwegein',           address:'Computerweg 4, Nieuwegein',             lat:52.032, lon:5.082 },
  // Houten
  { chain:'Albert Heijn', name:'AH · Houten Centrum',              address:'Rond de Linden 14, Houten',             lat:52.027, lon:5.168 },
  { chain:'Jumbo',        name:'Jumbo · Houten',                   address:'Koppeling 26, Houten',                  lat:52.025, lon:5.172 },
  { chain:'Lidl',         name:'Lidl · Houten',                    address:'Molenzoom 29, Houten',                  lat:52.023, lon:5.175 },
  { chain:'Aldi',         name:'Aldi · Houten',                    address:'Randhoeve 10, Houten',                  lat:52.021, lon:5.178 },
  // Zeist
  { chain:'Albert Heijn', name:'AH · Zeist Centrum',               address:'Slotlaan 80, Zeist',                    lat:52.091, lon:5.227 },
  { chain:'Jumbo',        name:'Jumbo · Zeist',                    address:'Driebergseweg 24, Zeist',               lat:52.089, lon:5.232 },
  { chain:'Lidl',         name:'Lidl · Zeist',                     address:'Vollenhove 2, Zeist',                   lat:52.086, lon:5.224 },
  { chain:'Aldi',         name:'Aldi · Zeist',                     address:'Utrechtseweg 40, Zeist',                lat:52.094, lon:5.234 },
  // Maarssen
  { chain:'Albert Heijn', name:'AH · Maarssen',                    address:'Thamerkade 2, Maarssen',                lat:52.134, lon:5.044 },
  { chain:'Jumbo',        name:'Jumbo · Maarssen',                 address:'Maarsskade 10, Maarssen',               lat:52.131, lon:5.048 },
  { chain:'Lidl',         name:'Lidl · Maarssen',                  address:'Leidsevaart 4, Maarssen',               lat:52.128, lon:5.052 },
  { chain:'Hoogvliet',    name:'Hoogvliet · Maarssen',             address:'Maarssenbroeksedijk 20, Maarssen',      lat:52.128, lon:5.030 },
  // IJsselstein
  { chain:'Albert Heijn', name:'AH · IJsselstein',                  address:'Overtoom 2, IJsselstein',               lat:52.017, lon:5.031 },
  { chain:'Jumbo',        name:'Jumbo · IJsselstein',               address:'Zenderpark 8, IJsselstein',             lat:52.014, lon:5.028 },
  { chain:'Lidl',         name:'Lidl · IJsselstein',                address:'Evenaar 4, IJsselstein',                lat:52.012, lon:5.025 },
  // Woerden
  { chain:'Albert Heijn', name:'AH · Woerden',                     address:'Vlasmarkt 40, Woerden',                 lat:52.088, lon:4.889 },
  { chain:'Jumbo',        name:'Jumbo · Woerden',                  address:'Koperslager 2, Woerden',                lat:52.086, lon:4.893 },
  { chain:'Lidl',         name:'Lidl · Woerden',                   address:'Breeveld 30, Woerden',                  lat:52.083, lon:4.897 },
  { chain:'Aldi',         name:'Aldi · Woerden',                   address:'Burg. Grothestraat 4, Woerden',         lat:52.090, lon:4.885 },
  { chain:'Hoogvliet',    name:'Hoogvliet · Woerden Boomstede',    address:'Boomstede 211, Woerden',                lat:52.090, lon:4.878 },
  // ── ROTTERDAM ────────────────────────────────────────────────────────────────
  { chain:'Albert Heijn', name:'AH · Rotterdam Centrum',           address:'Coolsingel 42, Rotterdam',              lat:51.920, lon:4.480 },
  { chain:'Albert Heijn', name:'AH · Rotterdam Alexander',         address:'Alexandrium 2, Rotterdam',              lat:51.960, lon:4.560 },
  { chain:'Albert Heijn', name:'AH · Rotterdam Hillegersberg',     address:'Straatweg 52, Rotterdam',               lat:51.946, lon:4.510 },
  { chain:'Jumbo',        name:'Jumbo · Rotterdam Noord',          address:'Bergweg 150, Rotterdam',                lat:51.940, lon:4.470 },
  { chain:'Jumbo',        name:'Jumbo · Rotterdam Kralingen',      address:'Hoofdweg 10, Rotterdam',                lat:51.930, lon:4.510 },
  { chain:'Jumbo',        name:'Jumbo · Rotterdam Pendrecht',      address:'Slinge 201, Rotterdam',                 lat:51.882, lon:4.489 },
  { chain:'Lidl',         name:'Lidl · Rotterdam Zuid',            address:'Brielselaan 85, Rotterdam',             lat:51.890, lon:4.480 },
  { chain:'Lidl',         name:'Lidl · Rotterdam Spangen',         address:'Pieter de Hoochweg 100, Rotterdam',     lat:51.926, lon:4.448 },
  { chain:'Aldi',         name:'Aldi · Rotterdam Alexandrium',     address:'Prins Alexanderlaan 35, Rotterdam',     lat:51.960, lon:4.560 },
  { chain:'Aldi',         name:'Aldi · Rotterdam Beverwaard',      address:'Ridderspoor 2, Rotterdam',              lat:51.905, lon:4.543 },
  { chain:'Hoogvliet',    name:'Hoogvliet · Rotterdam Nesselande', address:'Kosboulevard 1, Rotterdam',             lat:51.970, lon:4.570 },
  { chain:'Hoogvliet',    name:'Hoogvliet · Rotterdam Alexandrium',address:'Hoofdweg 200, Rotterdam',               lat:51.960, lon:4.556 },
  { chain:'Hoogvliet',    name:'Hoogvliet · Rotterdam Zuidplein',  address:'Zuidplein 130, Rotterdam',              lat:51.888, lon:4.484 },
  { chain:'Hoogvliet',    name:'Hoogvliet · Rotterdam Pendrecht',  address:'Slinge 300, Rotterdam',                 lat:51.884, lon:4.492 },
  { chain:'Hoogvliet',    name:'Hoogvliet · Rotterdam Beverwaard', address:'Waterleliestraat 10, Rotterdam',        lat:51.905, lon:4.547 },
  { chain:'Hoogvliet',    name:'Hoogvliet · Schiedam Kethel',      address:'Burg. Knappertlaan 120, Schiedam',      lat:51.930, lon:4.395 },
  { chain:'Hoogvliet',    name:'Hoogvliet · Capelle Schollevaar',  address:'Schollevaarsweg 100, Capelle a/d IJssel',lat:51.943, lon:4.582 },
  { chain:'Dirk',         name:'Dirk · Rotterdam Delfshaven',      address:'Bospolder 100, Rotterdam',              lat:51.918, lon:4.455 },
  { chain:'Dirk',         name:'Dirk · Rotterdam Feijenoord',      address:'Varkenoordseweg 50, Rotterdam',          lat:51.899, lon:4.505 },
  { chain:'Dirk',         name:'Dirk · Rotterdam Hillegersberg',   address:'Bergse Dorpsstraat 50, Rotterdam',       lat:51.950, lon:4.504 },
  { chain:'Dirk',         name:'Dirk · Rotterdam Prins Alexander', address:'Prins Alexanderlaan 200, Rotterdam',     lat:51.954, lon:4.558 },
  { chain:'Plus',         name:'Plus · Rotterdam Zuiderpark',      address:'Zuiderpark 2, Rotterdam',               lat:51.899, lon:4.473 },
  // ── ALMERE ───────────────────────────────────────────────────────────────────
  { chain:'Albert Heijn', name:'AH · Almere Centrum',              address:'Koopgoot 1, Almere',                    lat:52.372, lon:5.219 },
  { chain:'Albert Heijn', name:'AH · Almere Buiten',               address:'Buitenmere 1, Almere',                  lat:52.356, lon:5.248 },
  { chain:'Albert Heijn', name:'AH · Almere Poort',                address:'Evenaar 6, Almere',                     lat:52.348, lon:5.232 },
  { chain:'Jumbo',        name:'Jumbo · Almere Stad',              address:'Marktzijde 10, Almere',                 lat:52.370, lon:5.215 },
  { chain:'Lidl',         name:'Lidl · Almere',                    address:'Kruidenbuurt 10, Almere',               lat:52.362, lon:5.226 },
  { chain:'Aldi',         name:'Aldi · Almere',                    address:'Nobel 5, Almere',                       lat:52.356, lon:5.233 },
  { chain:'Plus',         name:'Plus · Almere Buiten',             address:'Buitenmere 50, Almere',                 lat:52.352, lon:5.251 },
  { chain:'Dirk',         name:'Dirk · Almere Stad',               address:'Stadsstraat 100, Almere',               lat:52.369, lon:5.218 },
  // ── AMERSFOORT ───────────────────────────────────────────────────────────────
  { chain:'Albert Heijn', name:'AH · Amersfoort Centrum',          address:'Langestraat 22, Amersfoort',            lat:52.155, lon:5.387 },
  { chain:'Albert Heijn', name:'AH · Amersfoort Vathorst',         address:'Lavendelheide 1, Amersfoort',           lat:52.193, lon:5.407 },
  { chain:'Jumbo',        name:'Jumbo · Amersfoort',               address:'Veeartsenijpad 3, Amersfoort',          lat:52.150, lon:5.392 },
  { chain:'Lidl',         name:'Lidl · Amersfoort',                address:'Barchman Wuytierslaan 10, Amersfoort',  lat:52.148, lon:5.382 },
  { chain:'Aldi',         name:'Aldi · Amersfoort',                address:'Ringweg-Noord 400, Amersfoort',         lat:52.162, lon:5.401 },
  { chain:'Plus',         name:'Plus · Amersfoort',                address:'Appelweg 12, Amersfoort',               lat:52.153, lon:5.375 },
  { chain:'Hoogvliet',    name:'Hoogvliet · Amersfoort Vathorst',  address:'Larikslaan 2, Amersfoort',              lat:52.183, lon:5.389 },
  // ── DEN HAAG ─────────────────────────────────────────────────────────────────
  { chain:'Albert Heijn', name:'AH · Den Haag Centrum',            address:'Spui 170, Den Haag',                    lat:52.076, lon:4.313 },
  { chain:'Albert Heijn', name:'AH · Scheveningen',                address:'Dr. Lelykade 7, Scheveningen',          lat:52.108, lon:4.270 },
  { chain:'Albert Heijn', name:'AH · Den Haag Ypenburg',           address:'Laan van Hoornwijck 10, Den Haag',      lat:52.033, lon:4.360 },
  { chain:'Jumbo',        name:'Jumbo · Den Haag',                 address:'Laan van Meerdervoort 185, Den Haag',   lat:52.083, lon:4.305 },
  { chain:'Lidl',         name:'Lidl · Den Haag Centrum',          address:'Verheeskade 88, Den Haag',              lat:52.072, lon:4.329 },
  { chain:'Lidl',         name:'Lidl · Den Haag Ypenburg',         address:'Laan van Hoornwijck 55, Den Haag',      lat:52.030, lon:4.360 },
  { chain:'Aldi',         name:'Aldi · Den Haag',                  address:'Theresiastraat 205, Den Haag',          lat:52.076, lon:4.337 },
  { chain:'Plus',         name:'Plus · Den Haag',                  address:'Wassenaarseweg 20, Den Haag',           lat:52.098, lon:4.313 },
  { chain:'Hoogvliet',    name:'Hoogvliet · Den Haag Ypenburg',    address:'Mercuriusweg 40, Den Haag',             lat:52.033, lon:4.356 },
  { chain:'Hoogvliet',    name:'Hoogvliet · Den Haag Leidschenveen',address:'Leidschenveen 110, Den Haag',          lat:52.060, lon:4.412 },
  { chain:'Hoogvliet',    name:'Hoogvliet · Den Haag Morgenstond', address:'Mgr. Van Steelaan 10, Den Haag',        lat:52.042, lon:4.290 },
  { chain:'Dirk',         name:'Dirk · Den Haag Laak',             address:'Vaillantlaan 40, Den Haag',              lat:52.070, lon:4.317 },
  { chain:'Dirk',         name:'Dirk · Den Haag Transvaal',        address:'Parallelweg 100, Den Haag',              lat:52.062, lon:4.332 },
  { chain:'Dirk',         name:'Dirk · Den Haag Schilderswijk',    address:'Hoefkade 150, Den Haag',                 lat:52.059, lon:4.314 },
  { chain:'Dirk',         name:'Dirk · Zoetermeer',                address:'Australiëweg 20, Zoetermeer',            lat:52.050, lon:4.473 },
  { chain:'Dirk',         name:'Dirk · Delft',                     address:'Papsouwselaan 140, Delft',               lat:52.007, lon:4.372 },
  { chain:'Dirk',         name:'Dirk · Dordrecht',                 address:'Johan de Wittstraat 20, Dordrecht',      lat:51.820, lon:4.663 },
  { chain:'Dirk',         name:'Dirk · Leiden',                    address:'Haarlemmerstraat 30, Leiden',            lat:52.159, lon:4.492 },
  { chain:'Dirk',         name:'Dirk · Haarlem',                   address:'Gedempte Oudegracht 60, Haarlem',        lat:52.381, lon:4.637 },
  { chain:'Hoogvliet',    name:'Hoogvliet · Zoetermeer',           address:'Boerhaavelaan 40, Zoetermeer',          lat:52.054, lon:4.490 },
  { chain:'Hoogvliet',    name:'Hoogvliet · Delft Tanthof',        address:'Martinus Nijhofflaan 2, Delft',         lat:52.002, lon:4.380 },
  { chain:'Hoogvliet',    name:'Hoogvliet · Leiden Merenwijk',     address:'Erasmusweg 10, Leiden',                 lat:52.148, lon:4.488 },
  { chain:'Hoogvliet',    name:'Hoogvliet · Dordrecht Sterrenburg',address:'Merwedestraat 30, Dordrecht',           lat:51.807, lon:4.671 },
  { chain:'Hoogvliet',    name:'Hoogvliet · Alphen aan den Rijn',  address:'Castellumstraat 30, Alphen a/d Rijn',   lat:52.129, lon:4.657 },
  // ── OTHER MAJOR CITIES ───────────────────────────────────────────────────────
  { chain:'Albert Heijn', name:'AH · Eindhoven Centrum',           address:'Demer 2, Eindhoven',                    lat:51.440, lon:5.478 },
  { chain:'Albert Heijn', name:'AH · Eindhoven Woensel',           address:'Woensel 88, Eindhoven',                 lat:51.460, lon:5.480 },
  { chain:'Jumbo',        name:'Jumbo · Eindhoven',                address:'Achtseweg-Zuid 155, Eindhoven',         lat:51.435, lon:5.463 },
  { chain:'Lidl',         name:'Lidl · Eindhoven',                 address:'Gestel 75, Eindhoven',                  lat:51.426, lon:5.464 },
  { chain:'Aldi',         name:'Aldi · Eindhoven',                 address:'Meerhoven 1, Eindhoven',                lat:51.418, lon:5.432 },
  { chain:'Plus',         name:'Plus · Eindhoven',                 address:'Boschdijktunnel 2, Eindhoven',          lat:51.445, lon:5.469 },
  { chain:'Albert Heijn', name:'AH · Haarlem Centrum',             address:'Grote Houtstraat 80, Haarlem',          lat:52.381, lon:4.633 },
  { chain:'Jumbo',        name:'Jumbo · Haarlem',                  address:'Raaks 7, Haarlem',                      lat:52.384, lon:4.637 },
  { chain:'Lidl',         name:'Lidl · Haarlem',                   address:'Boerhaavelaan 10, Haarlem',             lat:52.378, lon:4.656 },
  { chain:'Aldi',         name:'Aldi · Haarlem',                   address:'Schalkwijkerstraat 10, Haarlem',        lat:52.370, lon:4.658 },
  { chain:'DekaMarkt',    name:'DekaMarkt · Haarlem',              address:'Schalkwijkerstraat 83, Haarlem',        lat:52.373, lon:4.640 },
  { chain:'Albert Heijn', name:'AH · Groningen Centrum',           address:'Herestraat 54, Groningen',              lat:53.218, lon:6.564 },
  { chain:'Jumbo',        name:'Jumbo · Groningen',                address:'Paterswoldseweg 80, Groningen',         lat:53.209, lon:6.556 },
  { chain:'Lidl',         name:'Lidl · Groningen',                 address:'Ulgersmaweg 30, Groningen',             lat:53.224, lon:6.572 },
  { chain:'Aldi',         name:'Aldi · Groningen',                 address:'Winschoterdiep 50, Groningen',          lat:53.215, lon:6.582 },
  { chain:'Plus',         name:'Plus · Groningen',                 address:'Esperantostraat 20, Groningen',         lat:53.213, lon:6.553 },
  { chain:'Albert Heijn', name:'AH · Tilburg Centrum',             address:'Heuvelring 60, Tilburg',                lat:51.560, lon:5.087 },
  { chain:'Jumbo',        name:'Jumbo · Tilburg',                  address:'Piusplein 5, Tilburg',                  lat:51.556, lon:5.081 },
  { chain:'Lidl',         name:'Lidl · Tilburg',                   address:'Ringbaan-Noord 20, Tilburg',            lat:51.572, lon:5.087 },
  { chain:'Aldi',         name:'Aldi · Tilburg',                   address:'Ringbaan-West 195, Tilburg',            lat:51.559, lon:5.073 },
  { chain:'Albert Heijn', name:'AH · Breda Centrum',               address:'Ginnekenmarkt 1, Breda',                lat:51.589, lon:4.778 },
  { chain:'Jumbo',        name:'Jumbo · Breda',                    address:'Baronielaan 50, Breda',                 lat:51.585, lon:4.773 },
  { chain:'Lidl',         name:'Lidl · Breda',                     address:'Stadionstraat 35, Breda',               lat:51.578, lon:4.774 },
  { chain:'Aldi',         name:'Aldi · Breda',                     address:'Claudius Prinsenlaan 50, Breda',        lat:51.583, lon:4.793 },
  { chain:'Albert Heijn', name:'AH · Nijmegen Centrum',            address:'Mariënburg 38, Nijmegen',               lat:51.845, lon:5.869 },
  { chain:'Jumbo',        name:'Jumbo · Nijmegen',                 address:'Plein 1944 nr. 1, Nijmegen',            lat:51.844, lon:5.866 },
  { chain:'Lidl',         name:'Lidl · Nijmegen',                  address:'Nieuwe Dukenburgseweg 40, Nijmegen',    lat:51.829, lon:5.832 },
  { chain:'Aldi',         name:'Aldi · Nijmegen',                  address:'Dennenstraat 10, Nijmegen',             lat:51.838, lon:5.852 },
  // Poiesz (North Netherlands)
  { chain:'Poiesz',       name:'Poiesz · Sneek',                   address:'Prins Hendrikkade 1, Sneek',            lat:53.038, lon:5.660 },
  { chain:'Vomar',        name:'Vomar · Amsterdam Noord',          address:'Boven IJ, Amsterdam',                   lat:52.405, lon:4.930 },
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

// Local Dutch city geocoding (matches landing.html CITY_COORDS)
const CITY_COORDS_LOCAL = {
  amsterdam:   { lat:52.3676, lon:4.9041 },
  amstelveen:  { lat:52.3084, lon:4.8729 },
  rotterdam:   { lat:51.9244, lon:4.4777 },
  utrecht:     { lat:52.0907, lon:5.1214 },
  'de meern':  { lat:52.0748, lon:5.0266 },
  vleuten:     { lat:52.1006, lon:5.0109 },
  'leidsche rijn': { lat:52.0837, lon:5.0450 },
  'den haag':  { lat:52.0705, lon:4.3007 },
  'the hague': { lat:52.0705, lon:4.3007 },
  haag:        { lat:52.0705, lon:4.3007 },
  eindhoven:   { lat:51.4416, lon:5.4697 },
  haarlem:     { lat:52.3874, lon:4.6462 },
  leiden:      { lat:52.1601, lon:4.4970 },
  delft:       { lat:52.0116, lon:4.3571 },
  tilburg:     { lat:51.5555, lon:5.0913 },
  breda:       { lat:51.5719, lon:4.7683 },
  groningen:   { lat:53.2194, lon:6.5665 },
  nijmegen:    { lat:51.8426, lon:5.8546 },
  arnhem:      { lat:51.9851, lon:5.8987 },
  maastricht:  { lat:50.8514, lon:5.6910 },
  almere:      { lat:52.3702, lon:5.2147 },
  amersfoort:  { lat:52.1551, lon:5.3878 },
  hilversum:   { lat:52.2292, lon:5.1797 },
  zaandam:     { lat:52.4378, lon:4.8283 },
  dordrecht:   { lat:51.8133, lon:4.6901 },
  zoetermeer:  { lat:52.0566, lon:4.4940 },
  alphen:      { lat:52.1271, lon:4.6620 },
  woerden:     { lat:52.0878, lon:4.8891 },
  maarssen:    { lat:52.1289, lon:5.0461 },
  nieuwegein:  { lat:52.0283, lon:5.0842 },
  zeist:       { lat:52.0920, lon:5.2297 },
  houten:      { lat:52.0292, lon:5.1678 },
  ijsselstein: { lat:52.0156, lon:5.0263 },
  terwijde:    { lat:52.090,  lon:5.030  },
  parkwijk:    { lat:52.086,  lon:5.025  },
  enschede:    { lat:52.2183, lon:6.8958 },
  zwolle:      { lat:52.5168, lon:6.0830 },
  deventer:    { lat:52.2559, lon:6.1552 },
  apeldoorn:   { lat:52.2112, lon:5.9699 },
  schiedam:    { lat:51.9200, lon:4.3970 },
  capelle:     { lat:51.9370, lon:4.5850 },
  purmerend:   { lat:52.5024, lon:4.9633 },
  hoofddorp:   { lat:52.3003, lon:4.6941 },
  gouda:       { lat:52.0116, lon:4.7069 },
  middelburg:  { lat:51.4987, lon:3.6136 },
  heerlen:     { lat:50.8878, lon:5.9800 },
  venlo:       { lat:51.3703, lon:6.1723 },
  helmond:     { lat:51.4817, lon:5.6612 },
  oss:         { lat:51.7645, lon:5.5210 },
  leeuwarden:  { lat:53.2012, lon:5.7999 },
  assen:       { lat:52.9926, lon:6.5649 },
  emmen:       { lat:52.7871, lon:6.9009 },
  lelystad:    { lat:52.5185, lon:5.4714 },
  alkmaar:     { lat:52.6308, lon:4.7500 },
  diemen:      { lat:52.3369, lon:4.9741 },
  veenendaal:  { lat:52.0264, lon:5.5556 },
  ede:         { lat:51.9922, lon:5.6600 },
  harderwijk:  { lat:52.3451, lon:5.6204 },
  hoorn:       { lat:52.6444, lon:5.0579 },
  sneek:       { lat:53.0382, lon:5.6600 },
};

// PC4 postcode → coordinates (suburb-level accuracy, matches landing.html PC4_COORDS)
const PC4_COORDS = {
  // Amsterdam centrum
  '1011':{lat:52.374,lon:4.898},'1012':{lat:52.372,lon:4.893},'1013':{lat:52.384,lon:4.878},
  '1014':{lat:52.392,lon:4.858},'1015':{lat:52.381,lon:4.878},'1016':{lat:52.374,lon:4.882},
  '1017':{lat:52.364,lon:4.895},'1018':{lat:52.365,lon:4.912},'1019':{lat:52.360,lon:4.926},
  // Amsterdam West
  '1051':{lat:52.375,lon:4.853},'1052':{lat:52.365,lon:4.856},'1053':{lat:52.365,lon:4.866},
  '1054':{lat:52.361,lon:4.871},'1055':{lat:52.360,lon:4.837},'1056':{lat:52.354,lon:4.840},
  '1057':{lat:52.360,lon:4.851},'1058':{lat:52.351,lon:4.847},'1059':{lat:52.345,lon:4.839},
  '1060':{lat:52.355,lon:4.828},'1061':{lat:52.361,lon:4.820},'1062':{lat:52.353,lon:4.828},
  '1063':{lat:52.368,lon:4.828},'1064':{lat:52.376,lon:4.825},'1065':{lat:52.385,lon:4.830},
  '1066':{lat:52.395,lon:4.847},'1067':{lat:52.400,lon:4.840},'1068':{lat:52.348,lon:4.820},
  '1069':{lat:52.340,lon:4.825},
  // Amsterdam Zuid / Buitenveldert
  '1071':{lat:52.355,lon:4.884},'1072':{lat:52.351,lon:4.888},'1073':{lat:52.352,lon:4.896},
  '1074':{lat:52.348,lon:4.899},'1075':{lat:52.355,lon:4.855},'1076':{lat:52.340,lon:4.880},
  '1077':{lat:52.340,lon:4.872},'1078':{lat:52.343,lon:4.867},'1079':{lat:52.339,lon:4.859},
  '1081':{lat:52.337,lon:4.876},'1082':{lat:52.334,lon:4.873},'1083':{lat:52.330,lon:4.870},
  '1084':{lat:52.327,lon:4.869},'1085':{lat:52.323,lon:4.867},'1086':{lat:52.319,lon:4.866},
  '1087':{lat:52.316,lon:4.866},
  // Amsterdam Oost
  '1091':{lat:52.353,lon:4.924},'1092':{lat:52.347,lon:4.930},'1093':{lat:52.347,lon:4.938},
  '1094':{lat:52.356,lon:4.936},'1095':{lat:52.358,lon:4.944},'1096':{lat:52.340,lon:4.944},
  '1097':{lat:52.342,lon:4.952},'1098':{lat:52.337,lon:4.957},'1099':{lat:52.335,lon:4.971},
  // Amsterdam Noord
  '1021':{lat:52.386,lon:4.892},'1022':{lat:52.391,lon:4.896},'1023':{lat:52.396,lon:4.896},
  '1024':{lat:52.400,lon:4.913},'1025':{lat:52.396,lon:4.920},'1026':{lat:52.407,lon:4.922},
  '1027':{lat:52.413,lon:4.918},'1028':{lat:52.408,lon:4.940},'1029':{lat:52.398,lon:4.941},
  '1031':{lat:52.374,lon:4.942},'1032':{lat:52.378,lon:4.956},'1033':{lat:52.386,lon:4.960},
  '1034':{lat:52.390,lon:4.975},'1035':{lat:52.399,lon:4.974},'1036':{lat:52.414,lon:4.979},
  // Amsterdam Zuidoost
  '1101':{lat:52.320,lon:4.965},'1102':{lat:52.315,lon:4.978},'1103':{lat:52.310,lon:4.985},
  '1104':{lat:52.305,lon:4.978},'1105':{lat:52.295,lon:4.981},'1106':{lat:52.290,lon:4.988},
  '1107':{lat:52.283,lon:4.984},'1108':{lat:52.278,lon:4.991},'1109':{lat:52.272,lon:4.995},
  // Amstelveen
  '1180':{lat:52.309,lon:4.872},'1181':{lat:52.306,lon:4.862},'1182':{lat:52.301,lon:4.857},
  '1183':{lat:52.294,lon:4.852},'1184':{lat:52.289,lon:4.862},'1185':{lat:52.289,lon:4.872},
  '1186':{lat:52.293,lon:4.878},'1187':{lat:52.298,lon:4.888},'1188':{lat:52.303,lon:4.892},
  '1189':{lat:52.308,lon:4.892},
  // Diemen
  '1111':{lat:52.343,lon:4.967},'1112':{lat:52.340,lon:4.971},'1113':{lat:52.337,lon:4.975},
  '1114':{lat:52.334,lon:4.979},'1115':{lat:52.331,lon:4.983},'1116':{lat:52.328,lon:4.987},
  '1117':{lat:52.325,lon:4.991},
  // Almere
  '1300':{lat:52.375,lon:5.213},'1301':{lat:52.369,lon:5.218},'1302':{lat:52.361,lon:5.224},
  '1303':{lat:52.356,lon:5.232},'1304':{lat:52.349,lon:5.241},'1305':{lat:52.343,lon:5.249},
  '1306':{lat:52.337,lon:5.258},'1307':{lat:52.332,lon:5.267},'1308':{lat:52.327,lon:5.276},
  // Rotterdam centrum
  '3011':{lat:51.920,lon:4.479},'3012':{lat:51.917,lon:4.489},'3013':{lat:51.915,lon:4.468},
  '3014':{lat:51.913,lon:4.458},'3015':{lat:51.909,lon:4.465},'3016':{lat:51.914,lon:4.499},
  '3021':{lat:51.919,lon:4.456},'3022':{lat:51.926,lon:4.447},'3023':{lat:51.935,lon:4.443},
  '3024':{lat:51.942,lon:4.449},'3025':{lat:51.950,lon:4.454},'3026':{lat:51.956,lon:4.459},
  '3031':{lat:51.925,lon:4.467},'3032':{lat:51.927,lon:4.476},'3033':{lat:51.932,lon:4.482},
  '3041':{lat:51.930,lon:4.506},'3042':{lat:51.936,lon:4.511},'3043':{lat:51.941,lon:4.516},
  '3061':{lat:51.938,lon:4.468},'3062':{lat:51.943,lon:4.474},'3063':{lat:51.948,lon:4.480},
  '3071':{lat:51.909,lon:4.506},'3072':{lat:51.905,lon:4.512},'3073':{lat:51.901,lon:4.518},
  '3074':{lat:51.897,lon:4.524},'3075':{lat:51.893,lon:4.530},'3076':{lat:51.889,lon:4.536},
  // Utrecht centrum
  '3500':{lat:52.090,lon:5.121},'3501':{lat:52.092,lon:5.115},'3502':{lat:52.094,lon:5.110},
  '3511':{lat:52.089,lon:5.113},'3512':{lat:52.090,lon:5.120},'3513':{lat:52.096,lon:5.126},
  '3514':{lat:52.101,lon:5.125},'3515':{lat:52.105,lon:5.120},'3516':{lat:52.109,lon:5.116},
  '3517':{lat:52.113,lon:5.111},'3518':{lat:52.117,lon:5.107},'3519':{lat:52.121,lon:5.102},
  '3521':{lat:52.096,lon:5.099},'3522':{lat:52.085,lon:5.063},'3523':{lat:52.080,lon:5.083},
  '3524':{lat:52.072,lon:5.050},'3525':{lat:52.079,lon:5.079},'3526':{lat:52.078,lon:5.098},
  '3527':{lat:52.083,lon:5.095},'3528':{lat:52.099,lon:5.088},'3529':{lat:52.104,lon:5.088},
  '3531':{lat:52.066,lon:5.140},'3532':{lat:52.063,lon:5.139},'3533':{lat:52.061,lon:5.135},
  '3534':{lat:52.058,lon:5.131},'3535':{lat:52.055,lon:5.127},'3536':{lat:52.053,lon:5.123},
  // Terwijde & Parkwijk (west Utrecht / Leidsche Rijn)
  '3541':{lat:52.055,lon:5.093},'3542':{lat:52.058,lon:5.097},
  '3543':{lat:52.090,lon:5.030},'3544':{lat:52.086,lon:5.025},
  '3561':{lat:52.101,lon:5.145},'3562':{lat:52.097,lon:5.158},
  // Utrecht West – Leidsche Rijn / Vleuten / DE MEERN
  '3451':{lat:52.102,lon:5.045},'3452':{lat:52.088,lon:5.040},
  '3453':{lat:52.075,lon:5.028},'3454':{lat:52.074,lon:5.022}, // De Meern
  '3455':{lat:52.068,lon:5.018},'3456':{lat:52.064,lon:5.013},
  '3461':{lat:52.100,lon:5.013},'3462':{lat:52.100,lon:5.009}, // Vleuten
  '3463':{lat:52.096,lon:5.006},
  // Maarssen
  '3601':{lat:52.133,lon:5.040},'3602':{lat:52.130,lon:5.044},'3603':{lat:52.127,lon:5.048},
  '3604':{lat:52.124,lon:5.052},'3605':{lat:52.121,lon:5.056},'3606':{lat:52.118,lon:5.060},
  // Woerden
  '3440':{lat:52.090,lon:4.887},'3441':{lat:52.087,lon:4.882},'3442':{lat:52.084,lon:4.877},
  '3443':{lat:52.081,lon:4.872},'3444':{lat:52.078,lon:4.867},'3445':{lat:52.075,lon:4.862},
  // Nieuwegein
  '3430':{lat:52.038,lon:5.087},'3431':{lat:52.035,lon:5.085},'3432':{lat:52.032,lon:5.083},
  '3433':{lat:52.029,lon:5.081},'3434':{lat:52.026,lon:5.083},'3435':{lat:52.023,lon:5.086},
  '3436':{lat:52.020,lon:5.090},'3437':{lat:52.017,lon:5.094},'3438':{lat:52.014,lon:5.097},
  '3439':{lat:52.011,lon:5.100},
  // Houten
  '3991':{lat:52.032,lon:5.168},'3992':{lat:52.029,lon:5.174},'3993':{lat:52.026,lon:5.180},
  '3994':{lat:52.023,lon:5.186},'3995':{lat:52.020,lon:5.192},'3996':{lat:52.017,lon:5.198},
  '3997':{lat:52.014,lon:5.204},'3998':{lat:52.011,lon:5.210},'3999':{lat:52.008,lon:5.216},
  // IJsselstein
  '3401':{lat:52.021,lon:5.038},'3402':{lat:52.018,lon:5.034},'3403':{lat:52.015,lon:5.030},
  '3404':{lat:52.012,lon:5.026},'3405':{lat:52.009,lon:5.022},'3406':{lat:52.006,lon:5.018},
  // Zeist
  '3700':{lat:52.093,lon:5.221},'3701':{lat:52.090,lon:5.228},'3702':{lat:52.087,lon:5.234},
  '3703':{lat:52.084,lon:5.240},'3704':{lat:52.081,lon:5.246},'3705':{lat:52.078,lon:5.252},
  // Amersfoort
  '3800':{lat:52.155,lon:5.387},'3801':{lat:52.158,lon:5.394},'3802':{lat:52.161,lon:5.400},
  '3803':{lat:52.164,lon:5.407},'3804':{lat:52.167,lon:5.414},'3811':{lat:52.152,lon:5.382},
  '3812':{lat:52.155,lon:5.375},'3813':{lat:52.158,lon:5.369},'3814':{lat:52.161,lon:5.362},
  '3821':{lat:52.152,lon:5.400},'3822':{lat:52.149,lon:5.407},'3823':{lat:52.146,lon:5.413},
  // Den Haag
  '2491':{lat:52.090,lon:4.316},'2492':{lat:52.090,lon:4.325},'2493':{lat:52.090,lon:4.334},
  '2511':{lat:52.073,lon:4.310},'2512':{lat:52.073,lon:4.320},'2513':{lat:52.073,lon:4.330},
  '2514':{lat:52.073,lon:4.340},'2515':{lat:52.073,lon:4.350},'2516':{lat:52.073,lon:4.360},
  '2521':{lat:52.056,lon:4.312},'2522':{lat:52.056,lon:4.322},'2523':{lat:52.056,lon:4.332},
  '2531':{lat:52.066,lon:4.320},'2532':{lat:52.066,lon:4.330},'2533':{lat:52.066,lon:4.340},
  '2541':{lat:52.030,lon:4.356},'2542':{lat:52.030,lon:4.366},'2543':{lat:52.030,lon:4.376},
  // Eindhoven
  '5611':{lat:51.441,lon:5.475},'5612':{lat:51.441,lon:5.485},'5613':{lat:51.430,lon:5.453},
  '5614':{lat:51.438,lon:5.489},'5615':{lat:51.423,lon:5.465},'5616':{lat:51.420,lon:5.481},
  '5617':{lat:51.450,lon:5.463},'5621':{lat:51.420,lon:5.497},'5622':{lat:51.418,lon:5.488},
  '5631':{lat:51.463,lon:5.494},'5641':{lat:51.474,lon:5.542},'5651':{lat:51.418,lon:5.430},
  // Haarlem
  '2011':{lat:52.383,lon:4.638},'2012':{lat:52.383,lon:4.628},'2013':{lat:52.380,lon:4.619},
  '2014':{lat:52.374,lon:4.638},'2015':{lat:52.387,lon:4.645},'2021':{lat:52.377,lon:4.649},
  '2022':{lat:52.373,lon:4.651},'2023':{lat:52.385,lon:4.655},'2024':{lat:52.367,lon:4.659},
  // Leiden
  '2311':{lat:52.159,lon:4.495},'2312':{lat:52.161,lon:4.498},'2313':{lat:52.163,lon:4.501},
  '2321':{lat:52.148,lon:4.489},'2322':{lat:52.151,lon:4.487},'2331':{lat:52.155,lon:4.512},
  // Tilburg
  '5011':{lat:51.560,lon:5.087},'5012':{lat:51.556,lon:5.082},'5013':{lat:51.565,lon:5.093},
  '5014':{lat:51.570,lon:5.098},'5015':{lat:51.563,lon:5.075},'5021':{lat:51.546,lon:5.077},
  // Breda
  '4811':{lat:51.589,lon:4.778},'4812':{lat:51.592,lon:4.773},'4813':{lat:51.585,lon:4.768},
  '4814':{lat:51.579,lon:4.780},'4815':{lat:51.575,lon:4.791},'4816':{lat:51.582,lon:4.799},
  // Groningen
  '9711':{lat:53.218,lon:6.564},'9712':{lat:53.215,lon:6.558},'9713':{lat:53.220,lon:6.572},
  '9714':{lat:53.224,lon:6.566},'9715':{lat:53.227,lon:6.558},'9721':{lat:53.206,lon:6.558},
  // Nijmegen
  '6511':{lat:51.845,lon:5.869},'6512':{lat:51.848,lon:5.864},'6513':{lat:51.851,lon:5.857},
  '6521':{lat:51.838,lon:5.876},'6522':{lat:51.835,lon:5.880},'6523':{lat:51.832,lon:5.876},
  // Arnhem
  '6811':{lat:51.985,lon:5.899},'6812':{lat:51.982,lon:5.905},'6813':{lat:51.979,lon:5.912},
  '6821':{lat:51.975,lon:5.880},'6822':{lat:51.972,lon:5.886},'6823':{lat:51.969,lon:5.893},
  // Maastricht
  '6211':{lat:50.851,lon:5.693},'6212':{lat:50.848,lon:5.701},'6213':{lat:50.845,lon:5.709},
  '6221':{lat:50.839,lon:5.725},'6222':{lat:50.836,lon:5.733},
  // Zoetermeer
  '2700':{lat:52.055,lon:4.493},'2701':{lat:52.052,lon:4.501},'2702':{lat:52.049,lon:4.509},
  '2703':{lat:52.046,lon:4.517},'2704':{lat:52.043,lon:4.525},'2705':{lat:52.058,lon:4.483},
  // Delft
  '2611':{lat:52.012,lon:4.357},'2612':{lat:52.009,lon:4.365},'2613':{lat:52.006,lon:4.373},
  '2614':{lat:52.003,lon:4.381},'2615':{lat:52.015,lon:4.349},'2616':{lat:52.018,lon:4.341},
};

function geocodeLocationLocal(query) {
  const q = (query || '').toLowerCase().replace(/[,]+/g, ' ').replace(/\s+/g, ' ').trim();
  // 1. Try exact PC4 postcode
  const pcMatch = q.match(/\b([1-9][0-9]{3})\s*[a-z]{0,2}\b/);
  if (pcMatch) {
    const pc4 = pcMatch[1];
    if (PC4_COORDS[pc4]) return PC4_COORDS[pc4];
    // Nearest-neighbour scan ±100
    const base = parseInt(pc4, 10);
    for (let delta = 1; delta <= 100; delta++) {
      const up = String(base + delta), down = String(base - delta);
      if (PC4_COORDS[up])   return PC4_COORDS[up];
      if (PC4_COORDS[down]) return PC4_COORDS[down];
    }
  }
  // 2. City/area name match
  const cityKey = Object.keys(CITY_COORDS_LOCAL).find(k => q.includes(k));
  if (cityKey) return CITY_COORDS_LOCAL[cityKey];
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

  // For demo-only mode we do **not** call any external geocoding API.
  // If the local postcode/city lookup fails, surface a friendly error.
  throw new Error('Location not recognised. Try a Dutch city name or 4-digit postcode (e.g. 3454, Utrecht, De Meern).');
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
      storeName: bestStore.name,
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

