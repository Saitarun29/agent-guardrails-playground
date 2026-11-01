// GET /api/status — tells the UI whether live AI is configured (never exposes the key).
export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method && req.method !== 'GET' && req.method !== 'HEAD') {
    res.setHeader('Allow', 'GET, HEAD');
    return res.status(405).json({ error: 'GET only' });
  }
  return res.status(200).json({ mode: process.env.GEMINI_API_KEY ? 'live' : 'demo', executor: 'gemini-2.0-flash' });
}
