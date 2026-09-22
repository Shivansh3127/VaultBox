import 'dotenv/config';
import express from 'express';
import { ensureBucket } from './lib/minio';
import { prisma } from './lib/prisma';
import filesRouter from './routes/files';

const app = express();
const PORT = parseInt(process.env.PORT ?? '4000', 10);

// ─── Middleware ───────────────────────────────────────────────────────────────
app.use(express.json());

// ─── Health check ─────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'vaultbox-api', timestamp: new Date().toISOString() });
});

// ─── Routes ───────────────────────────────────────────────────────────────────
app.use('/', filesRouter);

// ─── 404 catch-all ────────────────────────────────────────────────────────────
app.use((_req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// ─── Startup ──────────────────────────────────────────────────────────────────
async function start(): Promise<void> {
  try {
    await prisma.$connect();
    console.log('✓ PostgreSQL connected');

    await ensureBucket();

    app.listen(PORT, () => {
      console.log(`✓ VaultBox API listening on http://localhost:${PORT}`);
      console.log(`  POST /upload          — upload a file`);
      console.log(`  GET  /files           — list your files`);
      console.log(`  GET  /files/:id       — download a file`);
    });
  } catch (err) {
    console.error('✗ Failed to start:', err);
    process.exit(1);
  }
}

start();
