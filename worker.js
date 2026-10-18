// Cloudflare Worker: Gemini proxy + تحقق من توكن Firebase + فحص حالة الحساب + حد لكل طالب
//
// Secrets : GEMINI_KEY
// Vars    : PROJECT_ID = learn-with-me-b8b81
//           ORIGIN     = https://دومينك   (ممكن أكتر من دومين مفصولين بفاصلة، مثلاً مع www)
// اختياري : OWNER_EMAIL  (الافتراضي markogorge18@gmail.com)
//           RATE_PER_MIN (الافتراضي 12)
//           MAX_BODY     (الافتراضي 150000 حرف)
//           CHECK_USER=off  لإيقاف فحص الحساب (موافَق عليه / غير محظور / غير ممنوع من Learn Ai)

const JWK_URL = 'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com';
const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions';

const hits = new Map();      // uid -> [timestamps]  (العدّاد لكل نسخة Worker، مش عام على الكل)
const verdicts = new Map();  // uid -> { ok, until } (نتيجة فحص الحساب بتتخزن دقيقة)
let jwks = { keys: [], at: 0 };

const b64 = s => {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  return Uint8Array.from(atob(s), c => c.charCodeAt(0));
};
const part = s => JSON.parse(new TextDecoder().decode(b64(s)));

async function getKeys(force) {
  const fresh = Date.now() - jwks.at < 3600e3;
  // تحديث إجباري (kid جديد) مسموح مرة كل دقيقة بس، عشان محدش يضرب جوجل بتوكنات عشوائية من خلالنا
  if (jwks.keys.length && (force ? Date.now() - jwks.at < 60e3 : fresh)) return jwks.keys;
  const r = await fetch(JWK_URL, { cf: { cacheTtl: 3600 } });
  if (!r.ok) throw new Error('jwk');
  jwks = { keys: (await r.json()).keys || [], at: Date.now() };
  return jwks.keys;
}

async function verify(tok, pid) {
  const p3 = tok.split('.');
  if (p3.length !== 3) throw new Error('bad');
  const [h, p, sig] = p3;
  const head = part(h), pay = part(p);
  if (head.alg !== 'RS256') throw new Error('alg');
  let jwk = (await getKeys(false)).find(k => k.kid === head.kid);
  if (!jwk) jwk = (await getKeys(true)).find(k => k.kid === head.kid);
  if (!jwk) throw new Error('kid');
  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64(sig), new TextEncoder().encode(h + '.' + p));
  const now = Date.now() / 1000;
  if (!ok || pay.aud !== pid || pay.iss !== 'https://securetoken.google.com/' + pid
    || !(pay.exp > now) || pay.iat > now + 300 || typeof pay.sub !== 'string' || !pay.sub) throw new Error('claims');
  return pay;
}

/* قراءة مستند من Firestore بتوكن الطالب نفسه (فقواعد الأمان هي اللي بتحكم) */
async function fsGet(pid, path, tok) {
  const r = await fetch('https://firestore.googleapis.com/v1/projects/' + pid + '/databases/(default)/documents/' + path,
    { headers: { authorization: 'Bearer ' + tok } });
  if (r.status === 200) return { status: 200, f: (await r.json()).fields || {} };
  if (r.status === 404 || r.status === 403) return { status: r.status, f: {} };
  throw new Error('fs' + r.status);
}

/* مين يقدر يستخدم الـ AI: المالك / أدمن المحتوى، أو طالب موافَق عليه وغير محظور وغير ممنوع من Learn Ai */
async function allowed(u, tok, env) {
  if (env.CHECK_USER === 'off') return true;
  const t = Date.now(), hit = verdicts.get(u.sub);
  if (hit && hit.until > t) return hit.ok;
  const pid = env.PROJECT_ID, email = String(u.email || '').toLowerCase();
  const owner = String(env.OWNER_EMAIL || 'markogorge18@gmail.com').toLowerCase();
  let ok = false;
  if (u.email_verified === true && email) {
    if (email === owner) ok = true;
    else {
      const a = await fsGet(pid, 'admins/' + encodeURIComponent(email), tok);
      const role = a.f.role && a.f.role.stringValue;
      if (a.status === 200 && role !== 'guest' && role !== 'community') ok = true;
    }
  }
  if (!ok) {
    const s = await fsGet(pid, 'users/' + encodeURIComponent(u.sub), tok), f = s.f;
    ok = s.status === 200
      && !(f.approved && f.approved.booleanValue === false)
      && !(f.blocked && f.blocked.booleanValue === true)
      && !(f.aiBlocked && f.aiBlocked.booleanValue === true);
  }
  verdicts.set(u.sub, { ok, until: t + (ok ? 60e3 : 15e3) });
  if (verdicts.size > 5000) for (const [k, v] of verdicts) if (v.until < t) verdicts.delete(k);
  return ok;
}

function rateOk(sub, limit) {
  const t = Date.now(), a = (hits.get(sub) || []).filter(x => t - x < 60e3);
  if (a.length >= limit) { hits.set(sub, a); return false; }
  a.push(t); hits.set(sub, a);
  if (hits.size > 5000) for (const [k, v] of hits) if (!v.some(x => t - x < 60e3)) hits.delete(k);
  return true;
}

export default {
  async fetch(req, env) {
    const origins = String(env.ORIGIN || '').split(',').map(s => s.trim()).filter(Boolean);
    const origin = req.headers.get('origin') || '';
    const cors = {
      'access-control-allow-origin': origins.includes(origin) ? origin : (origins[0] || ''),
      'access-control-allow-headers': 'content-type, authorization',
      'access-control-allow-methods': 'POST, OPTIONS',
      'access-control-max-age': '86400',
      vary: 'origin'
    };
    const fail = (status, msg, extra) => new Response(JSON.stringify({ error: { message: msg } }),
      { status, headers: { ...cors, 'content-type': 'application/json', 'cache-control': 'no-store', ...(extra || {}) } });

    if (!origins.length || !env.PROJECT_ID || !env.GEMINI_KEY) return fail(500, 'config');
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (req.method !== 'POST') return fail(405, 'method');
    if (origin && !origins.includes(origin)) return fail(403, 'origin');

    /* 1) التوكن */
    const tok = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
    let u;
    try { u = await verify(tok, env.PROJECT_ID); }
    catch (e) { return e && e.message === 'jwk' ? fail(503, 'auth-unavailable') : fail(401, 'unauthorized'); }

    /* 2) الحد لكل طالب */
    if (!rateOk(u.sub, Number(env.RATE_PER_MIN) || 12)) return fail(429, 'rate', { 'retry-after': '60' });

    /* 3) حالة الحساب */
    try { if (!(await allowed(u, tok, env))) return fail(403, 'forbidden'); }
    catch (e) { return fail(503, 'busy'); }

    /* 4) الطلب: حجم + شكل + موديل. بنبعت لجوجل الحقول المعروفة بس */
    const max = Number(env.MAX_BODY) || 150000;
    if ((Number(req.headers.get('content-length')) || 0) > max) return fail(413, 'big');
    const raw = await req.text();
    if (raw.length > max) return fail(413, 'big');
    let b; try { b = JSON.parse(raw); } catch (e) { return fail(400, 'json'); }
    if (!b || typeof b !== 'object' || !/^gemini-[a-z0-9.-]{1,60}$/.test(String(b.model || ''))) return fail(400, 'bad model');
    const ms = b.messages;
    if (!Array.isArray(ms) || !ms.length || ms.length > 40
      || ms.some(m => !m || !['system', 'user', 'assistant'].includes(m.role) || (typeof m.content !== 'string' && !Array.isArray(m.content)))) return fail(400, 'bad messages');
    const temp = Number.isFinite(Number(b.temperature)) && b.temperature !== null ? Number(b.temperature) : 0.6;
    const out = {
      model: b.model,
      messages: ms.map(m => ({ role: m.role, content: m.content })),
      stream: b.stream === true,
      max_tokens: Math.min(Math.max(parseInt(b.max_tokens, 10) || 1024, 1), 8192),
      temperature: Math.min(Math.max(temp, 0), 2)
    };

    /* 5) جوجل */
    let r;
    try {
      r = await fetch(GEMINI_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer ' + env.GEMINI_KEY },
        body: JSON.stringify(out)
      });
    } catch (e) { return fail(503, 'upstream'); }
    return new Response(r.body, { status: r.status, headers: { ...cors, 'content-type': r.headers.get('content-type') || 'application/json', 'cache-control': 'no-store' } });
  }
};
