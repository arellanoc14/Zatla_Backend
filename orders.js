// Real checkout: a Stripe PaymentIntent per order, confirmed with an embedded
// Stripe Payment Element on /checkout, and a webhook that's the only thing
// that ever marks an order paid (never the client's "it worked" callback —
// that can be spoofed or dropped). On payment_intent.succeeded the webhook
// emails a confirmation through Resend and, best-effort, syncs a QuickBooks
// Sales Receipt (see quickbooks.js) — a sync failure never blocks the order.
//
// Environment variables (set on the hosting service):
//   STRIPE_SECRET_KEY     starts with sk_test_ or sk_live_
//   STRIPE_WEBHOOK_SECRET starts with whsec_ — from the Stripe Dashboard's
//                         webhook endpoint for POST <site>/api/orders/stripe-webhook
//   PUBLIC_URL             optional, see shares.js
// The client also needs VITE_STRIPE_PUBLISHABLE_KEY (pk_test_/pk_live_) baked
// in at build time — it isn't secret, so it's a normal Vite env var, not one
// of these.
import crypto from "node:crypto";
import express from "express";
import Stripe from "stripe";
import { db } from "./db.js";
import { sendEmail, escapeHtml } from "./resend.js";
import { rateLimit } from "./rateLimit.js";
import { PRODUCT, formatPrice } from "./src/lib/product.js";
import { syncOrderToQuickBooks } from "./quickbooks.js";

const MAX_QTY = 200; // per line item; a sane ceiling, not a real inventory limit
const EMAIL_RE = /^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/;

// The only prices an order can ever be built from — never trust a client-sent
// amount. "ucl" is deliberately left out until chris gives its price; sending
// it is rejected the same as any other unknown sku.
const CATALOG = {
  grow_light: { name: PRODUCT.name, unitCents: Math.round(PRODUCT.price * 100) },
};

function cleanShipping(s) {
  s = s && typeof s === "object" ? s : {};
  const line1 = String(s.line1 || "").trim().slice(0, 200);
  const line2 = String(s.line2 || "").trim().slice(0, 200);
  const city = String(s.city || "").trim().slice(0, 100);
  const state = String(s.state || "").trim().slice(0, 100);
  const postalCode = String(s.postalCode || "").trim().slice(0, 20);
  const country = String(s.country || "US").trim().slice(0, 2).toUpperCase();
  if (!line1 || !city || !state || !postalCode) {
    throw Object.assign(new Error("Enter a complete shipping address."), { status: 400 });
  }
  return { line1, line2, city, state, postalCode, country };
}

function priceItems(rawItems) {
  const items = Array.isArray(rawItems) ? rawItems : [];
  if (!items.length) throw Object.assign(new Error("Your cart is empty."), { status: 400 });
  const priced = [];
  for (const it of items) {
    const sku = String(it?.sku || "");
    const product = CATALOG[sku];
    if (!product) throw Object.assign(new Error(`"${sku}" isn't something we sell.`), { status: 400 });
    const qty = Math.round(Number(it?.qty));
    if (!Number.isFinite(qty) || qty <= 0 || qty > MAX_QTY) {
      throw Object.assign(new Error(`Quantity for ${product.name} must be between 1 and ${MAX_QTY}.`), { status: 400 });
    }
    priced.push({ sku, name: product.name, qty, unitCents: product.unitCents });
  }
  const amountCents = priced.reduce((sum, it) => sum + it.unitCents * it.qty, 0);
  return { items: priced, amountCents };
}

function orderConfirmationEmail({ order }) {
  const rows = order.items.map((it) => `
    <tr>
      <td style="padding:8px 0;color:#24302a">${escapeHtml(it.name)} × ${it.qty}</td>
      <td style="padding:8px 0;text-align:right;color:#24302a">${formatPrice((it.unitCents * it.qty) / 100)}</td>
    </tr>`).join("");
  return `<!doctype html><html><body style="margin:0;background:#eef1ef;font-family:Arial,Helvetica,sans-serif">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="padding:32px 12px"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#ffffff;border-radius:14px;padding:32px">
<tr><td>
<p style="margin:0 0 6px;font-size:12px;letter-spacing:3px;font-weight:bold;color:#1f9d55">ZATLA</p>
<h1 style="margin:0 0 16px;font-size:22px;color:#111">Thanks for your order</h1>
<p style="margin:0 0 20px;color:#3a4540;line-height:1.5">We're getting it ready to ship.</p>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-top:1px solid #e6e9e7;border-bottom:1px solid #e6e9e7;margin:0 0 16px">${rows}
<tr><td style="padding:12px 0 0;font-weight:bold;color:#111">Total</td><td style="padding:12px 0 0;text-align:right;font-weight:bold;color:#111">${formatPrice(order.amountCents / 100)}</td></tr>
</table>
<p style="margin:0;font-size:13px;color:#7a847f;line-height:1.5">Shipping to:<br>${escapeHtml(order.shipping.line1)}${order.shipping.line2 ? `, ${escapeHtml(order.shipping.line2)}` : ""}<br>${escapeHtml(order.shipping.city)}, ${escapeHtml(order.shipping.state)} ${escapeHtml(order.shipping.postalCode)}</p>
</td></tr></table></td></tr></table></body></html>`;
}

export function mountOrders(app) {
  const router = express.Router();
  const stripe = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;

  let ready = null;
  const pool = () => {
    const p = db();
    if (!p) return Promise.reject(Object.assign(new Error("Checkout is not set up yet (no database)."), { status: 503 }));
    ready = ready || p.query(`
      CREATE TABLE IF NOT EXISTS orders (
        id                      UUID PRIMARY KEY,
        created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
        status                  TEXT NOT NULL DEFAULT 'pending', -- pending | paid | failed
        stripe_payment_intent_id TEXT UNIQUE,
        customer_name           TEXT NOT NULL,
        customer_email          TEXT NOT NULL,
        shipping                JSONB NOT NULL,
        items                   JSONB NOT NULL,
        amount_cents            INTEGER NOT NULL,
        currency                TEXT NOT NULL DEFAULT 'usd',
        qb_synced_at            TIMESTAMPTZ,
        qb_error                TEXT
      );
      CREATE INDEX IF NOT EXISTS orders_stripe_pi ON orders (stripe_payment_intent_id);
    `).catch((e) => { ready = null; throw e; });
    return ready.then(() => p);
  };

  const fail = (res, e) => {
    const status = e.status || 500;
    if (status >= 500) console.error("[orders]", e.message || e);
    res.status(status).json({ success: false, error: status >= 500 && !e.status ? "Something went wrong. Please try again." : e.message });
  };

  // Create a PaymentIntent for the posted cart → { clientSecret, orderId, amount }.
  router.post("/create-intent", rateLimit(30, 60 * 60 * 1000), express.json({ limit: "32kb" }), async (req, res) => {
    try {
      if (!stripe) throw Object.assign(new Error("Checkout is not set up yet."), { status: 503 });
      const name = String(req.body?.name || "").trim().slice(0, 200);
      const email = String(req.body?.email || "").trim().toLowerCase().slice(0, 254);
      if (!name) throw Object.assign(new Error("Enter your name."), { status: 400 });
      if (!EMAIL_RE.test(email)) throw Object.assign(new Error("Enter a valid email address."), { status: 400 });
      const shipping = cleanShipping(req.body?.shipping);
      const { items, amountCents } = priceItems(req.body?.items);
      if (amountCents < 50) throw Object.assign(new Error("Order total is too small to charge."), { status: 400 });

      const orderId = crypto.randomUUID();
      const p = await pool();
      await p.query(
        `INSERT INTO orders (id, customer_name, customer_email, shipping, items, amount_cents)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [orderId, name, email, shipping, JSON.stringify(items), amountCents],
      );

      const intent = await stripe.paymentIntents.create({
        amount: amountCents,
        currency: "usd",
        automatic_payment_methods: { enabled: true },
        receipt_email: email,
        metadata: { orderId },
      });
      await p.query("UPDATE orders SET stripe_payment_intent_id = $1 WHERE id = $2", [intent.id, orderId]);

      res.json({ success: true, clientSecret: intent.client_secret, orderId, amount: amountCents });
    } catch (e) { fail(res, e); }
  });

  // Order summary for the success page → { status, items, amount, shipping }.
  router.get("/:id", rateLimit(120, 60 * 60 * 1000), async (req, res) => {
    try {
      const id = String(req.params.id || "");
      if (!/^[0-9a-f-]{36}$/i.test(id)) throw Object.assign(new Error("Order not found."), { status: 404 });
      const p = await pool();
      const r = await p.query(
        "SELECT status, items, amount_cents, shipping, customer_email FROM orders WHERE id = $1",
        [id],
      );
      if (!r.rows.length) throw Object.assign(new Error("Order not found."), { status: 404 });
      const o = r.rows[0];
      res.json({
        success: true,
        status: o.status,
        items: o.items,
        amount: o.amount_cents,
        shipping: o.shipping,
        email: o.customer_email,
      });
    } catch (e) { fail(res, e); }
  });

  // Stripe calls this directly; it needs the raw body to verify the
  // signature, so it must NOT go through express.json(). This is the only
  // thing that ever marks an order paid.
  router.post("/stripe-webhook", express.raw({ type: "application/json", limit: "256kb" }), async (req, res) => {
    if (!stripe || !process.env.STRIPE_WEBHOOK_SECRET) return res.status(503).end();
    let event;
    try {
      event = stripe.webhooks.constructEvent(req.body, req.headers["stripe-signature"], process.env.STRIPE_WEBHOOK_SECRET);
    } catch (e) {
      console.error("[orders] bad webhook signature", e.message);
      return res.status(400).send(`Webhook Error: ${e.message}`);
    }

    try {
      if (event.type === "payment_intent.succeeded" || event.type === "payment_intent.payment_failed") {
        const pi = event.data.object;
        const status = event.type === "payment_intent.succeeded" ? "paid" : "failed";
        const p = await pool();
        const r = await p.query(
          "UPDATE orders SET status = $1 WHERE stripe_payment_intent_id = $2 AND status = 'pending' RETURNING *",
          [status, pi.id],
        );
        // No row updated = already handled (Stripe retries webhooks) or unknown PI; either way, nothing more to do.
        if (r.rows.length && status === "paid") {
          const order = r.rows[0];
          const items = order.items;
          const built = {
            id: order.id,
            items,
            amountCents: order.amount_cents,
            shipping: order.shipping,
            customerName: order.customer_name,
            customerEmail: order.customer_email,
          };

          sendEmail({
            to: order.customer_email,
            subject: "Your ZATLA order is confirmed",
            html: orderConfirmationEmail({ order: built }),
            text: `Thanks for your order. Total: ${formatPrice(order.amount_cents / 100)}.`,
          }).catch((e) => console.error("[orders] confirmation email failed", order.id, e.message));

          syncOrderToQuickBooks(built)
            .then((qb) => p.query("UPDATE orders SET qb_synced_at = now(), qb_error = NULL WHERE id = $1", [order.id]).catch(() => {}).then(() => qb))
            .catch((e) => {
              console.error("[orders] QuickBooks sync failed", order.id, e.message);
              p.query("UPDATE orders SET qb_error = $1 WHERE id = $2", [String(e.message || e).slice(0, 500), order.id]).catch(() => {});
            });
        }
      }
    } catch (e) {
      console.error("[orders] webhook handling failed", e.message);
      // Still 200 — we don't want Stripe hammering retries over our own bug;
      // the error is logged and, for the paid-order case, visible on the row.
    }
    res.json({ received: true });
  });

  app.use("/api/orders", router);
}
