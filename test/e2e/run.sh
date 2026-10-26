#!/usr/bin/env bash
# End-to-end test: restTorrent downloads a generated multi-file torrent from
# an independent client (Transmission) through a real tracker (opentracker),
# once over the HTTP tracker protocol and once over UDP, then compares every
# byte with the original files. Needs Docker with Compose v2.
set -euo pipefail

cd "$(dirname "$0")"
ROOT="$(cd ../.. && pwd)"

# Seconds one download may take before the test gives up and prints diagnostics.
# A healthy download finishes in seconds; Transmission may hold a new peer for
# one choke cycle (10 s) before unchoking it.
DOWNLOAD_TIMEOUT=180

TMP="${TMPDIR:-/tmp}"
WORK="$(mktemp -d "${TMP%/}/resttorrent-e2e.XXXXXX")"
export WORK PUID="$(id -u)" PGID="$(id -g)"
compose() { docker compose -f docker-compose.yml "$@"; }

cleanup() {
  status=$?
  if [ "$status" -ne 0 ]; then
    echo "--- tracker and seeder logs (tail) ---"
    compose logs --tail 100 tracker seeder || true
  fi
  compose --profile client down --volumes --remove-orphans --rmi local >/dev/null 2>&1 || true
  # The containers run as the invoking user, so everything here is ours to delete.
  rm -rf "$WORK"
  exit "$status"
}
trap cleanup EXIT

step() { printf '\n==> %s\n' "$*"; }

remote() { compose exec -T seeder transmission-remote localhost:9091 "$@"; }

# Waits until Transmission's announce has reached the tracker, so the tracker
# can hand the seeder's address to restTorrent. Transmission reports the
# torrent as Idle before its first announce goes out; a client that announces
# in that window gets no seeder back and waits a whole tracker interval
# (about 30 minutes with opentracker) before asking again.
wait_for_seeder_announce() {
  for i in $(seq 1 60); do
    trackers="$(remote -t all -it)"
    if grep -q 'Got a list of' <<<"$trackers"; then return 0; fi
    [ "$i" -eq 60 ] && { echo "$trackers"; echo "Transmission did not announce to the tracker"; exit 1; }
    sleep 1
  done
}

# Runs one restTorrent download inside the client container, bounded by
# busybox timeout so a stalled swarm fails the test in minutes rather than
# hanging until the CI job limit. The client's own trace (NODE_DEBUG) shows
# each tracker reply and every peer it tried, so a failure can be read from
# the log without rerunning. On failure, prints the swarm as Transmission
# sees it; the cleanup trap then adds the container logs.
download() {
  compose run --rm -T -e NODE_DEBUG="${NODE_DEBUG:-resttorrent}" --entrypoint timeout client \
    -k 10 "$DOWNLOAD_TIMEOUT" node /app/dist/cli.js download "$@" && return 0
  status=$?
  echo "Download failed or did not finish within $DOWNLOAD_TIMEOUT s (exit $status)"
  echo "--- tracker status as Transmission sees it ---"
  remote -t all -it || true
  exit 1
}

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
  step "Waiting for Transmission to announce to the tracker"
  wait_for_seeder_announce
  step "Downloading through the $proto tracker"
  download "/data/$proto.torrent" --out "/out/$proto"
  step "Comparing $proto download with the original"
  diff -r "$WORK/seed/payload" "$WORK/out/$proto/payload"
  echo "identical: $(find "$WORK/out/$proto/payload" -type f | wc -l | tr -d ' ') files"
done

step "Resuming: delete one file and download again"
rm "$WORK/out/http/payload/videos/trailer.bin"
wait_for_seeder_announce
download /data/http.torrent --out /out/http
diff -r "$WORK/seed/payload" "$WORK/out/http/payload"

step "End-to-end test passed"
