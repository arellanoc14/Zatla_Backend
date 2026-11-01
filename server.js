import express from 'express';
import cors from 'cors';

const app = express();
const PORT = process.env.PORT || 3001;
const allowedOrigins = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);

app.use(cors({ origin: allowedOrigins }));

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
