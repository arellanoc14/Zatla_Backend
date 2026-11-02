// Thin wrapper around the Resend API, shared by shares.js (design emails)
// and orders.js (order confirmations).
//
// RESEND_API_KEY   Resend API key. Without it, sendEmail() reports "not set up".
// RESEND_FROM      optional, e.g. "ZATLA <designs@zatla.com>". Must be on a
//                   domain verified in Resend. Default: Resend's test sender,
//                   which only delivers to the Resend account's own email.
export async function sendEmail({ to, subject, html, text }) {
  if (!process.env.RESEND_API_KEY) return { ok: false, error: "Email is not set up yet." };
  const from = process.env.RESEND_FROM || "ZATLA <onboarding@resend.dev>";
  let resp;
  try {
    resp = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from, to: [to], subject, html, text }),
    });
  } catch (e) {
    console.error("[resend] couldn't reach Resend", to, e.message);
    return { ok: false, error: "Couldn't reach the email service. Please try again." };
  }
  const body = await resp.json().catch(() => ({}));
  if (!resp.ok) console.error("[resend] Resend refused", to, resp.status, body?.message || body);
  return { ok: resp.ok, error: body?.message };
}

export const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
