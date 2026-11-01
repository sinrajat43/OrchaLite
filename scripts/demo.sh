#!/usr/bin/env bash
# Runs a password-protected demo from this checkout and opens it to the internet
# through a Cloudflare quick tunnel. Ctrl-C stops the tunnel and the app.
#
# Settings: DEMO_PORT (3001), DEMO_MONGODB_URI (mongodb://127.0.0.1:27017/orchalite-demo)
#
# Written for the bash 3.2 that macOS ships, so no `wait -n`.
set -euo pipefail

cd "$(dirname "$0")/.."

PORT="${DEMO_PORT:-3001}"
MONGODB_URI="${DEMO_MONGODB_URI:-mongodb://127.0.0.1:27017/orchalite-demo}"
LOCAL_URL="http://127.0.0.1:$PORT"

fail() {
  echo "demo: $1" >&2
  exit 1
}

command -v cloudflared >/dev/null || fail "cloudflared is not installed: brew install cloudflared"
if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  fail "port $PORT is in use; set DEMO_PORT to another"
fi

# Stored connections are encrypted with this key, so it has to outlive each run
if [ ! -f .demo.env ]; then
  (umask 077 && echo "ORCHALITE_SECRET_KEY=$(openssl rand -base64 32)" > .demo.env)
fi
ORCHALITE_SECRET_KEY="$(sed -n 's/^ORCHALITE_SECRET_KEY=//p' .demo.env)"
[ -n "$ORCHALITE_SECRET_KEY" ] || fail ".demo.env has no ORCHALITE_SECRET_KEY"

PASSWORD="$(openssl rand -base64 18)"

export MONGODB_URI ORCHALITE_SECRET_KEY PORT
export HOST=127.0.0.1
export ORCHALITE_DEMO_PASSWORD="$PASSWORD"
export ORCHALITE_BLOCK_PRIVATE_NETWORK=true

echo "demo: building"
npm run build --silent

APP_PID=""
TUNNEL_PID=""
AWAKE_PID=""
TUNNEL_LOG="$(mktemp -t orchalite-demo-tunnel)"

cleanup() {
  trap - INT TERM EXIT
  echo
  echo "demo: stopping"
  [ -n "$TUNNEL_PID" ] && kill "$TUNNEL_PID" 2>/dev/null || true
  [ -n "$AWAKE_PID" ] && kill "$AWAKE_PID" 2>/dev/null || true
  [ -n "$APP_PID" ] && kill "$APP_PID" 2>/dev/null || true
  wait 2>/dev/null || true
  rm -f "$TUNNEL_LOG"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

node dist/main &
APP_PID=$!

if command -v caffeinate >/dev/null; then
  caffeinate -dis -w "$APP_PID" &
  AWAKE_PID=$!
fi

for _ in $(seq 1 60); do
  kill -0 "$APP_PID" 2>/dev/null || fail "the app stopped while starting"
  curl -fsS -o /dev/null -u "demo:$PASSWORD" "$LOCAL_URL/tasks" 2>/dev/null && break
  sleep 1
done
curl -fsS -o /dev/null -u "demo:$PASSWORD" "$LOCAL_URL/tasks" || fail "the app did not become ready"

node scripts/seed-demo.js "$LOCAL_URL"

cloudflared tunnel --no-autoupdate --url "$LOCAL_URL" > "$TUNNEL_LOG" 2>&1 &
TUNNEL_PID=$!

PUBLIC_URL=""
for _ in $(seq 1 30); do
  kill -0 "$TUNNEL_PID" 2>/dev/null || break
  PUBLIC_URL="$(grep -Eo 'https://[a-z0-9-]+\.trycloudflare\.com' "$TUNNEL_LOG" | grep -v '//api\.' | head -n 1 || true)"
  [ -n "$PUBLIC_URL" ] && break
  sleep 1
done
if [ -z "$PUBLIC_URL" ]; then
  cat "$TUNNEL_LOG" >&2
  fail "the tunnel did not start"
fi

cat <<EOF

  Demo is live until you press Ctrl-C

  URL       $PUBLIC_URL
  Username  demo
  Password  $PASSWORD

EOF

while kill -0 "$APP_PID" 2>/dev/null && kill -0 "$TUNNEL_PID" 2>/dev/null; do
  sleep 1
done
fail "the app or the tunnel stopped"
