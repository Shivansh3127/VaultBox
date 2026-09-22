import { Router, Request, Response } from 'express';
import busboy from 'busboy';
import { Transform } from 'stream';
import { v4 as uuidv4 } from 'uuid';
import { minioClient, BUCKET_NAME } from '../lib/minio';
import { prisma } from '../lib/prisma';

const router = Router();

// ─── POST /upload ─────────────────────────────────────────────────────────────
// Accepts a multipart/form-data request with a single "file" field.
// Streams bytes directly to MinIO (never buffered in Express memory).
// Records filename, size, owner, storageKey in Postgres.
router.post('/upload', (req: Request, res: Response): void => {
  const owner = (req.headers['x-user-id'] as string | undefined)?.trim();
  if (!owner) {
    res.status(400).json({ error: 'X-User-Id header is required' });
    return;
  }

  const bb = busboy({ headers: req.headers });
  let fileFound = false;
  let responded = false;

  const reply = (status: number, body: unknown) => {
    if (!responded) {
      responded = true;
      res.status(status).json(body);
    }
  };

  bb.on('file', (_fieldname, fileStream, info) => {
    fileFound = true;
    const { filename, mimeType } = info;
    const storageKey = `files/${uuidv4()}/${filename}`;
    let size = 0;

    // Count bytes as they pass through without buffering the whole file
    const sizeCounter = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        size += chunk.length;
        cb(null, chunk);
      },
    });

    const countedStream = fileStream.pipe(sizeCounter);

    minioClient
      .putObject(BUCKET_NAME, storageKey, countedStream, undefined, {
        'Content-Type': mimeType,
      })
      .then(async () => {
        const file = await prisma.file.create({
          data: { filename, size, owner, storageKey, mimeType },
        });
        reply(201, {
          id: file.id,
          filename: file.filename,
          size: file.size,
          owner: file.owner,
          createdAt: file.createdAt,
        });
      })
      .catch((err: Error) => {
        console.error('[upload] MinIO/Prisma error:', err.message);
        reply(500, { error: 'Upload failed' });
      });
  });

  bb.on('finish', () => {
    if (!fileFound && !responded) {
      reply(400, { error: 'No "file" field found in request' });
    }
  });

  bb.on('error', (err: Error) => {
    console.error('[upload] Busboy error:', err.message);
    reply(500, { error: 'Failed to parse upload' });
  });

  req.pipe(bb);
});

// ─── GET /files/:id ───────────────────────────────────────────────────────────
// Looks up the file record in Postgres, then streams the object from MinIO.
router.get('/files/:id', async (req: Request, res: Response): Promise<void> => {
  try {
    const file = await prisma.file.findUnique({ where: { id: req.params.id } });
    if (!file) {
      res.status(404).json({ error: 'File not found' });
      return;
    }

    const stream = await minioClient.getObject(BUCKET_NAME, file.storageKey);

    res.setHeader('Content-Type', file.mimeType ?? 'application/octet-stream');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${encodeURIComponent(file.filename)}"`,
    );
    res.setHeader('Content-Length', file.size.toString());

    stream.pipe(res);

    stream.on('error', (err: Error) => {
      console.error('[download] Stream error:', err.message);
      // Headers may already be sent — just destroy the response
      res.destroy();
    });
  } catch (err) {
    console.error('[download] Error:', (err as Error).message);
    res.status(500).json({ error: 'Download failed' });
  }
});

// ─── GET /files ───────────────────────────────────────────────────────────────
// Lists all files owned by the requesting user (X-User-Id).
router.get('/files', async (req: Request, res: Response): Promise<void> => {
  const owner = (req.headers['x-user-id'] as string | undefined)?.trim();
  if (!owner) {
    res.status(400).json({ error: 'X-User-Id header is required' });
    return;
  }

  const files = await prisma.file.findMany({
    where: { owner },
    orderBy: { createdAt: 'desc' },
    select: { id: true, filename: true, size: true, mimeType: true, createdAt: true },
  });

  res.json({ files });
});

export default router;
