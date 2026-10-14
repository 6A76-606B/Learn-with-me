// Cloudflare Worker: وسيط بين الصفحة وGemini. المفتاح محفوظ كـ Secret باسم GEMINI_KEY
const ALLOWED_ORIGINS = ['https://6a76-606b.github.io'];
const ALLOWED_MODELS = ['gemini-3.8-flash', 'gemini-3.5-flash-lite', 'gemini-2.5-flash'];
const MAX_BODY = 200000;

export default {
  async fetch(req, env) {
    const origin = req.headers.get('Origin') || '';
    const okOrigin = ALLOWED_ORIGINS.includes(origin);
    const cors = {
      'Access-Control-Allow-Origin': okOrigin ? origin : ALLOWED_ORIGINS[0],
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'content-type',
      'Vary': 'Origin'
    };
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (req.method !== 'POST' || !okOrigin) return new Response('forbidden', { status: 403, headers: cors });

    const text = await req.text();
    if (text.length > MAX_BODY) return new Response('too large', { status: 413, headers: cors });
    let body;
    try { body = JSON.parse(text); } catch { return new Response('bad json', { status: 400, headers: cors }); }
    if (!ALLOWED_MODELS.includes(body.model)) return new Response('bad model', { status: 400, headers: cors });
    body.max_tokens = Math.min(body.max_tokens || 4096, 4096);

    const r = await fetch('https://generativelanguage.googleapis.com/v1beta/openai/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'Authorization': 'Bearer ' + env.GEMINI_KEY },
      body: JSON.stringify(body)
    });
    const h = new Headers(cors);
    h.set('content-type', r.headers.get('content-type') || 'application/json');
    return new Response(r.body, { status: r.status, headers: h });
  }
};
