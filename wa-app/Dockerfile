FROM docker.m.daocloud.io/library/node:22-bookworm-slim AS dashboard_remote_builder

WORKDIR /app
ENV NPM_CONFIG_REGISTRY=https://registry.npmmirror.com
RUN find /etc/apt -type f \( -name '*.list' -o -name '*.sources' \) -exec sed -i \
        -e 's|http://deb.debian.org/debian-security|http://mirrors.aliyun.com/debian-security|g' \
        -e 's|http://deb.debian.org/debian|http://mirrors.aliyun.com/debian|g' \
        -e 's|http://security.debian.org/debian-security|http://mirrors.aliyun.com/debian-security|g' {} + \
    && apt-get update \
    && apt-get install -y --no-install-recommends libprotobuf-dev protobuf-compiler ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY . /src
RUN set -eux; \
    wa_src=/src; \
    if [ -d /src/wa-app ]; then wa_src=/src/wa-app; fi; \
    mkdir -p /app/wa-app; \
    cp -a "$wa_src/proto" /app/wa-app/proto; \
    cp -a "$wa_src/scripts" /app/wa-app/scripts; \
    cp -a "$wa_src/webui" /app/wa-app/webui; \
    rm -rf /src
WORKDIR /app/wa-app/webui
RUN npm ci --prefer-offline --no-audit --fund=false && npm run build

FROM docker.m.daocloud.io/library/golang:1.26-alpine AS builder

WORKDIR /app/wa-app
ENV GOPROXY=https://goproxy.cn,direct
RUN sed -i 's/dl-cdn.alpinelinux.org/mirrors.aliyun.com/g' /etc/apk/repositories \
    && apk add --no-cache git ca-certificates protobuf-dev

COPY . /src
RUN set -eux; \
    wa_src=/src; \
    if [ -d /src/wa-app ]; then wa_src=/src/wa-app; fi; \
    cp -a "$wa_src/." /app/wa-app/; \
    rm -rf /src; \
    go mod download
RUN go install google.golang.org/protobuf/cmd/protoc-gen-go@v1.36.11 \
    && go install google.golang.org/grpc/cmd/protoc-gen-go-grpc@v1.6.2 \
    && scripts/generate-proto.sh \
    && CGO_ENABLED=0 GOOS=linux go build -o wa-app-service ./cmd/wa-app-service

FROM docker.m.daocloud.io/library/alpine:latest

RUN sed -i 's/dl-cdn.alpinelinux.org/mirrors.aliyun.com/g' /etc/apk/repositories \
    && apk add --no-cache ca-certificates

WORKDIR /app
COPY --from=builder /app/wa-app/wa-app-service .
COPY --from=dashboard_remote_builder /app/wa-app/webui/dist /app/dashboard/wa
EXPOSE 50091 8080
CMD ["./wa-app-service"]
