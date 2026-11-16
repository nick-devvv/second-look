// Second Look: grade one garment photo with Claude.
// POST { image: <base64 JPEG/PNG/WebP>, media_type } -> { is_clothing, item, category, damage, ... }
// GET -> { live: true|false } (whether ANTHROPIC_API_KEY is set)

const PROMPT = `You are the grading model inside "Second Look", Zara's repair and trade-in service.
Look at the photo of one clothing item and return ONLY a JSON object with these keys:
"is_clothing": true or false,
"item": short lowercase name, max 3 words (e.g. "trench coat", "denim jacket"),
"category": one of ["coat","jacket","jeans","trousers","dress","skirt","knit","shirt","tshirt","shoes","bag","other"],
"damage": the single most important issue, one of ["none","broken zip","missing button","torn hem","split seam","hole","stain","pilling"],
"damage_where": where it is, max 4 words, or "",
"marker": {"x": 0-1, "y": 0-1} the center of the damage as a fraction of image width and height, or null if no damage,
"condition": "A" (like new), "B" (worn but fixable) or "C" (heavily worn),
"note": one friendly sentence for the customer, max 14 words.
No markdown, no extra text.`;

const TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const MAX_B64 = 3_000_000; // ~2.2 MB image

module.exports = async (req, res) => {
  const key = process.env.ANTHROPIC_API_KEY;
  if (req.method === 'GET') return res.status(200).json({ live: Boolean(key) });
  if (req.method !== 'POST') return res.status(405).json({ error: 'method' });
  if (!key) return res.status(503).json({ error: 'no_key' });

  // Only our own page may call this endpoint from a browser.
  const origin = req.headers.origin;
  if (origin) {
    try { if (new URL(origin).host !== req.headers.host) return res.status(403).json({ error: 'origin' }); }
    catch { return res.status(403).json({ error: 'origin' }); }
  }

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  const image = body && body.image;
  const mediaType = TYPES.includes(body && body.media_type) ? body.media_type : 'image/jpeg';
  if (typeof image !== 'string' || image.length < 200 || image.length > MAX_B64) return res.status(400).json({ error: 'bad_image' });

  const models = [process.env.ANTHROPIC_MODEL, 'claude-sonnet-5-5', 'claude-haiku-5-5'].filter(Boolean);
  for (const model of models) {
    let r;
    try {
      r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        body: JSON.stringify({
          model,
          max_tokens: 400,
          messages: [{ role: 'user', content: [
            { type: 'image', source: { type: 'base64', media_type: mediaType, data: image } },
            { type: 'text', text: PROMPT },
          ] }],
        }),
      });
    } catch {
      return res.status(502).json({ error: 'upstream' });
    }
    if (r.status === 429 || r.status === 529) return res.status(429).json({ error: 'rate_limited' });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      if (r.status === 404 || (j.error && j.error.type === 'not_found_error')) continue; // try the next model
      return res.status(502).json({ error: 'upstream', detail: j.error && j.error.type });
    }
    const text = (j.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('');
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) return res.status(502).json({ error: 'parse' });
    try {
      const out = JSON.parse(m[0]);
      out.model = model;
      return res.status(200).json(out);
    } catch {
      return res.status(502).json({ error: 'parse' });
    }
  }
  return res.status(502).json({ error: 'no_model' });
};
