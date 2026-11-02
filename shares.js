// Shared 3D designs: stored in Postgres, opened read-only at /view/<token>,
// and emailed through Resend. Mirrors GrowStudios' share flow (a server-made
// token, links that expire after 7 days, up to 5 recipients per email), minus
// the login: ZATLA has none, so the routes are rate-limited per visitor instead.
//
// Railway variables (service zatla-web): DATABASE_URL and the Resend ones
// are documented in db.js and resend.js.
//   PUBLIC_URL       required for email: the site address used in emailed links.
//                    The site is a separate host from this API, so there is no
//                    default; without it the email route answers 503.
import crypto from "node:crypto";
import express from "express";
import { db } from "./db.js";
import { sendEmail, escapeHtml } from "./resend.js";
import { rateLimit } from "./rateLimit.js";

const SHARE_DAYS = 7;
const MAX_RECIPIENTS = 5;
const MAX_MESSAGE = 1000;
const MAX_DESIGN_BYTES = 4 * 1024 * 1024;
const EMAIL_RE = /^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/;
const TOKEN_RE = /^[A-Za-z0-9_-]{20,64}$/;

function emailHtml({ url, message, expires }) {
  const note = message
    ? `<p style="margin:0 0 20px;padding:14px 16px;background:#f3f6f4;border-radius:10px;color:#24302a;white-space:pre-wrap">${escapeHtml(message)}</p>`
    : "";
  return `<!doctype html><html><body style="margin:0;background:#eef1ef;font-family:Arial,Helvetica,sans-serif">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="padding:32px 12px"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#ffffff;border-radius:14px;padding:32px">
<tr><td>
<p style="margin:0 0 6px;font-size:12px;letter-spacing:3px;font-weight:bold;color:#1f9d55">ZATLA</p>
<h1 style="margin:0 0 16px;font-size:22px;color:#111">A grow room design was shared with you</h1>
<p style="margin:0 0 20px;color:#3a4540;line-height:1.5">Open it to walk the room in 3D: the layout, benches, grow lights and under-canopy lights, right in your browser.</p>
${note}
<p style="margin:0 0 24px"><a href="${escapeHtml(url)}" style="display:inline-block;background:#1f9d55;color:#fff;text-decoration:none;font-weight:bold;padding:12px 22px;border-radius:999px">View the 3D design</a></p>
<p style="margin:0;font-size:12px;color:#7a847f;line-height:1.5">This link works until ${escapeHtml(expires)}.<br>${escapeHtml(url)}</p>
</td></tr></table></td></tr></table></body></html>`;
}

export function mountShares(app) {
  const router = express.Router();
  const json = express.json({ limit: MAX_DESIGN_BYTES });

  let ready = null;
  const pool = () => {
    const p = db();
    if (!p) return Promise.reject(Object.assign(new Error("Sharing is not set up yet (no database)."), { status: 503 }));
    ready = ready || p.query(`
      CREATE TABLE IF NOT EXISTS shares (
        token       TEXT PRIMARY KEY,
        design      JSONB NOT NULL,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
        expires_at  TIMESTAMPTZ NOT NULL
      );
      CREATE INDEX IF NOT EXISTS shares_expires_at ON shares (expires_at);
    `).catch((e) => { ready = null; throw e; });
    return ready.then(() => p);
  };

  // Expired shares are deleted hourly; reads also refuse them on their own.
  if (process.env.DATABASE_URL) {
    setInterval(() => {
      pool().then((p) => p.query("DELETE FROM shares WHERE expires_at < now()")).catch(() => {});
    }, 60 * 60 * 1000).unref();
  }

  const fail = (res, e) => {
    const status = e.status || 500;
    if (status >= 500) console.error("[shares]", e.message || e);
    res.status(status).json({ success: false, error: status >= 500 && !e.status ? "Something went wrong. Please try again." : e.message });
  };

  // Create a share of the posted design → { token, expiresAt }.
  router.post("/", rateLimit(20, 60 * 60 * 1000), json, async (req, res) => {
    try {
      const design = req.body?.design;
      if (!design || typeof design !== "object" || Array.isArray(design)) {
        throw Object.assign(new Error("No design to share."), { status: 400 });
      }
      const token = crypto.randomBytes(18).toString("base64url");
      const p = await pool();
      const r = await p.query(
        `INSERT INTO shares (token, design, expires_at) VALUES ($1, $2, now() + interval '${SHARE_DAYS} days') RETURNING expires_at`,
        [token, design],
      );
      res.json({ success: true, token, expiresAt: r.rows[0].expires_at });
    } catch (e) { fail(res, e); }
  });

  // Read a share (the public viewer) → { design, expiresAt } or 404.
  router.get("/:token", rateLimit(240, 60 * 60 * 1000), async (req, res) => {
    try {
      const { token } = req.params;
      if (!TOKEN_RE.test(token)) throw Object.assign(new Error("This share link is no longer available."), { status: 404 });
      const p = await pool();
      const r = await p.query("SELECT design, expires_at FROM shares WHERE token = $1 AND expires_at > now()", [token]);
      if (!r.rows.length) throw Object.assign(new Error("This share link is no longer available."), { status: 404 });
      res.setHeader("Cache-Control", "no-store");
      res.json({ success: true, design: r.rows[0].design, expiresAt: r.rows[0].expires_at });
    } catch (e) { fail(res, e); }
  });

  // Email a share link → { sent: [...] }. Body: { to: [emails], message }.
  router.post("/:token/email", rateLimit(10, 60 * 60 * 1000), express.json({ limit: "16kb" }), async (req, res) => {
    try {
      const { token } = req.params;
      if (!process.env.RESEND_API_KEY || !process.env.PUBLIC_URL) throw Object.assign(new Error("Email is not set up yet."), { status: 503 });
      if (!TOKEN_RE.test(token)) throw Object.assign(new Error("Unknown share link."), { status: 404 });
      const to = [...new Set((Array.isArray(req.body?.to) ? req.body.to : []).map((s) => String(s).trim().toLowerCase()).filter(Boolean))];
      if (!to.length) throw Object.assign(new Error("Add at least one recipient."), { status: 400 });
      if (to.length > MAX_RECIPIENTS) throw Object.assign(new Error(`Up to ${MAX_RECIPIENTS} recipients per email.`), { status: 400 });
      const bad = to.find((x) => !EMAIL_RE.test(x) || x.length > 254);
      if (bad) throw Object.assign(new Error(`"${bad}" doesn't look like an email address.`), { status: 400 });
      const message = String(req.body?.message || "").slice(0, MAX_MESSAGE).trim();

      const p = await pool();
      const r = await p.query("SELECT expires_at FROM shares WHERE token = $1 AND expires_at > now()", [token]);
      if (!r.rows.length) throw Object.assign(new Error("This share link has expired. Create a new one."), { status: 404 });

      const base = process.env.PUBLIC_URL.replace(/\/+$/, "");
      const url = `${base}/view/${token}`;
      const expires = new Date(r.rows[0].expires_at).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "America/Los_Angeles" });

      // One email per recipient, so no one sees the other addresses.
      const results = await Promise.all(to.map(async (addr) => {
        const r2 = await sendEmail({
          to: addr,
          subject: "A ZATLA grow room design was shared with you",
          html: emailHtml({ url, message, expires }),
          text: `A grow room design was shared with you on ZATLA.\n\n${message ? message + "\n\n" : ""}View it in 3D: ${url}\n\nThis link works until ${expires}.`,
        });
        return { addr, ...r2 };
      }));
      const sent = results.filter((x) => x.ok).map((x) => x.addr);
      if (!sent.length) {
        throw Object.assign(new Error(results[0]?.error || "The email service refused the message."), { status: 502 });
      }
      res.json({ success: true, sent, failed: results.filter((x) => !x.ok).map((x) => x.addr) });
    } catch (e) { fail(res, e); }
  });

  app.use("/api/shares", router);
}
