# VaultBox

A portfolio-grade distributed file storage backend — a Dropbox-lite built from scratch in staged increments, with each stage independently runnable and documented before the next begins.

> **Current status:** Stage 0 complete — bare upload, download, and list over a streaming pipeline. Stage 1 (chunked parallel upload) in progress.

---

## Architecture

VaultBox separates every file operation into two concerns:

| Concern | System | Why |
|---|---|---|
| **Bytes** — raw file data | S3-compatible object store | Built for arbitrary-size binary blobs; parallel chunked I/O |
| **Facts about bytes** — filename, owner, size, timestamps | PostgreSQL via Prisma | Relational queries, filtering, aggregations |

**Express is the traffic cop.** It never buffers file bytes in memory — it streams them directly between the client and the object store, then records what happened in Postgres.

---

## Stack

| Layer | Technology |
|---|---|
| API server | Node.js + TypeScript + Express |
| Object store | [moto server](https://github.com/getmoto/moto) (S3-compatible, Docker) in dev · AWS S3 in prod |
| Database | PostgreSQL 16 + Prisma ORM |
| Cache / queue state | Redis 7 |
| Local orchestration | Docker Compose |

---

## Staged Build Roadmap

| Stage | What it adds | Status |
|---|---|---|
| **0** | Bare upload / download / list. Streaming pipeline. | ✅ Complete |
| **1** | Client-side chunking (5 MB), 4 parallel uploads, chunk tracking in Postgres + Redis | 🔨 In progress |
| **2** | Resumability — client queries which chunks the server has; SHA-256 integrity per chunk | ⏳ Planned |
| **3** | Content-addressed deduplication — same bytes from two users stored once | ⏳ Planned |
| **4** | Pre-signed URLs — client uploads directly to S3, Express never touches the bytes | ⏳ Planned |
| **5** | Versioning — old file copies kept on overwrite | ⏳ Planned |
| **6** | Sharing and per-user storage quotas | ⏳ Planned |
| **7** | Cleanup jobs — background GC for orphaned chunks and unreferenced objects | ⏳ Planned |

Each stage has a corresponding write-up in [`notes/`](./notes/).

---

## Local Setup

### Prerequisites

- [Docker Desktop](https://www.docker.com/products/docker-desktop/) (or Docker Engine + Compose)
- Node.js 20+
- npm 10+

### 1. Start infrastructure

```bash
docker compose up -d
```

This starts three containers:

| Container | Image | Host port |
|---|---|---|
| `vaultbox_postgres` | `postgres:16-alpine` | `5433` |
| `vaultbox_s3` | `motoserver/moto` | `4566` |
| `vaultbox_redis` | `redis:7-alpine` | `6380` |

Ports are offset from defaults to avoid conflicts with other local services.

### 2. Configure environment

```bash
cd apps/api
cp .env.example .env
```

The defaults in `.env.example` match the Docker Compose config exactly — no changes needed for local development.

### 3. Install dependencies and run migrations

```bash
cd apps/api
npm install
npm run db:migrate
```

### 4. Start the API server

```bash
npm run dev
```

The server performs a fail-fast startup — it connects to Postgres and creates the S3 bucket before binding to the port. If either dependency is down, it exits with a clear error instead of accepting requests.

```
✓ PostgreSQL connected
✓ S3 bucket created: vaultbox
✓ VaultBox API listening on http://localhost:4000
  POST /upload          — upload a file
  GET  /files           — list your files
  GET  /files/:id       — download a file
```

---

## API Reference (Stage 0)

All endpoints use the `X-User-Id` header to identify the caller. There is no authentication in Stage 0 — any non-empty value is accepted.

### `POST /upload`

Upload a file via multipart form data.

```bash
curl.exe -s -X POST http://localhost:4000/upload \
  -H "X-User-Id: user_1" \
  -F "file=@/path/to/your/file.txt"
```

**Response `201`**

```json
{
  "id": "4646d2a4-9f72-4b37-a1c5-f7506ae54639",
  "filename": "file.txt",
  "size": 1024,
  "owner": "user_1",
  "createdAt": "2026-09-17T03:21:30.398Z"
}
```

---

### `GET /files/:id`

Download a file by its ID.

```bash
curl.exe -s http://localhost:4000/files/4646d2a4-9f72-4b37-a1c5-f7506ae54639 \
  -H "X-User-Id: user_1" \
  -o downloaded.txt
```

Returns the file bytes with the original `Content-Type` and `Content-Disposition` headers set.

---

### `GET /files`

List all files for a user, newest first.

```bash
curl.exe -s http://localhost:4000/files -H "X-User-Id: user_1"
```

**Response `200`**

```json
{
  "files": [
    {
      "id": "4646d2a4-9f72-4b37-a1c5-f7506ae54639",
      "filename": "file.txt",
      "size": 1024,
      "mimeType": "text/plain",
      "createdAt": "2026-09-17T03:21:30.398Z"
    }
  ]
}
```

---

## Project Structure

```
vaultbox/
├── apps/
│   └── api/
│       ├── src/
│       │   ├── server.ts          # Entrypoint — fail-fast startup, route mounting
│       │   ├── routes/
│       │   │   └── files.ts       # POST /upload, GET /files/:id, GET /files
│       │   └── lib/
│       │       ├── minio.ts       # MinIO SDK client (targeting moto in dev)
│       │       └── prisma.ts      # PrismaClient singleton (globalThis hot-reload safe)
│       ├── prisma/
│       │   ├── schema.prisma      # File model
│       │   └── migrations/
│       ├── .env.example
│       └── package.json
├── notes/
│   ├── stage-0.md                 # Stage 0 deep-dive (markdown)
│   └── stage-0-plain.md          # Stage 0 deep-dive (plain text)
└── docker-compose.yml
```

---

## Key Design Decisions

**Streaming, not buffering.** The upload pipeline is `req → busboy → Transform (byte count) → moto putObject`. At no point does Express hold the full file in memory. A 10 GB file and a 10 KB file consume the same heap during upload.

**Fail-fast startup.** The server connects to Postgres and verifies the S3 bucket before calling `app.listen`. Misconfigured infrastructure is caught at deploy time, not at request time.

**S3 wire protocol portability.** The MinIO npm SDK targets moto in development via two config changes (`pathStyle: true`, `port: 4566`). Switching to real AWS S3 in production requires only changing the endpoint config — `routes/files.ts` is unchanged. This is because every S3-compatible store implements the same HTTP wire protocol.

**Port offsets.** All Docker services use non-standard ports (5433, 4566, 6380) to coexist with other local development services without conflicts.

---

## Notes

Detailed write-ups for each stage live in [`notes/`](./notes/). They cover the architecture rationale, file-by-file walkthroughs, full request traces, errors encountered during development, and what each stage leaves incomplete for the next.

---

## License

MIT
