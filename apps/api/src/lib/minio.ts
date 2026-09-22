import { Client } from 'minio';

export const BUCKET_NAME = process.env.S3_BUCKET ?? 'vaultbox';

// The MinIO SDK is S3-compatible and works with LocalStack out of the box.
// LocalStack requires:
//   - pathStyle: true (bucket name in URL path, not subdomain)
//   - Any non-empty access/secret key (LocalStack doesn't verify)
export const minioClient = new Client({
  endPoint: process.env.S3_ENDPOINT ?? 'localhost',
  port: parseInt(process.env.S3_PORT ?? '4566', 10),
  useSSL: false,
  accessKey: process.env.S3_ACCESS_KEY ?? 'test',
  secretKey: process.env.S3_SECRET_KEY ?? 'test',
  pathStyle: true, // required for LocalStack — disables virtual-hosted-style URLs
});

/**
 * Creates the VaultBox bucket if it does not already exist.
 * Called once at server startup.
 */
export async function ensureBucket(): Promise<void> {
  const exists = await minioClient.bucketExists(BUCKET_NAME);
  if (!exists) {
    await minioClient.makeBucket(BUCKET_NAME, process.env.S3_REGION ?? 'us-east-1');
    console.log(`✓ S3 bucket created: ${BUCKET_NAME}`);
  } else {
    console.log(`✓ S3 bucket ready: ${BUCKET_NAME}`);
  }
}
