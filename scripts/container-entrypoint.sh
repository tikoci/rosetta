#!/usr/bin/env sh
set -eu

set -- /app/rosetta --http --host "${ROSETTA_HOST:-0.0.0.0}"

if [ -n "${PORT:-}" ]; then
  set -- "$@" --port "$PORT"
fi

tls_cert="${TLS_CERT_PATH:-}"
tls_key="${TLS_KEY_PATH:-}"
if [ -n "$tls_cert" ] || [ -n "$tls_key" ]; then
  if [ -z "$tls_cert" ] || [ -z "$tls_key" ]; then
    echo "Error: TLS_CERT_PATH and TLS_KEY_PATH must both be set" >&2
    exit 1
  fi
  set -- "$@" --tls-cert "$tls_cert" --tls-key "$tls_key"
fi

exec "$@"