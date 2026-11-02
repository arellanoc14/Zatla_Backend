// One shared Postgres pool for every server-side feature (shares, orders,
// QuickBooks connections) so they don't each open their own pool against the
// hosting provider's connection limit.
//
// DATABASE_URL — the Postgres database's connection string. Until it's set,
// db() returns null and callers decide how to degrade (shares.js and
// orders.js both return a clear "not set up yet" error instead of crashing).
import pg from "pg";

let pool = null;
let warned = false;

export function db() {
  if (!process.env.DATABASE_URL) {
    if (!warned) { console.warn("[db] DATABASE_URL not set — database-backed features are disabled."); warned = true; }
    return null;
  }
  if (!pool) {
    pool = new pg.Pool({
      connectionString: process.env.DATABASE_URL,
      // Only a plain local Postgres (or an explicit sslmode=disable) skips TLS.
      ssl: /localhost|127\.0\.0\.1|sslmode=disable/.test(process.env.DATABASE_URL) ? false : { rejectUnauthorized: false },
      max: 8,
    });
  }
  return pool;
}
