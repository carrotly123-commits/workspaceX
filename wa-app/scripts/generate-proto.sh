#!/usr/bin/env sh
set -eu

ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
PATH="$(go env GOPATH)/bin:$PATH"

rm -rf "$ROOT/gen"
mkdir -p "$ROOT/gen/go"

protoc -I "$ROOT/proto" \
  --go_out="$ROOT" \
  --go_opt=module=github.com/byte-v-forge/wa-app \
  --go-grpc_out="$ROOT" \
  --go-grpc_opt=module=github.com/byte-v-forge/wa-app \
  $(find "$ROOT/proto" -name '*.proto' | sort)

gofmt -w "$ROOT/gen/go"
