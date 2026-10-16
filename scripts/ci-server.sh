#!/usr/bin/env bash
# Starts a throwaway Thinger server (image $1, default thinger/server:latest) with MongoDB in
# Docker, registers its first user (an admin) and prints THINGER_SERVER and THINGER_TOKEN for the
# integration tests:
#
#     eval "$(scripts/ci-server.sh thinger/server:7.5)"
#     npm run test:integration
#     scripts/ci-server.sh --stop
set -euo pipefail

NAME=sdk-it
PORT=${THINGER_PORT:-8080}

if [ "${1:-}" = "--stop" ]; then
    docker rm -f "$NAME-server" "$NAME-mongo" >/dev/null 2>&1 || true
    docker network rm "$NAME" >/dev/null 2>&1 || true
    exit 0
fi

IMAGE=${1:-thinger/server:latest}
USER_ID=ci
PASSWORD=ci-password-$RANDOM$RANDOM

docker network create "$NAME" >/dev/null 2>&1 || true
docker run -d --rm --name "$NAME-mongo" --network "$NAME" mongo:7 >/dev/null
docker run -d --rm --name "$NAME-server" --network "$NAME" -p "$PORT:80" --tmpfs /data/thinger \
    -e DATABASE_MONGODB_HOST="$NAME-mongo" \
    "$IMAGE" >/dev/null

SERVER=http://localhost:$PORT
for _ in $(seq 1 60); do
    if curl -sf "$SERVER/v1/server/version" >/dev/null; then break; fi
    sleep 2
done
curl -sf "$SERVER/v1/server/version" >&2 || { docker logs "$NAME-server" >&2; exit 1; }
echo >&2

# the first account of an empty server can sign up, and becomes its admin
curl -sf -X POST "$SERVER/v1/users" -H 'Content-Type: application/json' \
    -d "{\"user\":\"$USER_ID\",\"email\":\"ci@example.com\",\"password\":\"$PASSWORD\"}" >&2 \
    || { echo 'user registration failed' >&2; docker logs "$NAME-server" 2>&1 | tail -20 >&2; exit 1; }
TOKEN=$(curl -sf -X POST "$SERVER/oauth/token" \
    --data-urlencode grant_type=password --data-urlencode "username=$USER_ID" --data-urlencode "password=$PASSWORD" \
    | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s).access_token))')
[ -n "$TOKEN" ] || { echo 'no access token' >&2; exit 1; }

echo "export THINGER_SERVER=$SERVER"
echo "export THINGER_TOKEN=$TOKEN"
