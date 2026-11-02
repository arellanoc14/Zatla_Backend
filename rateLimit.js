// Small in-memory limiter shared by shares.js, orders.js and quickbooks.js:
// `limit` hits per `windowMs` per visitor IP. Good enough for a single
// Node process with no login system; resets if the process restarts.
export function rateLimit(limit, windowMs) {
  const hits = new Map();
  setInterval(() => {
    const now = Date.now();
    for (const [k, v] of hits) if (v.reset <= now) hits.delete(k);
  }, windowMs).unref();
  return (req, res, next) => {
    const key = req.ip || "unknown";
    const now = Date.now();
    let h = hits.get(key);
    if (!h || h.reset <= now) { h = { n: 0, reset: now + windowMs }; hits.set(key, h); }
    h.n += 1;
    if (h.n > limit) return res.status(429).json({ success: false, error: "Too many requests. Please try again later." });
    next();
  };
}
