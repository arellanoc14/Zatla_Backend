// QuickBooks: ZATLA's OWN Intuit app and connected company — deliberately
// separate from GrowStudios/GPS's QuickBooks. A paid order becomes a Sales
// Receipt (payment already collected via Stripe, so an Invoice — which
// implies money still owed — would be wrong). Mirrors GrowStudios' OAuth
// conventions: authorization-code flow, a connections table, the most
// recently updated row wins when no realm is given, and a 409 means
// "reconnect" rather than a generic 500.
//
// Environment variables (set on the hosting service):
//   QB_CLIENT_ID       from ZATLA's own Intuit developer app
//   QB_CLIENT_SECRET
//   QB_REDIRECT_URI    e.g. https://<zatla domain>/api/quickbooks/callback —
//                      must be registered on the Intuit app's Redirect URIs
//   QB_USE_SANDBOX     "true" while testing against a sandbox company,
//                      "false" (or unset) for the real connected company
//   QB_CONNECT_TOKEN   a secret you make up. ZATLA has no login system, so
//                      this gates /api/quickbooks/connect — without the
//                      right ?token=, nobody can link a QuickBooks company
//   QB_ITEM_NAME       optional, default "ZATLA Grow Light". Must already
//                      exist as an Item in the connected company with an
//                      income account set — create it there first
import crypto from "node:crypto";
import express from "express";
import { db } from "./db.js";
import { rateLimit } from "./rateLimit.js";

const DISCOVERY_SANDBOX = "https://sandbox-quickbooks.api.intuit.com";
const DISCOVERY_PROD = "https://quickbooks.api.intuit.com";
const TOKEN_URL = "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer";
const AUTH_URL = "https://appcenter.intuit.com/connect/oauth2";

const apiBase = () => (String(process.env.QB_USE_SANDBOX).toLowerCase() === "true" ? DISCOVERY_SANDBOX : DISCOVERY_PROD);

// Escapes a value for QuickBooks' query language. It needs a backslash
// before a single quote, NOT the doubled-quote SQL convention — using the
// wrong one breaks any name with an apostrophe in it (GrowStudios hit this).
const qbEscape = (s) => String(s).replace(/\\/g, "\\\\").replace(/'/g, "\\'");

let ready = null;
function pool() {
  const p = db();
  if (!p) return Promise.reject(Object.assign(new Error("QuickBooks is not set up yet (no database)."), { status: 503 }));
  ready = ready || p.query(`
    CREATE TABLE IF NOT EXISTS qb_connections (
      id                        SERIAL PRIMARY KEY,
      realm_id                  TEXT NOT NULL,
      access_token              TEXT NOT NULL,
      refresh_token             TEXT NOT NULL,
      access_token_expires_at   TIMESTAMPTZ NOT NULL,
      refresh_token_expires_at  TIMESTAMPTZ NOT NULL,
      updated_at                TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `).catch((e) => { ready = null; throw e; });
  return ready.then(() => p);
}

async function latestConnection() {
  const p = await pool();
  const r = await p.query("SELECT * FROM qb_connections ORDER BY updated_at DESC LIMIT 1");
  if (!r.rows.length) throw Object.assign(new Error("QuickBooks isn't connected yet."), { status: 409, code: "QB_REAUTH_REQUIRED" });
  return r.rows[0];
}

async function refreshTokens(row) {
  const basic = Buffer.from(`${process.env.QB_CLIENT_ID}:${process.env.QB_CLIENT_SECRET}`).toString("base64");
  const resp = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: row.refresh_token }),
  });
  const body = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    throw Object.assign(new Error("QuickBooks needs to be reconnected."), { status: 409, code: "QB_REAUTH_REQUIRED", cause: body });
  }
  const p = await pool();
  const now = Date.now();
  const r = await p.query(
    `UPDATE qb_connections SET access_token = $1, refresh_token = $2, access_token_expires_at = $3, refresh_token_expires_at = $4, updated_at = now()
     WHERE id = $5 RETURNING *`,
    [
      body.access_token,
      body.refresh_token || row.refresh_token,
      new Date(now + body.expires_in * 1000),
      new Date(now + (body.x_refresh_token_expires_in || 100 * 24 * 60 * 60) * 1000),
      row.id,
    ],
  );
  return r.rows[0];
}

// A valid { accessToken, realmId }, refreshing first if the access token is
// stale. Throws a 409 QB_REAUTH_REQUIRED if there's no connection, or the
// refresh itself fails (the refresh token expired or was revoked).
async function getAuthContext() {
  let row = await latestConnection();
  if (new Date(row.access_token_expires_at).getTime() - Date.now() < 60_000) {
    row = await refreshTokens(row);
  }
  return { accessToken: row.access_token, realmId: row.realm_id };
}

async function qbFetch(path, { method = "GET", body } = {}) {
  const { accessToken, realmId } = await getAuthContext();
  const url = `${apiBase()}/v3/company/${realmId}${path}${path.includes("?") ? "&" : "?"}minorversion=65`;
  const resp = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    if (resp.status === 401) throw Object.assign(new Error("QuickBooks needs to be reconnected."), { status: 409, code: "QB_REAUTH_REQUIRED" });
    throw Object.assign(new Error(json?.Fault?.Error?.[0]?.Message || "QuickBooks refused the request."), { status: 502, cause: json });
  }
  return json;
}

async function findItemRefByName(name) {
  const q = `SELECT Id, Name FROM Item WHERE Name = '${qbEscape(name)}'`;
  const json = await qbFetch(`/query?query=${encodeURIComponent(q)}`);
  const item = json?.QueryResponse?.Item?.[0];
  if (!item) {
    throw Object.assign(
      new Error(`No QuickBooks item named "${name}". Create it in the connected company first (with an income account set), or set QB_ITEM_NAME to an item that exists.`),
      { status: 422 },
    );
  }
  return { value: item.Id, name: item.Name };
}

async function findOrCreateCustomer(email, name) {
  const q = `SELECT Id FROM Customer WHERE PrimaryEmailAddr = '${qbEscape(email)}'`;
  const found = await qbFetch(`/query?query=${encodeURIComponent(q)}`);
  const existing = found?.QueryResponse?.Customer?.[0];
  if (existing) return { value: existing.Id, name: existing.DisplayName || name };
  const created = await qbFetch("/customer", {
    method: "POST",
    body: { DisplayName: `${name} (${email})`, PrimaryEmailAddr: { Address: email } },
  });
  return { value: created.Customer.Id, name: created.Customer.DisplayName };
}

// Builds a Sales Receipt for a paid order. Each order line item's `name`
// must match a real QuickBooks Item exactly (see QB_ITEM_NAME above). Throws
// on any failure — the caller (orders.js) treats this as best-effort and
// records the error on the order row rather than failing the order itself.
export async function syncOrderToQuickBooks(order) {
  if (!process.env.QB_CLIENT_ID) {
    throw Object.assign(new Error("QuickBooks isn't connected yet."), { status: 409, code: "QB_REAUTH_REQUIRED" });
  }
  const customerRef = await findOrCreateCustomer(order.customerEmail || order.email, order.customerName || order.name || "ZATLA customer");
  const lines = [];
  for (const it of order.items) {
    const itemRef = await findItemRefByName(it.sku === "grow_light" ? (process.env.QB_ITEM_NAME || "ZATLA Grow Light") : it.name);
    const amount = (it.unitCents * it.qty) / 100;
    lines.push({
      DetailType: "SalesItemLineDetail",
      Amount: amount,
      SalesItemLineDetail: { ItemRef: itemRef, Qty: it.qty, UnitPrice: it.unitCents / 100 },
    });
  }
  const shipping = order.shipping || {};
  const receipt = await qbFetch("/salesreceipt", {
    method: "POST",
    body: {
      CustomerRef: customerRef,
      Line: lines,
      ShipAddr: {
        Line1: shipping.line1,
        Line2: shipping.line2 || undefined,
        City: shipping.city,
        CountrySubDivisionCode: shipping.state,
        PostalCode: shipping.postalCode,
        Country: shipping.country,
      },
    },
  });
  return { salesReceiptId: receipt?.SalesReceipt?.Id };
}

export function mountQuickbooks(app) {
  const router = express.Router();
  const pendingStates = new Map(); // state -> expiry ms, for CSRF checking the OAuth callback
  setInterval(() => {
    const now = Date.now();
    for (const [k, exp] of pendingStates) if (exp < now) pendingStates.delete(k);
  }, 10 * 60 * 1000).unref();

  const requireAdmin = (req, res, next) => {
    if (!process.env.QB_CONNECT_TOKEN) return res.status(503).send("QuickBooks connect is not set up yet (QB_CONNECT_TOKEN unset).");
    if (req.query.token !== process.env.QB_CONNECT_TOKEN) return res.status(403).send("Wrong token.");
    next();
  };

  router.get("/connect", rateLimit(10, 60 * 60 * 1000), requireAdmin, (req, res) => {
    if (!process.env.QB_CLIENT_ID || !process.env.QB_REDIRECT_URI) return res.status(503).send("QuickBooks is not configured (QB_CLIENT_ID / QB_REDIRECT_URI).");
    const state = crypto.randomBytes(16).toString("hex");
    pendingStates.set(state, Date.now() + 10 * 60 * 1000);
    const url = new URL(AUTH_URL);
    url.searchParams.set("client_id", process.env.QB_CLIENT_ID);
    url.searchParams.set("redirect_uri", process.env.QB_REDIRECT_URI);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", "com.intuit.quickbooks.accounting");
    url.searchParams.set("state", state);
    res.redirect(url.toString());
  });

  router.get("/callback", async (req, res) => {
    try {
      const { code, state, realmId } = req.query;
      if (!state || !pendingStates.has(String(state))) return res.status(400).send("This QuickBooks connect link expired. Start again.");
      pendingStates.delete(String(state));
      if (!code || !realmId) return res.status(400).send("QuickBooks didn't send back what was expected.");

      const basic = Buffer.from(`${process.env.QB_CLIENT_ID}:${process.env.QB_CLIENT_SECRET}`).toString("base64");
      const resp = await fetch(TOKEN_URL, {
        method: "POST",
        headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
        body: new URLSearchParams({ grant_type: "authorization_code", code: String(code), redirect_uri: process.env.QB_REDIRECT_URI }),
      });
      const body = await resp.json().catch(() => ({}));
      if (!resp.ok) { console.error("[quickbooks] token exchange failed", body); return res.status(502).send("QuickBooks connection failed. Check the server logs."); }

      const now = Date.now();
      const p = await pool();
      await p.query(
        `INSERT INTO qb_connections (realm_id, access_token, refresh_token, access_token_expires_at, refresh_token_expires_at)
         VALUES ($1, $2, $3, $4, $5)`,
        [
          String(realmId),
          body.access_token,
          body.refresh_token,
          new Date(now + body.expires_in * 1000),
          new Date(now + (body.x_refresh_token_expires_in || 100 * 24 * 60 * 60) * 1000),
        ],
      );
      res.send(`QuickBooks connected. Realm ID: ${realmId}. You can close this tab.`);
    } catch (e) {
      console.error("[quickbooks] callback failed", e.message);
      res.status(500).send("Something went wrong connecting QuickBooks. Check the server logs.");
    }
  });

  router.get("/status", requireAdmin, async (req, res) => {
    try {
      const row = await latestConnection();
      res.json({ connected: true, realmId: row.realm_id, sandbox: String(process.env.QB_USE_SANDBOX).toLowerCase() === "true", updatedAt: row.updated_at });
    } catch {
      res.json({ connected: false });
    }
  });

  app.use("/api/quickbooks", router);
}
