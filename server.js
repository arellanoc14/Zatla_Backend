import express from 'express';
import cors from 'cors';
import { mountShares } from './shares.js';
import { mountOrders } from './orders.js';
import { mountQuickbooks } from './quickbooks.js';

const app = express();
// Render's proxy sits in front: trust one hop for req.ip (rate limits) and
// req.protocol. ponytail: if req.ip on Render turns out to be a proxy address,
// raise the hop count to the measured value; never `true` (clients could fake
// their IP past the rate limits).
app.set('trust proxy', 1);
const PORT = process.env.PORT || 3001;
const allowedOrigins = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);

app.use(cors({ origin: allowedOrigins }));

// Mounted before express.json(): each brings its own body parser (the Stripe
// webhook needs the raw body; shared designs can be up to 4 MB).
// Shared 3D designs + emailing them (shares.js).
mountShares(app);
// Checkout: Stripe PaymentIntents + the webhook that marks orders paid (orders.js).
mountOrders(app);
// QuickBooks connect + Sales Receipt sync, called from orders.js (quickbooks.js).
mountQuickbooks(app);

app.use(express.json());

app.get('/health', (req, res) => res.json({ ok: true }));

// Mock stubs: no real provider calls yet.
// QuickBooks
app.get('/api/quickbooks/customers', (req, res) =>
  res.json({ mock: true, provider: 'quickbooks', customers: [] }));
app.post('/api/quickbooks/invoices', (req, res) =>
  res.json({ mock: true, provider: 'quickbooks', invoice: { id: 'mock-invoice', received: req.body } }));

// Resend
app.post('/api/resend/send', (req, res) =>
  res.json({ mock: true, provider: 'resend', sent: true }));

// Warp
app.post('/api/warp/quote', (req, res) =>
  res.json({ mock: true, provider: 'warp', quote: { id: 'mock-quote', amount: null, received: req.body } }));

app.listen(PORT, () => console.log(`Listening on port ${PORT}`));
