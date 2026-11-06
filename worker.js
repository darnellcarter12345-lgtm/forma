/**
 * FORMA photo recognition Worker — Cloudflare Workers
 * Secret (set via Cloudflare dashboard): GEMINI_API_KEY
 * Optional variable: ALLOWED_ORIGIN, e.g. https://YOURNAME.github.io
 * Route: POST /analyze {"image":"data:image/jpeg;base64,..."}
 * Output: {"name":"...", "serving":"...", "calories":123, "confidence":"low|medium|high"}
 */
export default {
  async fetch(request, env) {
    const allowed = env.ALLOWED_ORIGIN || '*';
    const origin = request.headers.get('Origin') || '';
    const originAllowed = allowed === '*' || origin === allowed;
    const cors = {
      'Access-Control-Allow-Origin': originAllowed ? (allowed === '*' ? '*' : allowed) : 'null',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Vary': 'Origin'
    };
    const respond = (data, status = 200) => new Response(JSON.stringify(data), {
      status,
      headers: { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
    });
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (request.method !== 'POST' || new URL(request.url).pathname !== '/analyze') return respond({ error: 'Not found' }, 404);
    if (!originAllowed) return respond({ error: 'Origin not permitted' }, 403);
    if (!env.GEMINI_API_KEY) return respond({ error: 'Set GEMINI_API_KEY in Worker secrets' }, 500);
    if (Number(request.headers.get('Content-Length') || 0) > 3_000_000) return respond({error:'Image too large'},413);
    let body;
    try { body = await request.json(); } catch { return respond({ error: 'Invalid JSON' }, 400); }
    const match = /^data:(image\/jpeg|image\/png|image\/webp);base64,([\w+/=]+)$/.exec(body?.image || '');
    if (!match || match[2].length > 2_500_000) return respond({ error: 'Image must be a JPEG, PNG, or WEBP data URL under 2.5 MB' }, 400);
    const prompt = `You are estimating the nutritional content of one photographed food or meal. Identify the main foods visible and approximate the full portion's calories. Photos do not allow exact calories or ingredient verification; avoid false precision. If no food is visible or the portion is too uncertain to estimate, return name "Unrecognized food", serving "Unknown portion", calories 0, confidence "low". Return ONLY a JSON object with exactly name (short food description), serving (portion estimate), calories (nonnegative integer), confidence (low, medium, high). Do not propose diets, calorie targets, or weight-loss advice.`;
    try {
      const res = await fetch('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': env.GEMINI_API_KEY },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: prompt }, { inline_data: { mime_type: match[1], data: match[2] } }] }],
          generationConfig: { responseMimeType: 'application/json', temperature: 0.1 }
        })
      });
      if (!res.ok) return respond({error: `AI service unavailable (${res.status})`}, 502);
      const data = await res.json();
      const raw = data?.candidates?.[0]?.content?.parts?.find(p=>p.text)?.text;
      if (!raw) return respond({error:'No estimate returned'},502);
      const parsed = JSON.parse(raw);
      if (typeof parsed.name !== 'string' || !Number.isFinite(Number(parsed.calories))) return respond({error:'Invalid estimate'},502);
      if (parsed.name === 'Unrecognized food') return respond({error:'Unable to identify food reliably. Enter it manually.'},422);
      return respond({name: parsed.name.slice(0,100),serving: String(parsed.serving||'One portion').slice(0,80),calories: Math.max(0,Math.round(Number(parsed.calories))),confidence:parsed.confidence||'low'});
    } catch (e) { return respond({error:'AI request failed'},502); }
  }
};
