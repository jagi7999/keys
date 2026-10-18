/**
 * License API — Vercel serverless function.
 * Keeps the Turso token on the server so it never reaches customer portals.
 *
 * POST /api/license
 *   body: { key: "0000-0000-0000-0000", portal: "BILL", device: "<uuid>" }
 *   200 : { ok:true,  type, expires_at, days_left }
 *         { ok:false, m:"reason" }
 *
 * Env vars: TURSO_URL, TURSO_TOKEN, ALLOWED_ORIGINS (optional, comma list; default "*")
 */

const TURSO_URL = (process.env.TURSO_URL || '').trim().replace(/^libsql:\/\//, 'https://').replace(/\/+$/, '');
const TURSO_TOKEN = (process.env.TURSO_TOKEN || '').trim();
const ALLOWED = (process.env.ALLOWED_ORIGINS || '*').split(',').map(s => s.trim().replace(/\/+$/, '')).filter(Boolean);
const DAY = 864e5;

/* ---- tiny per-instance rate limit: 40 requests / minute / IP ---- */
const hits = new Map();
function limited(ip) {
  const now = Date.now();
  const rec = hits.get(ip) || { n: 0, t: now };
  if (now - rec.t > 60000) { rec.n = 0; rec.t = now; }
  rec.n++;
  hits.set(ip, rec);
  if (hits.size > 5000) for (const [k, v] of hits) if (now - v.t > 60000) hits.delete(k);
  return rec.n > 40;
}

/* ---- Turso HTTP pipeline ---- */
const typed = v =>
  v === null || v === undefined ? { type: 'null' }
  : typeof v === 'number' ? { type: 'integer', value: String(v) }
  : { type: 'text', value: String(v) };
const cell = c => (!c || c.type === 'null') ? null : (c.type === 'integer' || c.type === 'float') ? Number(c.value) : c.value;

async function turso(stmts) {
  if (!TURSO_URL || !TURSO_TOKEN) throw new Error('server not configured');
  const res = await fetch(TURSO_URL + '/v2/pipeline', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + TURSO_TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      requests: [
        ...stmts.map(s => ({ type: 'execute', stmt: { sql: s[0], args: (s[1] || []).map(typed) } })),
        { type: 'close' }
      ]
    })
  });
  if (!res.ok) throw new Error('turso ' + res.status);
  const j = await res.json();
  return j.results.slice(0, stmts.length).map(r => {
    if (r.type !== 'ok') throw new Error((r.error && r.error.message) || 'query failed');
    const rs = r.response.result;
    const names = rs.cols.map(c => c.name);
    return rs.rows.map(row => {
      const o = {};
      names.forEach((n, i) => { o[n] = cell(row[i]); });
      return o;
    });
  });
}

const audit = (action, detail) =>
  ['INSERT INTO audit(ts,action,detail) VALUES(?,?,?)', [new Date().toISOString(), action, detail]];

/* ---- core check ---- */
async function checkLicense(key, portal, device) {
  const sel = 'SELECT l.*, p.enabled FROM licenses l JOIN portals p ON p.id=l.portal_id WHERE l.license_key=? AND p.code=?';
  let [rows] = await turso([[sel, [key, portal]]]);
  let l = rows[0];
  if (!l) return { ok: false, m: 'Invalid license key.' };
  if (!l.enabled) return { ok: false, m: 'This portal is currently disabled.' };
  if (l.status === 'revoked') {
    return { ok: false, m: 'This license has been revoked.' + (l.revoke_reason ? ' (' + l.revoke_reason + ')' : '') };
  }

  const now = new Date();

  // First activation starts the clock (conditional update avoids double-start races)
  if (!l.activated_at) {
    const exp = l.duration_days > 0 ? new Date(now.getTime() + l.duration_days * DAY).toISOString() : null;
    await turso([
      ['UPDATE licenses SET activated_at=?, expires_at=? WHERE id=? AND activated_at IS NULL', [now.toISOString(), exp, l.id]],
      audit('ACTIVATE', key + ' on ' + portal)
    ]);
    [rows] = await turso([[sel, [key, portal]]]);
    l = rows[0];
  }

  if (l.expires_at && new Date(l.expires_at) < now) {
    return { ok: false, m: 'License expired on ' + new Date(l.expires_at).toLocaleDateString('en-GB') + '. Please purchase a license key.' };
  }

  // Device binding
  const [devs] = await turso([['SELECT device_id FROM activations WHERE license_id=?', [l.id]]]);
  const known = devs.some(d => d.device_id === device);
  if (!known && devs.length >= l.max_devices) {
    return { ok: false, m: 'Device limit reached for this key. Contact support.' };
  }
  const t = now.toISOString();
  if (known) {
    await turso([['UPDATE activations SET last_seen=? WHERE license_id=? AND device_id=?', [t, l.id, device]]]);
  } else {
    await turso([
      ['INSERT INTO activations(license_id,device_id,first_seen,last_seen) VALUES(?,?,?,?)', [l.id, device, t, t]],
      audit('NEW_DEVICE', key + ' on ' + portal)
    ]);
  }

  return {
    ok: true,
    type: l.type,
    expires_at: l.expires_at,
    days_left: l.expires_at ? Math.max(0, Math.ceil((new Date(l.expires_at) - now) / DAY)) : null
  };
}

/* ---- handler ---- */
module.exports = async (req, res) => {
  const origin = (req.headers.origin || '').replace(/\/+$/, '');
  const allowOrigin = ALLOWED.includes('*') ? '*' : (ALLOWED.includes(origin) ? origin : '');
  if (allowOrigin) res.setHeader('Access-Control-Allow-Origin', allowOrigin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ ok: false, m: 'Method not allowed' });
  if (!allowOrigin && origin) return res.status(403).json({ ok: false, m: 'Origin not allowed' });

  const ip = String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '').split(',')[0].trim();
  if (limited(ip)) return res.status(429).json({ ok: false, m: 'Too many attempts. Please wait a minute.' });

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = null; } }
  body = body || {};

  const digits = String(body.key || '').replace(/\D/g, '');
  const portal = String(body.portal || '').toUpperCase();
  const device = String(body.device || '');
  if (digits.length !== 16) return res.status(200).json({ ok: false, m: 'Key must be 16 digits.' });
  if (!/^[A-Z0-9_]{1,24}$/.test(portal)) return res.status(200).json({ ok: false, m: 'Invalid portal.' });
  if (device.length < 8 || device.length > 100) return res.status(200).json({ ok: false, m: 'Invalid device.' });

  const key = digits.match(/\d{4}/g).join('-');
  try {
    return res.status(200).json(await checkLicense(key, portal, device));
  } catch (e) {
    console.error('license error:', e.message);
    return res.status(503).json({ ok: false, m: 'Service unavailable' });
  }
};

module.exports.checkLicense = checkLicense; // exported for tests
