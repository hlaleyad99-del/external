import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';

const scrypt = promisify(crypto.scrypt);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

/* ───────────────────────── .env ───────────────────────── */
function loadDotEnv(filePath) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    for (const line of raw.split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (!m || process.env[m[1]]) continue;
      let v = m[2].trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      process.env[m[1]] = v.replace(/\\n/g, '\n');
    }
  } catch { /* no .env */ }
}
loadDotEnv(path.join(__dirname, '.env'));

/* ───────────────────────── helpers ───────────────────────── */
// يدعم الأرقام العربية والفارسية و +20 / 0020 / 20
function normalizePhone(v) {
  let s = String(v || '')
    .replace(/[٠-٩]/g, d => '٠١٢٣٤٥٦٧٨٩'.indexOf(d))
    .replace(/[۰-۹]/g, d => '۰۱۲۳۴۵۶۷۸۹'.indexOf(d))
    .replace(/[^\d+]/g, '');
  if (/^(\+20|0020|20)1\d{9}$/.test(s)) s = '0' + s.replace(/^(\+20|0020|20)/, '');
  return s.replace(/\+/g, '');
}

const PORT = Number(process.env.PORT || 8787);
const FIREBASE_WEB_API_KEY = (process.env.FIREBASE_WEB_API_KEY || '').trim();
const FIREBASE_AUTH_DOMAIN = (process.env.FIREBASE_AUTH_DOMAIN || '').trim();
const FIREBASE_APP_ID = (process.env.FIREBASE_APP_ID || '').trim();
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const LTX_API_KEY = process.env.LTX_API_KEY || '';
const XKIRO_API_KEY = process.env.XKIRO_API_KEY || '';
const CORS_ORIGIN = (process.env.CORS_ORIGIN || '').trim();
const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || '').trim().toLowerCase();
const ADMIN_PHONE = normalizePhone(process.env.ADMIN_PHONE || '01035089566');
const ADMIN_INITIAL_PASSWORD = process.env.ADMIN_INITIAL_PASSWORD || '';
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
if (!process.env.SESSION_SECRET) console.warn('⚠️ SESSION_SECRET غير مضبوط: سيتم تسجيل خروج الجميع عند كل إعادة تشغيل.');

/* ───────────────────────── storage ───────────────────────── */
function firebaseReady() {
  return !!(process.env.FIREBASE_PROJECT_ID && process.env.FIREBASE_CLIENT_EMAIL && process.env.FIREBASE_PRIVATE_KEY);
}
if (firebaseReady() && !getApps().length) {
  initializeApp({
    credential: cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
    }),
  });
}
const db = firebaseReady() ? getFirestore() : null;
if (!db) console.warn('⚠️ Firebase غير مضبوط: البيانات تُحفظ في ملفات محلية وقد تضيع عند إعادة النشر على Render.');

const fallbackDir = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(__dirname, 'data');
try { fs.mkdirSync(fallbackDir, { recursive: true }); } catch (e) { console.warn('⚠️ تعذر إنشاء مجلد البيانات:', e.message); }
const fallback = name => path.join(fallbackDir, name);
function readJson(file, def) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return def; } }
function writeJson(file, data) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

/* ───────────────────────── http utils ───────────────────────── */
function httpError(message, status = 400) { return Object.assign(new Error(message), { status }); }

function send(res, status, body, type = 'application/json', extra = {}) {
  const headers = {
    'Content-Type': `${type}; charset=utf-8`,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...extra,
  };
  if (CORS_ORIGIN) {
    headers['Access-Control-Allow-Origin'] = CORS_ORIGIN;
    headers['Access-Control-Allow-Headers'] = 'Content-Type,Authorization';
    headers['Access-Control-Allow-Methods'] = 'GET,POST,DELETE,OPTIONS';
  }
  res.writeHead(status, headers);
  if (status === 204) return res.end();
  res.end(type === 'application/json' ? JSON.stringify(body) : body);
}

// قراءة الجسم كـ Buffer ثم تحويله مرة واحدة (إصلاح تلف الحروف العربية عند تقسيم الـ chunks)
async function body(req, limit = 8 * 1024 * 1024) {
  let size = 0;
  const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw httpError('حجم الطلب كبير جدًا.', 413);
    chunks.push(c);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { return {}; }
}

const hits = new Map();
function rateLimit(key, max, windowMs) {
  const now = Date.now();
  let h = hits.get(key);
  if (!h || h.reset < now) { h = { n: 0, reset: now + windowMs }; hits.set(key, h); }
  if (++h.n > max) throw httpError('محاولات كثيرة. حاول مرة أخرى بعد قليل.', 429);
}
setInterval(() => { const now = Date.now(); for (const [k, h] of hits) if (h.reset < now) hits.delete(k); }, 60_000).unref();
const clientIp = req => String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || 'ip';

// قفل بسيط لكل مفتاح لمنع تعارض عمليات الرصيد المتزامنة
const locks = new Map();
function withLock(key, fn) {
  const prev = locks.get(key) || Promise.resolve();
  const run = prev.catch(() => {}).then(fn);
  const tail = run.catch(() => {});
  locks.set(key, tail);
  tail.then(() => { if (locks.get(key) === tail) locks.delete(key); });
  return run;
}

/* ───────────────────────── auth ───────────────────────── */
async function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = (await scrypt(String(password), salt, 64)).toString('hex');
  return { salt, hash };
}
async function verifyPassword(password, salt, hash) {
  try {
    const actual = Buffer.from((await scrypt(String(password), salt, 64)).toString('hex'), 'hex');
    const expected = Buffer.from(hash, 'hex');
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
  } catch { return false; }
}
const safeEqual = (a, b) => {
  const x = crypto.createHash('sha256').update(String(a)).digest();
  const y = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(x, y);
};
function makeToken(uid) {
  const payload = Buffer.from(JSON.stringify({ uid, exp: Date.now() + 1000 * 60 * 60 * 24 * 30 })).toString('base64url');
  const sig = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url');
  return payload + '.' + sig;
}
function readToken(token) {
  try {
    const [payload, sig] = String(token || '').split('.');
    if (!payload || !sig) return null;
    const good = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url');
    const a = Buffer.from(sig), b = Buffer.from(good);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    const d = JSON.parse(Buffer.from(payload, 'base64url').toString());
    if (!d.uid || d.exp < Date.now()) return null;
    return d;
  } catch { return null; }
}
// لا نُرجع الهاش والـ salt للمتصفح أبدًا
function publicUser(u) {
  if (!u) return u;
  const { passwordHash, passwordSalt, ...rest } = u;
  return rest;
}
const isAdminUser = u =>
  !!(u && (u.admin ||
    (ADMIN_EMAIL && String(u.email || '').toLowerCase() === ADMIN_EMAIL) ||
    (ADMIN_PHONE && normalizePhone(u.phone) === ADMIN_PHONE)));

async function getUser(uid) {
  if (db) { const s = await db.collection('users').doc(uid).get(); return s.exists ? s.data() : null; }
  return readJson(fallback('users.json'), {})[uid] || null;
}
async function saveUser(u) {
  if (db) { await db.collection('users').doc(u.uid).set(u, { merge: true }); return; }
  const f = fallback('users.json'), all = readJson(f, {});
  all[u.uid] = u;
  writeJson(f, all);
}
async function userFromReq(req) {
  const h = req.headers.authorization || '';
  const d = readToken(h.startsWith('Bearer ') ? h.slice(7) : '');
  if (!d) throw httpError('سجّل الدخول أولًا للمتابعة.', 401);
  const u = await getUser(d.uid);
  if (!u) throw httpError('الحساب غير موجود.', 401);
  return { uid: u.uid, phone: u.phone || '', name: u.name || 'عضو الهلال AI', email: u.email || '', admin: isAdminUser(u) };
}
async function requireAdmin(req) {
  const d = await userFromReq(req);
  if (!d.admin) throw httpError('غير مصرح.', 403);
  return d;
}

async function bindBrowser(browserId, uid) {
  browserId = String(browserId || '').trim();
  if (!/^[a-zA-Z0-9_-]{16,100}$/.test(browserId)) throw httpError('معرّف المتصفح غير صالح. حدّث الصفحة وحاول مرة أخرى.', 400);
  const conflict = httpError('هذا المتصفح مرتبط بحساب آخر. لا يمكن استخدام أكثر من حساب في المتصفح نفسه.', 409);
  if (db) {
    const ref = db.collection('browserBindings').doc(browserId);
    const snap = await ref.get();
    if (snap.exists && snap.data().uid !== uid) throw conflict;
    await ref.set({ uid, updatedAt: new Date().toISOString() }, { merge: true });
  } else {
    const f = fallback('browser-bindings.json');
    const bindings = readJson(f, {});
    if (bindings[browserId] && bindings[browserId] !== uid) throw conflict;
    bindings[browserId] = uid;
    writeJson(f, bindings);
  }
}

/* ───────────────────────── coins ───────────────────────── */
// كل تعديل رصيد يقرأ المستخدم من جديد داخل القفل → لا رصيد سالب ولا تجاوز بالطلبات المتزامنة
function adjustPoints(uid, delta, reason) {
  return withLock('u:' + uid, async () => {
    const u = await getUser(uid);
    if (!u) throw httpError('الحساب غير موجود.', 404);
    const cur = Number(u.points) || 0;
    if (delta < 0 && cur < -delta) throw httpError(`رصيدك غير كافٍ. تحتاج ${-delta} كوين.`, 402);
    u.points = cur + delta;
    if (reason) {
      u.used = u.used || {};
      u.used[reason] = Math.max(0, (Number(u.used[reason]) || 0) - delta);
    }
    await saveUser(u);
    return u;
  });
}
const charge = (uid, amount, reason) => adjustPoints(uid, -amount, reason);
const refund = (uid, amount, reason) => adjustPoints(uid, amount, reason);

/* ───────────────────────── projects ───────────────────────── */
const safeId = (v, prefix = 'p_') => String(v || '').replace(/[^\w-]/g, '').slice(0, 80) || prefix + crypto.randomUUID();

async function listProjects(uid) {
  if (db) {
    const s = await db.collection('users').doc(uid).collection('projects').orderBy('createdAt', 'desc').limit(200).get();
    return s.docs.map(d => d.data());
  }
  return readJson(fallback('projects.json'), {})[uid] || [];
}
async function saveProject(uid, p) {
  if (JSON.stringify(p).length > 900_000) throw httpError('المشروع كبير جدًا للحفظ.', 413);
  if (db) {
    await db.collection('users').doc(uid).collection('projects').doc(p.id).set(p, { merge: true });
    return p;
  }
  const f = fallback('projects.json'), all = readJson(f, {});
  const list = (all[uid] || []).filter(x => x.id !== p.id);
  list.unshift(p);
  all[uid] = list.slice(0, 200);
  writeJson(f, all);
  return p;
}
async function deleteProjectStore(uid, id) {
  if (db) { await db.collection('users').doc(uid).collection('projects').doc(id).delete(); return; }
  const f = fallback('projects.json'), all = readJson(f, {});
  all[uid] = (all[uid] || []).filter(p => p.id !== id);
  writeJson(f, all);
}

/* ───────────────────────── payments ───────────────────────── */
const PACKS = { p1: { coins: 1000, price: 10 }, p2: { coins: 10000, price: 100 }, p3: { coins: 100000, price: 1000 } };

async function listPayments() {
  if (db) {
    const s = await db.collection('payments').orderBy('createdAt', 'desc').limit(500).get();
    return s.docs.map(d => d.data());
  }
  return readJson(fallback('payments.json'), []);
}
async function listPaymentsByUid(uid) {
  if (db) {
    const s = await db.collection('payments').where('uid', '==', uid).get();
    return s.docs.map(d => d.data()).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))).slice(0, 50);
  }
  return readJson(fallback('payments.json'), []).filter(x => x.uid === uid).slice(0, 50);
}
async function getPayment(id) {
  if (db) { const s = await db.collection('payments').doc(id).get(); return s.exists ? s.data() : null; }
  return readJson(fallback('payments.json'), []).find(x => x.id === id) || null;
}
async function findPaymentByRef(ref) {
  if (db) {
    const s = await db.collection('payments').where('transactionRef', '==', ref).get();
    return s.docs.map(d => d.data()).find(x => x.status !== 'rejected') || null;
  }
  return readJson(fallback('payments.json'), []).find(x => x.transactionRef === ref && x.status !== 'rejected') || null;
}
async function updatePayment(rec) {
  if (db) { await db.collection('payments').doc(rec.id).set(rec, { merge: true }); return; }
  const f = fallback('payments.json'), a = readJson(f, []), i = a.findIndex(x => x.id === rec.id);
  if (i >= 0) a[i] = rec;
  writeJson(f, a);
}
async function createPayment(uid, email, p) {
  const pack = PACKS[p.packageId];
  if (!pack) throw httpError('الباقة غير صحيحة.', 400);
  const transactionRef = String(p.transactionRef || '').trim().replace(/\s+/g, '');
  if (!transactionRef) throw httpError('رقم العملية مطلوب.', 400);
  if (!/^[A-Za-z0-9\-_.]{6,40}$/.test(transactionRef)) throw httpError('رقم العملية غير صالح (6 إلى 40 حرفًا/رقمًا).', 400);
  rateLimit('pay:' + uid, 10, 60 * 60_000);
  return withLock('payref:' + transactionRef, async () => {
    if (await findPaymentByRef(transactionRef)) throw httpError('رقم العملية هذا مُسجّل بالفعل.', 409);
    const rec = {
      id: 'pay_' + crypto.randomUUID(), uid, email: email || '', packageId: p.packageId,
      coins: pack.coins, price: pack.price, transactionRef, status: 'pending', createdAt: new Date().toISOString(),
    };
    if (db) await db.collection('payments').doc(rec.id).set(rec);
    else { const f = fallback('payments.json'), a = readJson(f, []); a.unshift(rec); writeJson(f, a); }
    return rec;
  });
}
function reviewPayment(id, approve, reviewer) {
  return withLock('payment:' + id, async () => {
    const rec = await getPayment(id);
    if (!rec) throw httpError('الطلب غير موجود.', 404);
    if (rec.status !== 'pending') throw httpError('الطلب تمت معالجته بالفعل.', 400);
    if (approve) {
      if (!(await getUser(rec.uid))) throw httpError('المستخدم غير موجود.', 404);
      rec.status = 'approved'; rec.reviewedAt = new Date().toISOString(); rec.reviewedBy = reviewer;
      await updatePayment(rec);
      try { await adjustPoints(rec.uid, rec.coins); }
      catch (e) { rec.status = 'pending'; delete rec.reviewedAt; delete rec.reviewedBy; await updatePayment(rec); throw e; }
    } else {
      rec.status = 'rejected'; rec.reviewedAt = new Date().toISOString(); rec.reviewedBy = reviewer;
      await updatePayment(rec);
    }
    return rec;
  });
}

/* ───────────────────────── redeem codes ───────────────────────── */
// أصفر = 100 ، أخضر = 1,000 ، أحمر = 10,000
// الأصفر والأخضر: مرة واحدة على مستوى النظام.
// الأحمر: كان قابلًا للاستخدام بلا حد (أي شخص يكرره ويجمع كوينز بلا نهاية) → الآن مرة واحدة لكل حساب.
const REDEEM_CODES = Object.freeze({
  A123: 10000, B456: 10000, C789: 10000, D321: 10000, E654: 10000, F987: 10000, G111: 10000, H222: 10000, I333: 10000, J444: 10000,
  K555: 100, L666: 100, M777: 100, N888: 100, O999: 100, P102: 100, Q304: 100, R506: 100, S708: 100, T901: 100, U234: 100, V567: 100, W890: 100, X135: 100, Y246: 100, Z357: 100, A468: 100, B579: 100, C680: 100, D791: 100,
  E802: 1000, F913: 1000, G024: 1000, H135: 1000, I246: 1000, J357: 1000, K468: 1000, L579: 1000, M680: 1000, N791: 1000, O112: 1000, P223: 1000, Q334: 1000, R445: 1000, S556: 1000, T667: 1000, U778: 1000, V889: 1000, W990: 1000, X147: 1000,
});
const REDEEM_GLOBAL_ONCE = new Set(Object.keys(REDEEM_CODES).filter(c => REDEEM_CODES[c] !== 10000));

async function claimGlobalCode(code, uid, amount) {
  const rec = { code, uid, coins: amount, redeemedAt: new Date().toISOString() };
  if (db) {
    try { await db.collection('redeemed_codes').doc(code).create(rec); }
    catch (e) { if (e?.code === 6 || /already exists/i.test(e?.message || '')) throw httpError('هذا الكود تم استخدامه بالفعل.', 409); throw e; }
    return;
  }
  const f = fallback('redeemed-codes.json'), all = readJson(f, {});
  if (all[code]) throw httpError('هذا الكود تم استخدامه بالفعل.', 409);
  all[code] = rec;
  writeJson(f, all);
}
async function releaseGlobalCode(code) {
  try {
    if (db) await db.collection('redeemed_codes').doc(code).delete();
    else { const f = fallback('redeemed-codes.json'), all = readJson(f, {}); delete all[code]; writeJson(f, all); }
  } catch { /* ignore */ }
}
async function redeemCode(uid, rawCode) {
  const code = String(rawCode || '').trim().toUpperCase();
  const amount = REDEEM_CODES[code];
  if (!amount) throw httpError('الكود غير صحيح أو غير موجود.', 400);
  return withLock('u:' + uid, async () => {
    const u = await getUser(uid);
    if (!u) throw httpError('الحساب غير موجود.', 404);
    if (u.redeemLog && u.redeemLog[code]) throw httpError('سبق أن استخدمت هذا الكود على حسابك.', 409);
    const once = REDEEM_GLOBAL_ONCE.has(code);
    if (once) await claimGlobalCode(code, uid, amount);
    try {
      u.points = (Number(u.points) || 0) + amount;
      u.redeemLog = { ...(u.redeemLog || {}), [code]: new Date().toISOString() };
      await saveUser(u);
    } catch (e) { if (once) await releaseGlobalCode(code); throw e; }
    return { code, coins: amount, points: u.points, reusable: false };
  });
}

/* ───────────────────────── AI providers ───────────────────────── */
function extractAudio(data) {
  for (const step of [...(data?.steps || [])].reverse())
    for (const c of [...(step?.content || [])].reverse())
      if (c?.type === 'audio' && c?.data) return { audioBase64: c.data, mimeType: c.mime_type || c.mimeType || 'audio/wav' };
  if (data?.output_audio?.data) return { audioBase64: data.output_audio.data, mimeType: data.output_audio.mime_type || 'audio/wav' };
  return null;
}
async function geminiText(prompt, model = 'gemini-3.8-flash') {
  if (!GEMINI_API_KEY) throw new Error('Gemini غير مضبوط على الخادم.');
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': GEMINI_API_KEY },
    body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: prompt }] }] }),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d?.error?.message || `Gemini (${r.status})`);
  return d?.candidates?.[0]?.content?.parts?.map(x => x.text || '').join('') || '';
}
async function xkiroText(prompt, model = 'qwen/qwen3.8-omni-flash:free') {
  if (!XKIRO_API_KEY) throw new Error('xKiro غير مضبوط على الخادم.');
  const r = await fetch('https://api.xkiro.com/v1/chat/completions', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${XKIRO_API_KEY}` },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }], stream: false, max_tokens: 8000 }),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d?.error?.message || `xKiro (${r.status})`);
  return d?.choices?.[0]?.message?.content || d?.choices?.[0]?.text || '';
}
async function xkiroImage(prompt, size = '1024x1024') {
  if (!XKIRO_API_KEY) throw new Error('xKiro غير مضبوط على الخادم.');
  const r = await fetch('https://api.xkiro.com/v1/images/generations', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${XKIRO_API_KEY}` },
    body: JSON.stringify({ model: 'sensenova/sensenova-u1.5-lite', prompt, n: 1, size }),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d?.error?.message || `xKiro image (${r.status})`);
  if (d?.data?.[0]?.url) return d.data[0].url;
  if (d?.id) {
    for (let i = 0; i < 30; i++) {
      await new Promise(res => setTimeout(res, 2000));
      const p = await fetch(`https://api.xkiro.com/v1/images/generations/${encodeURIComponent(d.id)}`, { headers: { Authorization: `Bearer ${XKIRO_API_KEY}` } });
      const q = await p.json().catch(() => ({}));
      if (q?.status === 'succeeded' && q.data?.[0]?.url) return q.data[0].url;
      if (q?.status === 'failed' || q?.status === 'blocked') throw new Error(typeof q?.error === 'string' ? q.error : q?.error?.message || 'فشل توليد الصورة');
    }
  }
  throw new Error('xKiro لم يُرجع صورة.');
}
async function geminiImage(prompt) {
  if (!GEMINI_API_KEY) throw new Error('Gemini غير مضبوط على الخادم.');
  const r = await fetch('https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-image:generateContent', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': GEMINI_API_KEY },
    body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: prompt }] }] }),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d?.error?.message || `Gemini image (${r.status})`);
  const part = d?.candidates?.[0]?.content?.parts?.find(p => p.inlineData?.data || p.inline_data?.data);
  if (part) { const x = part.inlineData || part.inline_data; return `data:${x.mimeType || x.mime_type || 'image/jpeg'};base64,${x.data}`; }
  throw new Error('Gemini لم يُرجع صورة.');
}

const ltxJobs = new Map();
setInterval(() => { const old = Date.now() - 24 * 3600_000; for (const [k, j] of ltxJobs) if (j.ts < old) ltxJobs.delete(k); }, 3600_000).unref();
const ltxMsg = (data, r, label) => (typeof data?.error === 'string' ? data.error : data?.error?.message) || data?.message || `${label} (${r.status})`;

/* ───────────────────────── config ───────────────────────── */
function publicConfig() {
  const googleReady = !!(firebaseReady() && FIREBASE_WEB_API_KEY && FIREBASE_AUTH_DOMAIN && FIREBASE_APP_ID);
  return {
    phonePasswordReady: true,
    persistentStorage: !!db,
    googleReady,
    ...(googleReady ? { firebase: { apiKey: FIREBASE_WEB_API_KEY, authDomain: FIREBASE_AUTH_DOMAIN, projectId: process.env.FIREBASE_PROJECT_ID, appId: FIREBASE_APP_ID } } : {}),
  };
}

/* ───────────────────────── routes ───────────────────────── */
const INDEX_FILE = path.join(__dirname, 'index.html');

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'OPTIONS') return send(res, 204, {});
    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname;
    const M = req.method;

    if (M === 'GET' && p === '/api/config') return send(res, 200, publicConfig());

    if (M === 'GET' && p === '/api/health') {
      let admin = false;
      try { admin = (await userFromReq(req)).admin; } catch { /* anonymous */ }
      return send(res, 200, {
        ok: true, googleReady: publicConfig().googleReady, persistentStorage: !!db,
        ...(admin ? { geminiConfigured: !!GEMINI_API_KEY, ltxConfigured: !!LTX_API_KEY, xkiroConfigured: !!XKIRO_API_KEY } : {}),
      });
    }

    /* ----- auth ----- */
    if (M === 'POST' && p === '/api/auth/register') {
      rateLimit('reg:' + clientIp(req), 10, 60 * 60_000);
      const b = await body(req);
      const phone = normalizePhone(b.phone), password = String(b.password || '');
      const name = String(b.name || 'عضو الهلال AI').trim().slice(0, 80) || 'عضو الهلال AI';
      if (ADMIN_PHONE && phone === ADMIN_PHONE) return send(res, 403, { error: 'رقم المالك مخصص لحساب الإدارة. اضبط ADMIN_INITIAL_PASSWORD على السيرفر ثم سجّل الدخول.' });
      if (!/^01[0125]\d{8}$/.test(phone)) return send(res, 400, { error: 'أدخل رقم هاتف مصري صحيح.' });
      if (password.length < 6) return send(res, 400, { error: 'كلمة المرور يجب أن تكون 6 أحرف أو أكثر.' });
      if (password.length > 200) return send(res, 400, { error: 'كلمة المرور طويلة جدًا.' });
      const uid = 'phone_' + phone;
      if (await getUser(uid)) return send(res, 409, { error: 'هذا الرقم مسجل بالفعل. سجّل الدخول بدلًا من إنشاء حساب جديد.' });
      await bindBrowser(b.browserId, uid); // قبل الحفظ حتى لا يبقى حساب يتيم إذا فشل الربط
      const ph = await hashPassword(password);
      const u = {
        uid, phone, email: phone + '@phone.local', name, points: 100, createdAt: new Date().toISOString(),
        used: { video: 0, voice: 0 }, passwordHash: ph.hash, passwordSalt: ph.salt, admin: false,
      };
      await saveUser(u);
      return send(res, 200, { token: makeToken(uid), user: publicUser(u) });
    }

    if (M === 'POST' && p === '/api/auth/google') {
      rateLimit('google:' + clientIp(req), 30, 15 * 60_000);
      const b = await body(req);
      const idToken = String(b.idToken || '').trim();
      if (!idToken) return send(res, 400, { error: 'لم يصل رمز Google.' });
      if (!db || !firebaseReady()) return send(res, 503, { error: 'Google غير مفعّل على السيرفر. أضف إعدادات Firebase Admin أولًا.' });
      let decoded;
      try { decoded = await getAuth().verifyIdToken(idToken); }
      catch (e) { return send(res, 401, { error: 'تعذر التحقق من حساب Google: ' + (e?.message || 'رمز غير صالح') }); }
      const uid = decoded.uid, email = String(decoded.email || '').trim().toLowerCase();
      const name = String(decoded.name || decoded.email || 'عضو الهلال AI').slice(0, 80);
      let u = await getUser(uid);
      const adminByEmail = !!(ADMIN_EMAIL && email === ADMIN_EMAIL && decoded.email_verified);
      if (!u) {
        u = { uid, email, name, phone: decoded.phone_number || '', points: 100, createdAt: new Date().toISOString(), used: { video: 0, voice: 0 }, admin: adminByEmail };
      } else {
        u.email = email || u.email || '';
        u.name = name || u.name || 'عضو الهلال AI';
        if (adminByEmail) u.admin = true;
      }
      if (!isAdminUser(u)) await bindBrowser(b.browserId, uid);
      await saveUser(u);
      return send(res, 200, { token: makeToken(uid), user: publicUser(u) });
    }

    if (M === 'POST' && p === '/api/auth/login') {
      const ip = clientIp(req);
      rateLimit('login-ip:' + ip, 30, 15 * 60_000);
      const b = await body(req);
      const phone = normalizePhone(b.phone), password = String(b.password || '');
      rateLimit('login-phone:' + phone, 10, 15 * 60_000);
      const uid = 'phone_' + phone;
      let u = await getUser(uid);
      const isOwner = ADMIN_PHONE && phone === ADMIN_PHONE;
      if (!u && isOwner && ADMIN_INITIAL_PASSWORD && safeEqual(password, ADMIN_INITIAL_PASSWORD)) {
        const ph = await hashPassword(password);
        u = {
          uid, phone, email: phone + '@phone.local', name: 'مالك هلال AI', points: 100000, createdAt: new Date().toISOString(),
          used: { video: 0, voice: 0 }, passwordHash: ph.hash, passwordSalt: ph.salt, admin: true,
        };
        await saveUser(u);
      }
      if (!u || !u.passwordHash || !(await verifyPassword(password, u.passwordSalt, u.passwordHash)))
        return send(res, 401, { error: 'رقم الهاتف أو كلمة المرور غير صحيحة.' });
      if (isOwner && !u.admin) { u.admin = true; u.points = Math.max(Number(u.points) || 0, 100000); await saveUser(u); }
      if (!isAdminUser(u)) await bindBrowser(b.browserId, u.uid);
      return send(res, 200, { token: makeToken(u.uid), user: publicUser(u) });
    }

    if (M === 'GET' && p === '/api/me') {
      const d = await userFromReq(req);
      const u = await getUser(d.uid);
      return send(res, 200, { user: { ...publicUser(u), admin: d.admin } });
    }

    /* ----- projects ----- */
    if (M === 'GET' && p === '/api/projects') {
      const d = await userFromReq(req);
      return send(res, 200, { projects: await listProjects(d.uid) });
    }
    if (M === 'POST' && p === '/api/projects') {
      const d = await userFromReq(req);
      const b = await body(req);
      const rec = {
        id: safeId(b.id),
        type: String(b.type || 'chat').slice(0, 30),
        name: String(b.name || 'مشروع الهلال AI').slice(0, 200),
        desc: String(b.desc || '').slice(0, 1000),
        icon: String(b.icon || '📁').slice(0, 8),
        data: b.data ?? null,
        createdAt: String(b.createdAt || new Date().toISOString()),
        date: String(b.date || new Date().toLocaleString('ar-EG')),
      };
      return send(res, 200, { project: await saveProject(d.uid, rec) });
    }
    if (M === 'DELETE' && p.startsWith('/api/projects/')) {
      const d = await userFromReq(req);
      await deleteProjectStore(d.uid, safeId(decodeURIComponent(p.split('/').pop())));
      return send(res, 200, { ok: true });
    }

    /* ----- payments / coins ----- */
    if (M === 'POST' && p === '/api/payments/vodafone') {
      const d = await userFromReq(req), b = await body(req);
      return send(res, 200, { payment: await createPayment(d.uid, d.email, b) });
    }
    if (M === 'GET' && p === '/api/payments/mine') {
      const d = await userFromReq(req);
      return send(res, 200, { payments: await listPaymentsByUid(d.uid) });
    }
    if (M === 'POST' && p === '/api/redeem-code') {
      const d = await userFromReq(req), b = await body(req);
      rateLimit('redeem-user:' + d.uid, 15, 10 * 60_000);
      rateLimit('redeem-ip:' + clientIp(req), 40, 60 * 60_000);
      return send(res, 200, { ok: true, ...(await redeemCode(d.uid, b.code)) });
    }
    if (M === 'GET' && p === '/api/admin/payments') {
      await requireAdmin(req);
      return send(res, 200, { payments: await listPayments() });
    }
    if (M === 'POST' && p === '/api/admin/payments/approve') {
      const d = await requireAdmin(req), b = await body(req);
      const rec = await reviewPayment(String(b.id || ''), !!b.approve, d.email || d.phone);
      return send(res, 200, { ok: true, status: rec.status });
    }

    /* ----- AI ----- */
    if (M === 'POST' && p === '/api/ai/chat') {
      const d = await userFromReq(req);
      rateLimit('chat:' + d.uid, 30, 60_000);
      const b = await body(req);
      const prompt = String(b.prompt || '').trim();
      if (!prompt) return send(res, 400, { error: 'اكتب رسالة أولًا.' });
      if (prompt.length > 80_000) return send(res, 413, { error: 'النص طويل جدًا.' });
      const model = String(b.model || 'xkiro:qwen/qwen3.8-omni-flash:free');
      let reply;
      if (model.startsWith('gemini:')) {
        const m = model.slice(7);
        if (!/^[\w.\-]{1,80}$/.test(m)) return send(res, 400, { error: 'اسم النموذج غير صالح.' });
        reply = await geminiText(prompt, m);
      } else {
        const m = model.startsWith('xkiro:') ? model.slice(6) : model;
        if (!/^[\w.\-/:]{1,120}$/.test(m)) return send(res, 400, { error: 'اسم النموذج غير صالح.' });
        reply = await xkiroText(prompt, m);
      }
      return send(res, 200, { reply });
    }

    if (M === 'POST' && p === '/api/image/generate') {
      const d = await userFromReq(req);
      rateLimit('img:' + d.uid, 20, 60_000);
      const b = await body(req);
      const prompt = String(b.prompt || '').trim().slice(0, 4000);
      if (!prompt) return send(res, 400, { error: 'اكتب وصف الصورة أولًا.' });
      const size = /^\d{3,4}x\d{3,4}$/.test(String(b.size || '')) ? b.size : '1024x1024';
      let url, firstErr;
      if (XKIRO_API_KEY) { try { url = await xkiroImage(prompt, size); } catch (e) { firstErr = e; } }
      if (!url) {
        try { url = await geminiImage(prompt); }
        catch (e) { throw new Error(firstErr ? `${firstErr.message} | ${e.message}` : e.message); }
      }
      return send(res, 200, { url });
    }

    if (M === 'POST' && p === '/api/tts') {
      const d = await userFromReq(req);
      const b = await body(req);
      if (!GEMINI_API_KEY) return send(res, 503, { error: 'Gemini TTS غير مضبوط على الخادم.' });
      if (!b.input) return send(res, 400, { error: 'لا يوجد نص.' });
      const payload = {
        model: /^gemini-[\w.\-]*tts[\w.\-]*$/.test(String(b.model || '')) ? b.model : 'gemini-3.8-flash-tts',
        input: b.input,
        response_format: b.response_format || { type: 'audio' },
        ...(b.generation_config ? { generation_config: b.generation_config } : {}),
      };
      const u = await charge(d.uid, 1, 'voice');
      try {
        const r = await fetch('https://generativelanguage.googleapis.com/v1beta/interactions', {
          method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': GEMINI_API_KEY }, body: JSON.stringify(payload),
        });
        const data = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(data?.error?.message || 'Gemini TTS error');
        const audio = extractAudio(data);
        if (!audio) throw new Error('Gemini لم يرجع ملفًا صوتيًا.');
        return send(res, 200, { ...audio, points: u.points });
      } catch (e) {
        const back = await refund(d.uid, 1, 'voice').catch(() => u);
        return send(res, 500, { error: e.message, refunded: true, points: back.points });
      }
    }

    if (M === 'POST' && p === '/api/ltx/video') {
      const d = await userFromReq(req);
      const b = await body(req);
      const prompt = String(b.prompt || '').trim().slice(0, 6000);
      if (!prompt) return send(res, 400, { error: 'اكتب وصف الفيديو أولًا.' });
      if (!LTX_API_KEY) return send(res, 503, { error: 'LTX_API_KEY غير مضبوط على الخادم.' });
      const model = /^ltx-[\w.\-]+$/.test(String(b.model || '')) ? b.model : 'ltx-2-5-pro';
      const resolution = /^\d{3,4}x\d{3,4}$/.test(String(b.resolution || '')) ? b.resolution : '1280x720';
      const duration = Math.min(100, Math.max(1, Number(b.duration) || 8));
      const u = await charge(d.uid, 1, 'video');
      try {
        const r = await fetch('https://api.ltx.io/v2/text-to-video', {
          method: 'POST', headers: { Authorization: `Bearer ${LTX_API_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ prompt, model, duration, resolution }),
        });
        const data = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(ltxMsg(data, r, 'LTX'));
        if (data?.id) ltxJobs.set(String(data.id), { uid: d.uid, refunded: false, ts: Date.now() });
        return send(res, 200, { ...data, points: u.points });
      } catch (e) {
        const back = await refund(d.uid, 1, 'video').catch(() => u);
        return send(res, 500, { error: e.message, refunded: true, points: back.points });
      }
    }

    if (M === 'POST' && p === '/api/ltx/job') {
      const d = await userFromReq(req);
      const b = await body(req);
      const jobId = String(b.jobId || '');
      if (!/^[\w\-]{4,100}$/.test(jobId)) return send(res, 400, { error: 'رقم المهمة غير صالح.' });
      if (!LTX_API_KEY) return send(res, 503, { error: 'LTX_API_KEY غير مضبوط على الخادم.' });
      const r = await fetch(`https://api.ltx.io/v2/text-to-video/${encodeURIComponent(jobId)}`, { headers: { Authorization: `Bearer ${LTX_API_KEY}` } });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) return send(res, r.status, { error: ltxMsg(data, r, 'LTX job') });
      if (data?.status === 'failed') {
        const j = ltxJobs.get(jobId);
        if (j && j.uid === d.uid && !j.refunded) {
          j.refunded = true;
          try { const u = await refund(d.uid, 1, 'video'); data.refunded = true; data.points = u.points; } catch { j.refunded = false; }
        }
      }
      return send(res, 200, data);
    }

    /* ----- static ----- */
    if (p.startsWith('/api/')) return send(res, 404, { error: 'المسار غير موجود.' });
    if ((M === 'GET' || M === 'HEAD') && p === '/favicon.ico') return send(res, 204, {});
    if (M === 'GET' || M === 'HEAD') {
      if (!fs.existsSync(INDEX_FILE)) return send(res, 404, { error: 'Not found' });
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' });
      if (M === 'HEAD') return res.end();
      return fs.createReadStream(INDEX_FILE).pipe(res);
    }
    send(res, 405, { error: 'Method not allowed' });
  } catch (e) {
    if (!res.headersSent) send(res, e.status || 500, { error: e.message || String(e) });
    else res.end();
  }
});

process.on('unhandledRejection', e => console.error('unhandledRejection', e));
server.listen(PORT, '0.0.0.0', () => console.log(`الهلال AI running on port ${PORT}`));
