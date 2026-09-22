VaultBox — Stage 0 Reference

A complete reference for Stage 0 (bare single-request upload). Every section references real file paths and function names from the codebase. Read this before touching Stage 1.

---

WHERE THIS STAGE FITS IN THE WHOLE PROJECT

VaultBox separates every file operation into two concerns stored in two separate systems.

Bytes — the raw file data — go to an S3-compatible object store. In development that is motoserver/moto running in Docker; in production it would be a real AWS S3 bucket or any S3-compatible service. Object stores are built for arbitrary-size binary blobs with parallel chunked I/O and cheap egress. They do not do queries.

Facts about bytes — filename, who owns it, how large it is, when it was uploaded — go to PostgreSQL via Prisma. Postgres is where you do relational queries: list all files for a user, sum storage by owner, filter by date, join to a dedup hash table.

Express is the traffic cop between the two. It never holds onto file bytes. It decides where bytes go and records that decision in Postgres.

Stage 0 proves the minimum: Express can receive a multipart file, stream it to the object store without buffering the whole thing in RAM, and record the metadata in Postgres. The download path can reverse that — read the metadata, stream bytes back from the store to the HTTP client.

Everything that comes later layers on top of this foundation:

Stage 1 — client splits the file into 5 MB chunks and uploads 4 in parallel
Stage 2 — client can resume after a dropped connection; SHA-256 checksum per chunk
Stage 3 — deduplication; same bytes from two users stored once
Stage 4 — pre-signed URLs; client uploads directly to S3, bypassing Express
Stage 5 — versioning; old file copies kept on overwrite
Stage 6 — sharing and per-user storage quotas
Stage 7 — cleanup jobs; background garbage collection of orphaned chunks

Stage 0 does none of that. One request, one file, one round-trip.

---

FILE-BY-FILE WALKTHROUGH

apps/api/src/server.ts

Single responsibility: boot the application in the correct order and expose the HTTP server.

Nothing calls this file. It is the entrypoint — ts-node-dev executes it directly when you run npm run dev.

Boot sequence in exact order:
- import 'dotenv/config' fires first as a side effect, loading .env into process.env before any other code runs. It must be the first import.
- express() creates the app instance.
- app.use(express.json()) registers JSON body parsing. Multipart uploads go through busboy, not this, but future endpoints that accept JSON bodies will need it.
- app.get('/health', ...) registers a cheap liveness probe.
- app.use('/', filesRouter) mounts all three file endpoints from routes/files.ts.
- app.use(404 catch-all) catches any unmatched route.
- start() runs — this is the critical async function.

Inside start():
- await prisma.$connect() opens the Postgres connection pool. If Postgres is unreachable this throws immediately.
- await ensureBucket() from lib/minio.ts creates the S3 bucket if it does not exist. If moto is unreachable this throws immediately.
- app.listen(PORT, ...) is only reached after both checks pass.

Non-obvious design decision: the simpler approach is to call app.listen immediately and let the first request discover a missing bucket. The fail-fast pattern used here gives a clear error and process.exit(1) instead of a mystery 500 on the first upload. If infrastructure is down you know immediately on startup, not after the first customer hits the endpoint.

---

apps/api/src/routes/files.ts

Single responsibility: define the three HTTP endpoints and coordinate busboy, the MinIO SDK, and Prisma for each one.

server.ts mounts this via app.use('/', filesRouter).

POST /upload — step by step inside the handler:

1. Read req.headers['x-user-id'] and trim it. Reply 400 if missing.
2. Create a busboy instance: const bb = busboy({ headers: req.headers }). Busboy reads the Content-Type header to extract the multipart boundary string.
3. Register bb.on('file', (_fieldname, fileStream, info)) — this callback fires when busboy finds a file field in the multipart body.
4. Inside the file callback: generate storageKey = 'files/' + uuidv4() + '/' + filename. The UUID prefix prevents collisions if two users upload photo.jpg. Create a Transform stream called sizeCounter that increments a size variable by chunk.length on each chunk and calls cb(null, chunk) to pass the chunk through unchanged. Pipe fileStream into sizeCounter to get countedStream. Call minioClient.putObject(BUCKET_NAME, storageKey, countedStream, undefined, { 'Content-Type': mimeType }) — this opens an HTTP PUT to moto and the bytes start flowing. In the .then() after moto confirms the write: call prisma.file.create with filename, size, owner, storageKey, mimeType. In the next .then(): call reply(201, { id, filename, size, owner, createdAt }).
5. Register bb.on('finish') — fires after all multipart parts are parsed. If no file field was seen and no reply has been sent, reply 400.
6. Register bb.on('error') — busboy parse failure, reply 500.
7. req.pipe(bb) — this is the line that starts the entire pipeline. Nothing moves until here.

Non-obvious design decision — the reply guard: the handler defines a local function called reply that checks a responded boolean before calling res.status().json(). Without it, busboy's 'finish' event fires after 'file' completes, meaning a successful upload would call reply(201) and then 'finish' would immediately call reply(400, 'no file found') — attempting to set headers on an already-sent response, which Node.js treats as an error.

GET /files/:id — step by step:

1. await prisma.file.findUnique({ where: { id: req.params.id } }). If null, reply 404.
2. await minioClient.getObject(BUCKET_NAME, file.storageKey). Returns a Node.js Readable stream pointing at the object in moto.
3. Set Content-Type from file.mimeType (fallback to application/octet-stream), Content-Disposition with the original filename, Content-Length from file.size.
4. stream.pipe(res). Bytes flow from moto directly into the HTTP response.
5. stream.on('error', ...) calls res.destroy(). If moto dies mid-stream, destroy the socket rather than leaving the client hanging with an incomplete download.

Non-obvious design decision: Content-Length is served from the file.size column in Postgres, not by calling headObject on moto. The byte count was computed exactly during upload via sizeCounter, so it is already in Postgres. Using it here saves a round-trip to moto on every download.

GET /files — step by step:

1. Read and validate X-User-Id header. Reply 400 if missing.
2. await prisma.file.findMany({ where: { owner }, orderBy: { createdAt: 'desc' }, select: { id, filename, size, mimeType, createdAt } }).
3. res.json({ files }).

Non-obvious design decision: storageKey is deliberately not in the select list. It is an internal S3 path (files/<uuid>/<filename>). Clients have no business constructing storage paths from API responses.

---

apps/api/src/lib/minio.ts

Single responsibility: configure the MinIO SDK client singleton and export the ensureBucket function.

server.ts imports ensureBucket and calls it at startup. routes/files.ts imports minioClient and BUCKET_NAME for every endpoint.

The client is created once at module load:

  endPoint: process.env.S3_ENDPOINT ?? 'localhost'
  port:     parseInt(process.env.S3_PORT ?? '4566', 10)
  useSSL:   false
  accessKey: process.env.S3_ACCESS_KEY ?? 'test'
  secretKey: process.env.S3_SECRET_KEY ?? 'test'
  pathStyle: true

All values come from .env with hardcoded fallbacks so the server still starts if you forget to copy .env.example. The pathStyle flag is explained in full in the Object Store Swap section below.

ensureBucket calls minioClient.bucketExists(BUCKET_NAME). If the bucket already exists (server restart without restarting moto), it logs "ready" and returns. If not, it calls minioClient.makeBucket(BUCKET_NAME, process.env.S3_REGION ?? 'us-east-1'). Called exactly once in start(), before app.listen.

---

apps/api/src/lib/prisma.ts

Single responsibility: export exactly one PrismaClient instance for the entire process lifetime.

Both server.ts (for $connect) and routes/files.ts (for all queries) import from here.

The globalThis trick:

  const globalForPrisma = globalThis as unknown as { prisma: PrismaClient };
  export const prisma = globalForPrisma.prisma ?? new PrismaClient({ log: ['query', 'error', 'warn'] });
  if (process.env.NODE_ENV !== 'production') { globalForPrisma.prisma = prisma; }

ts-node-dev hot-reloads modules on every file save. Without this pattern, each save creates a new PrismaClient and a new connection pool. After roughly 10 saves you exhaust Postgres's max_connections. The globalThis cache survives module re-evaluation so you always get one pool regardless of how many hot-reloads happen.

In production NODE_ENV is 'production', the cache is skipped, and new PrismaClient() runs exactly once at cold start.

log: ['query', 'error', 'warn'] in development prints every SQL statement Prisma executes to the terminal so you can see exactly what queries your endpoints fire without opening a separate DB client.

---

apps/api/prisma/schema.prisma

Single responsibility: declare the Postgres schema Prisma uses to generate migration SQL and the TypeScript client.

The datasource block points at DATABASE_URL from .env, which in development is postgresql://vaultbox:vaultbox_secret@localhost:5433/vaultbox_db — matching the postgres service in docker-compose.yml exactly.

The File model maps to a Postgres table called files (lowercase plural, set by @@map("files")). Without @@map, Prisma would name the table "File" — which works but violates standard SQL naming conventions. The model name stays File in TypeScript (PascalCase singular), the table name is files in Postgres (lowercase plural). @@map reconciles the two.

Every field is covered in the Prisma Schema section below.

---

docker-compose.yml

Single responsibility: declare the three local development infrastructure services Postgres, moto, and Redis.

  postgres — image postgres:16-alpine, host port 5433 mapped to container port 5432.
  s3mock   — image motoserver/moto:latest, host port 4566 mapped to container port 5000.
  redis    — image redis:7-alpine, host port 6380 mapped to container port 6379.

All ports are offset from their standard values. Postgres normally runs on 5432, Redis on 6379. Another project on the same machine (SimpleCI) owns those ports. If you ran on standard ports, docker compose up would fail with a bind error.

Redis is unused in Stage 0. It is in the Compose file because Stage 1 needs it to track chunk state — which chunks are received, which are missing. Adding it now means Stage 1 can start using it without modifying infrastructure files.

All three services have healthchecks. Docker marks a service (healthy) vs (starting) based on these. The Express server's start() function acts as its own dependency gate — it does not use depends_on, it just calls prisma.$connect() and ensureBucket() and lets those throw if the dependencies are not ready.

---

FULL REQUEST TRACE

POST /upload

You run: curl.exe -s -X POST http://localhost:4000/upload -H "X-User-Id: user_1" -F "file=@test.txt"

curl sends an HTTP POST with Content-Type: multipart/form-data; boundary=----FormBoundaryXXX and the file bytes as the body.

TCP bytes arrive at the Express HTTP server on port 4000.

Express matches the route and calls the handler in routes/files.ts at router.post('/upload', handler).

The handler reads req.headers['x-user-id'] and gets "user_1".

const bb = busboy({ headers: req.headers }) is created. Busboy reads the Content-Type header to learn the boundary string.

req.pipe(bb) is called. Node.js starts pumping request body bytes into busboy.

Busboy parses the multipart envelope and fires bb.on('file', _fieldname, fileStream, info). It receives fieldname "file", a fileStream Readable with the raw file bytes, and info containing filename "test.txt" and mimeType "text/plain".

storageKey is set to "files/4646d2a4-9f72-4b37-a1c5-f7506ae54639/test.txt" (the UUID is generated by uuidv4()).

sizeCounter is created: a Transform stream that adds chunk.length to size on each chunk and calls cb(null, chunk) to pass the chunk through.

countedStream = fileStream.pipe(sizeCounter) connects the streams. No bytes move yet.

minioClient.putObject(BUCKET_NAME, storageKey, countedStream, undefined, { 'Content-Type': 'text/plain' }) is called. The MinIO SDK opens an HTTP PUT to http://localhost:4566/vaultbox/files/4646d2a4.../test.txt. As the SDK reads from countedStream, backpressure propagates: countedStream pulls from sizeCounter, sizeCounter pulls from fileStream, fileStream pulls from busboy's buffer, busboy pulls from req, req pulls from the TCP socket. Bytes flow: TCP → req → busboy → fileStream → sizeCounter (size += chunk.length) → MinIO SDK → HTTP PUT body → moto.

moto stores the object and returns 200 to the MinIO SDK.

The .then() callback runs: await prisma.file.create({ data: { filename: "test.txt", size: 51, owner: "user_1", storageKey: "files/4646d2a4.../test.txt", mimeType: "text/plain" } }). Prisma sends INSERT INTO files (...) VALUES (...) RETURNING .... Postgres creates the row.

reply(201, { id: "4646d2a4...", filename: "test.txt", size: 51, owner: "user_1", createdAt: "2026-09-17T03:21:30.398Z" }) is called. Express calls res.status(201).json({...}).

curl receives HTTP 201 with the JSON body.

---

GET /files/:id

You run: curl.exe -s http://localhost:4000/files/4646d2a4-... -H "X-User-Id: user_1"

Express matches the route and calls the async handler at router.get('/files/:id', handler).

await prisma.file.findUnique({ where: { id: "4646d2a4..." } }) runs. Prisma sends SELECT * FROM files WHERE id = $1 LIMIT 1. Postgres returns the row.

await minioClient.getObject(BUCKET_NAME, "files/4646d2a4.../test.txt") runs. The MinIO SDK sends GET http://localhost:4566/vaultbox/files/4646d2a4.../test.txt to moto. moto responds with the object bytes as a streaming HTTP response. getObject returns a Node.js Readable stream backed by that response.

res.setHeader('Content-Type', 'text/plain'), res.setHeader('Content-Disposition', 'attachment; filename="test.txt"'), res.setHeader('Content-Length', '51') are called using values from the Postgres record.

stream.pipe(res). Bytes flow: moto HTTP response → MinIO SDK Readable → res → curl stdout.

curl writes the bytes to stdout. You see: Hello VaultBox - Stage 0 test 09/17/2026 08:51:30

---

GET /files

You run: curl.exe -s http://localhost:4000/files -H "X-User-Id: user_1"

Express matches the route and calls the async handler at router.get('/files', handler).

owner = req.headers['x-user-id'] = "user_1".

await prisma.file.findMany({ where: { owner: "user_1" }, orderBy: { createdAt: 'desc' }, select: { id: true, filename: true, size: true, mimeType: true, createdAt: true } }) runs. Prisma sends SELECT id, filename, size, "mimeType", "createdAt" FROM files WHERE owner = $1 ORDER BY "createdAt" DESC. Note storageKey is not in the select so it is not fetched and not returned.

res.json({ files: [...] }) is called.

curl receives HTTP 200 with the JSON body.

---

STREAMING DETAIL

The exact pipeline in routes/files.ts:

  req (IncomingMessage — TCP bytes)
    → busboy (WritableStream — multipart parser)
        → fileStream (Readable — raw file bytes emitted by busboy)
            → sizeCounter (Transform — counts bytes, passes each chunk through)
                → [MinIO SDK consumes this as the putObject body]
                    → HTTP PUT body → moto

The sizeCounter Transform is defined at lines 39–44 in routes/files.ts:

  const sizeCounter = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      size += chunk.length;
      cb(null, chunk);
    },
  });

cb(null, chunk) means "I am done processing this chunk, emit it downstream unchanged." The null is the error argument. If you passed cb(new Error('bad')) the stream would emit an error event. If you passed cb(null, someOtherBuffer) you would transform the bytes — that is how compression and encryption transforms work.

The pipeline is demand-driven. The MinIO SDK reads from countedStream when it is ready to send the next chunk to moto. That pull propagates: countedStream pulls from sizeCounter, sizeCounter pulls from fileStream, fileStream pulls from busboy's internal buffer, busboy pulls from req, req pulls from the TCP socket. When moto is slow, the backpressure propagates all the way back to curl, which slows its send rate. At no point does any component accumulate all the bytes.

At any moment in time only the current chunk — typically 64 KB to 1 MB, determined by Node.js stream internals — exists in the heap.

The naive alternative would be:

  app.use(express.raw({ limit: '10gb' }));
  router.post('/upload', async (req, res) => {
    const buffer = req.body;  // entire file now in heap
    await minioClient.putObject(BUCKET_NAME, key, buffer);
  });

With 10 concurrent 500 MB uploads that is 5 GB of heap, which crashes the process with an out-of-memory error. With the streaming pipeline, heap usage is proportional to chunk size times concurrency, not file size times concurrency. A 10 GB file and a 10 KB file consume the same RAM during upload.

For a file storage service specifically this matters because the whole product promise is "store large files reliably." If the server OOMs on a 2 GB upload you have not built a file storage service.

---

PRISMA SCHEMA

The File model in apps/api/prisma/schema.prisma has seven fields.

id — String @id @default(uuid())
What it stores: the primary key, a UUID generated by Postgres at insert time.
Used in Stage 0: yes — it is the parameter in GET /files/:id.
Future stages: no stage changes this field, but Stage 5 (versioning) will add a parentId field referencing this one for version chains.

filename — String
What it stores: the original filename from the multipart form, taken from info.filename in busboy's file callback.
Used in Stage 0: yes — it appears in the Content-Disposition header on download and in the list response.
Future stages: Stage 5 will add a version number alongside the filename for overwrite handling.

size — Int
What it stores: the byte count of the uploaded file, computed by the sizeCounter Transform in routes/files.ts.
Used in Stage 0: yes — it is returned in the upload response and used as Content-Length on download.
Future stages: Stage 6 (quotas) will run SUM(size) WHERE owner = $1 to enforce per-user storage limits. Note: Int is a 32-bit Postgres INTEGER with a maximum of 2,147,483,647 bytes, approximately 2.1 GB. This field needs to be migrated to BigInt before Stage 2 or you will get silent integer overflow on large files.

owner — String
What it stores: the raw value of the X-User-Id header, trimmed. Not validated against any user table because VaultBox has no auth service in Stage 0.
Used in Stage 0: yes — GET /files filters WHERE owner = $1.
Future stages: Stage 6 will introduce quotas and sharing that both key on this field. A real auth system would replace the header with a verified JWT claim.

storageKey — String
What it stores: the S3 object key, formatted as files/<uuid>/<filename>. This is what you pass to getObject and deleteObject.
Used in Stage 0: yes — passed to minioClient.getObject in the download handler.
Future stages: Stage 7 (cleanup) will scan for storageKey values that have no associated file row and call deleteObject on them to reclaim storage.

mimeType — String?
What it stores: the MIME type from busboy's info object, for example text/plain or image/jpeg. Nullable because not all clients send a Content-Type on the file part.
Used in Stage 0: yes — written as Content-Type on the download response. Falls back to application/octet-stream if null.
Future stages: Stage 4 (pre-signed URLs) embeds the MIME type in the signature when generating an upload URL, so the client must upload with the matching Content-Type.

createdAt — DateTime @default(now())
What it stores: the Postgres server timestamp at insert time. The application code never sets this — Prisma's @default(now()) translates to DEFAULT NOW() in the migration SQL.
Used in Stage 0: yes — returned in the upload response and used to order the list in GET /files (ORDER BY createdAt DESC).
Future stages: Stage 5 (versioning) uses createdAt to determine which version is latest within a filename group.

---

OBJECT STORE SWAP

The original plan was to use minio/minio from Docker Hub. It was ruled out along with every other MinIO distribution method:

dl.min.io/server/minio/release/linux-amd64/minio — HTTP 410 Gone. MinIO deprecated its public binary CDN and removed all files from it. The minio.Dockerfile tried to curl this URL at build time and failed.

docker pull minio/minio — "pull access denied, repository does not exist or may require docker login." MinIO moved the image to a restricted Docker Hub repo requiring authentication. The corporate Docker Hub login did not have access.

docker pull quay.io/minio/minio — TLS handshake failure: "tls: failed to verify certificate." The local corporate proxy performs SSL inspection — it replaces the server's TLS certificate with its own. Akamai CDN (which serves quay.io) uses certificate pinning that rejects the substituted certificate. Docker cannot complete the TLS handshake regardless of insecure-registry settings, because the failure happens at the CDN layer before Docker even sees the registry API.

docker pull localstack/localstack — this pulled successfully from Docker Hub. But the container exited immediately with code 55: "License activation failed — please set LOCALSTACK_AUTH_TOKEN." LocalStack Community Edition now requires a paid Pro license for all services, including S3.

docker pull motoserver/moto — pulled successfully, no auth, no license. Container started, responded to POST /moto-api/reset, S3 API functional.

What changed in the code to make this work:

In apps/api/src/lib/minio.ts, two config values changed.

Port changed from 9000 (MinIO's default) to 4566 (the host port mapped to moto's container port 5000 in docker-compose.yml).

pathStyle was added and set to true. Without it, the MinIO SDK would construct virtual-hosted-style URLs: http://vaultbox.localhost:4566/<key>. This format requires DNS to resolve the vaultbox. subdomain on localhost, which it cannot. With pathStyle: true, the SDK uses path-style URLs instead: http://localhost:4566/vaultbox/<key>. Any HTTP server can handle this format.

The .env and .env.example files updated the variable names from MINIO_ENDPOINT, MINIO_PORT, MINIO_ACCESS_KEY, MINIO_SECRET_KEY to S3_ENDPOINT, S3_PORT, S3_ACCESS_KEY, S3_SECRET_KEY — moto accepts any non-empty string for credentials, so the values changed to "test".

Nothing in routes/files.ts changed. putObject, getObject, bucketExists, and makeBucket all work identically against moto.

Why the same SDK works against any S3-compatible server: AWS published the S3 HTTP wire protocol as a de-facto open standard around 2006. Every object store — MinIO, moto, LocalStack, Cloudflare R2, Backblaze B2, Google Cloud Storage in interop mode — implements the same HTTP verbs with the same XML response format. PUT /<bucket>/<key> writes an object. GET /<bucket>/<key> reads it. HEAD /<bucket>/<key> returns metadata. DELETE /<bucket>/<key> removes it. The MinIO SDK is an HTTP client that formats requests this way and parses the XML responses. It does not know and does not care what server is on the other end. Changing two config values is sufficient to retarget it from one implementation to any other.

To switch to real AWS S3 in production: set endPoint to s3.amazonaws.com, port to 443, useSSL to true, and pathStyle to false. routes/files.ts is unchanged.

---

ERRORS ENCOUNTERED

These are the actual errors hit during Stage 0, in the order they happened.

Error 1 — dl.min.io returned 410 Gone
Message: "The remote server returned an error: (410) Gone."
Cause: MinIO shut down its public binary CDN. The minio.Dockerfile used RUN curl to download the server binary from dl.min.io at build time. The URL no longer exists.
Fix: Abandoned the Dockerfile binary approach entirely. Switched to a pre-built container image.

Error 2 — minio/minio requires Docker Hub authentication
Message: "pull access denied for minio/minio, repository does not exist or may require 'docker login'"
Cause: MinIO restricted their Docker Hub image to authenticated or authorized accounts.
Fix: Tried the quay.io mirror next.

Error 3 — quay.io/minio/minio TLS handshake failure
Message: "Get 'https://quay.io/v2/': tls: failed to verify certificate"
Cause: Corporate proxy performs SSL inspection and replaces server certificates. Akamai CDN (used by quay.io) rejects the substituted cert. The Docker insecure-registry setting does not help because the failure is at the Akamai layer, not the registry layer.
Fix: Ruled out quay.io. Tried LocalStack.

Error 4 — LocalStack exits with code 55
Message: "LocalStack returning with exit code 55. License activation failed! No credentials were found in the environment. Please set LOCALSTACK_AUTH_TOKEN."
Cause: LocalStack moved S3 (previously free in Community Edition) behind a paid Pro license.
Fix: Switched to motoserver/moto, which is fully open source with no license requirement.

Error 5 — PowerShell curl alias rejects -F and -X flags
Message: "A parameter cannot be found that matches parameter name 'Form'." and "A parameter cannot be found that matches parameter name 'X'."
Cause: In PowerShell, curl is an alias for Invoke-WebRequest, which uses PowerShell's own parameter syntax rather than curl's UNIX flags. -F (multipart form) and -X (HTTP method) are curl flags that Invoke-WebRequest does not recognize.
Fix: Use curl.exe explicitly. Windows 10 and later ship the real curl binary at C:\Windows\System32\curl.exe. The .exe suffix forces PowerShell to call the binary instead of the alias.

Error 6 — moto healthcheck stuck on health: starting
Symptom: docker compose ps showed vaultbox_s3 as "Up 43 seconds (health: starting)" indefinitely. The container was actually working — uploads and downloads succeeded.
Cause: The healthcheck was configured as CMD curl -f http://localhost:5000/moto-api/reset, which sends a GET request. Moto's /moto-api/reset endpoint only accepts POST and returns 405 Method Not Allowed on GET. Docker interprets a non-2xx response as a failed health check.
Fix: Replaced the healthcheck with a Python one-liner that sends a proper POST request. Python is available inside the moto image. The fix is in docker-compose.yml:

  test: ['CMD-SHELL', 'python3 -c "import urllib.request; urllib.request.urlopen(urllib.request.Request(\"http://localhost:5000/moto-api/reset\", method=\"POST\"))" && echo ok']

---

WHAT'S STILL FAKE OR INCOMPLETE

The entire POST /upload handler (routes/files.ts lines 14–82) treats the upload as one atomic HTTP request. Stage 1 breaks this into three separate requests. Here is exactly what changes.

router.post('/upload', handler) is replaced by three new endpoints. Stage 1 adds router.post('/uploads/init', ...) where the client declares the filename, total size, and chunk size and receives back an upload_id. It adds router.put('/uploads/:id/chunks/:index', ...) where the client sends exactly one 5 MB chunk as the request body. It adds router.post('/uploads/:id/complete', ...) where the client tells the server to assemble the chunks into a final object. The current single-request handler disappears entirely.

minioClient.putObject(BUCKET_NAME, storageKey, countedStream) in routes/files.ts line 48 currently writes the whole file in one S3 PUT. Stage 1 replaces this with per-chunk writes to a temp path pattern like temp/<upload_id>/chunk-<index>, followed by a final assembly step (either S3 multipart upload API or a composeObject call) at complete time.

prisma.file.create in routes/files.ts line 53 currently runs immediately after the upload completes. Stage 1 defers this — the File row is only created at POST /uploads/:id/complete time, not at individual chunk upload time. Stage 1 adds Upload and Chunk models to prisma/schema.prisma to track partial state between the init and complete requests.

size: Int in schema.prisma will overflow at 2,147,483,647 bytes (about 2.1 GB). Prisma's Int maps to a 32-bit signed Postgres INTEGER. This must be migrated to BigInt (64-bit Postgres BIGINT) before Stage 2 or you will get silent integer overflow on large files.

There is no error recovery if Postgres fails after a successful S3 PUT. In routes/files.ts lines 52–66, if minioClient.putObject succeeds but prisma.file.create throws, the bytes are stored in moto with no metadata row pointing to them. They are permanently invisible — the download endpoint can never find them because it looks up rows by id. They also cannot be deleted because nothing knows the storageKey. Stage 7 (cleanup) will garbage-collect these orphaned objects by scanning S3 for keys that have no corresponding files row.

There is no file size limit. The handler accepts arbitrarily large single-request uploads. Stage 1's chunking caps each individual PUT at 5 MB, which makes per-request timeouts and retry logic tractable.
