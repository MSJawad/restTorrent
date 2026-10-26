#!/usr/bin/env bash
# End-to-end test: restTorrent downloads a generated multi-file torrent from
# an independent client (Transmission) through a real tracker (opentracker),
# once over the HTTP tracker protocol and once over UDP, then compares every
# byte with the original files. Needs Docker with Compose v2.
set -euo pipefail

cd "$(dirname "$0")"
ROOT="$(cd ../.. && pwd)"

WORK="$(mktemp -d "${TMPDIR:-/tmp}/resttorrent-e2e.XXXXXX")"
export WORK PUID="$(id -u)" PGID="$(id -g)"
compose() { docker compose -f docker-compose.yml "$@"; }

cleanup() {
  status=$?
  if [ "$status" -ne 0 ]; then
    echo "--- seeder log (tail) ---"
    compose logs --tail 40 seeder tracker || true
  fi
  compose --profile client down --volumes --remove-orphans --rmi local >/dev/null 2>&1 || true
  # The containers run as the invoking user, so everything here is ours to delete.
  rm -rf "$WORK"
  exit "$status"
}
trap cleanup EXIT

step() { printf '\n==> %s\n' "$*"; }

step "Building restTorrent"
(cd "$ROOT" && npm run build --silent)

step "Generating payload in $WORK/seed/payload"
mkdir -p "$WORK/seed/payload/videos/raw" "$WORK/seed/payload/docs" "$WORK/out"
head -c 7340033 /dev/urandom > "$WORK/seed/payload/videos/raw/clip.bin"   # 7 MiB + 1 byte
head -c 2500000 /dev/urandom > "$WORK/seed/payload/videos/trailer.bin"
head -c 123457 /dev/urandom > "$WORK/seed/payload/docs/notes.bin"
head -c 1 /dev/urandom > "$WORK/seed/payload/docs/one-byte.bin"
printf 'restTorrent end-to-end test payload\n' > "$WORK/seed/payload/README.txt"

step "Starting opentracker and Transmission"
compose --profile client pull --quiet client seeder
compose up -d --build tracker seeder

remote() { compose exec -T seeder transmission-remote localhost:9091 "$@"; }
for i in $(seq 1 60); do
  if remote -l >/dev/null 2>&1; then break; fi
  [ "$i" -eq 60 ] && { echo "Transmission did not start"; exit 1; }
  sleep 1
done

step "Creating torrents with transmission-create (64 KiB pieces)"
compose exec -T seeder transmission-create -s 64 -t http://tracker:6969/announce -o /data/http.torrent /data/payload >/dev/null
compose exec -T seeder transmission-create -s 64 -t udp://tracker:6969/announce -o /data/udp.torrent /data/payload >/dev/null

step "Seeding with Transmission"
remote -a /data/http.torrent -w /data >/dev/null
for i in $(seq 1 60); do
  info="$(remote -t all -i)"
  if grep -q 'Percent Done: 100%' <<<"$info" && grep -Eq 'State: (Seeding|Idle)' <<<"$info"; then break; fi
  [ "$i" -eq 60 ] && { echo "$info"; echo "Transmission did not start seeding"; exit 1; }
  sleep 1
done
remote -l

for proto in http udp; do
  step "Downloading through the $proto tracker"
  compose run --rm -T -e NODE_DEBUG="${NODE_DEBUG:-}" client download "/data/$proto.torrent" --out "/out/$proto"
  step "Comparing $proto download with the original"
  diff -r "$WORK/seed/payload" "$WORK/out/$proto/payload"
  echo "identical: $(find "$WORK/out/$proto/payload" -type f | wc -l | tr -d ' ') files"
done

step "Resuming: delete one file, download again, expect only its pieces to be fetched"
rm "$WORK/out/http/payload/videos/trailer.bin"
compose run --rm -T -e NODE_DEBUG="${NODE_DEBUG:-}" client download /data/http.torrent --out /out/http
diff -r "$WORK/seed/payload" "$WORK/out/http/payload"

step "End-to-end test passed"
