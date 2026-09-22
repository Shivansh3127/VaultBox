# Build a minimal MinIO image from the official binary.
# Uses Alpine from Docker Hub (already cached) + downloads the binary
# directly from dl.min.io — bypasses the quay.io registry TLS issue.
FROM alpine:latest

RUN apk add --no-cache curl ca-certificates && \
    curl -fsSL https://github.com/minio/minio/releases/latest/download/minio.linux-amd64 \
         -o /usr/local/bin/minio && \
    chmod +x /usr/local/bin/minio && \
    mkdir -p /data

EXPOSE 9000 9001

ENTRYPOINT ["/usr/local/bin/minio"]
CMD ["server", "/data", "--console-address", ":9001"]
