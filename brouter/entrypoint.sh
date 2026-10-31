#!/bin/bash
# ── BRouter indítása és a térképadat-csempék frissítése ──────────────────────
# - Hiányzó csempét induláskor letölt (ilyenkor a szerver csak utána indul).
# - UPDATE_DAYS naponta (vagy ha az admin kéri: /data/update.request) feltételesen
#   újra letölti a csempéket (If-Modified-Since); ha valamelyik változott, a szervert
#   újraindítja. A letöltés ideiglenes fájlba megy, a régi csempe addig használható.
# - Állapot: /data/status.json (az admin felület ebből olvas).

SEG=/data/segments4
STATUS=/data/status.json
REQUEST=/data/update.request
LAST_CHECK=/data/.last_check
mkdir -p "$SEG"

log() { echo "[brouter] $*"; }
now() { date -u +%Y-%m-%dT%H:%M:%SZ; }

STATE="starting"; ERROR=""
write_status() {
  local tiles="" sep=""
  for t in $TILES; do
    local f="$SEG/$t.rd5"
    if [ -f "$f" ]; then
      tiles="$tiles$sep{\"name\":\"$t\",\"size_mb\":$(( $(stat -c %s "$f") / 1048576 )),\"modified\":\"$(date -u -r "$f" +%Y-%m-%dT%H:%M:%SZ)\"}"
    else
      tiles="$tiles$sep{\"name\":\"$t\",\"size_mb\":0,\"modified\":null}"
    fi
    sep=","
  done
  local checked="null"; [ -f "$LAST_CHECK" ] && checked="\"$(date -u -r "$LAST_CHECK" +%Y-%m-%dT%H:%M:%SZ)\""
  printf '{"state":"%s","version":"%s","tiles":[%s],"last_check":%s,"updated_at":"%s","error":"%s"}\n' \
    "$STATE" "$BROUTER_VERSION" "$tiles" "$checked" "$(now)" "$ERROR" > "$STATUS.tmp" && mv "$STATUS.tmp" "$STATUS"
}

# 0: semmi nem változott, 1: legalább egy csempe frissült
fetch_tiles() {
  local changed=0
  STATE="downloading"; ERROR=""; write_status
  for t in $TILES; do
    local f="$SEG/$t.rd5" code
    if [ -f "$f" ]; then
      code=$(curl -sS -R -z "$f" -o "$f.part" -w '%{http_code}' --retry 3 --connect-timeout 20 "$SEGMENTS_URL/$t.rd5")
    else
      code=$(curl -sS -R -o "$f.part" -w '%{http_code}' --retry 3 --connect-timeout 20 "$SEGMENTS_URL/$t.rd5")
    fi
    if [ "$code" = "200" ] && [ "$(stat -c %s "$f.part" 2>/dev/null || echo 0)" -gt 1000000 ]; then
      mv "$f.part" "$f"; changed=1; log "$t frissítve"
    elif [ "$code" = "304" ]; then
      rm -f "$f.part"; log "$t naprakész"
    else
      rm -f "$f.part"; ERROR="$t letöltése nem sikerült (HTTP $code)"; log "$ERROR"
    fi
  done
  touch "$LAST_CHECK"
  return $changed
}

PID=""
start_server() {
  java -Xmx"$JAVA_MEM" -Xms256m -DmaxRunningTime=300 -DuseRFCMimeType=false \
    -cp /opt/brouter/brouter.jar btools.server.RouteServer \
    "$SEG" /opt/brouter/profiles2 /opt/brouter/customprofiles 17777 "$THREADS" 0.0.0.0 &
  PID=$!
  STATE="running"; write_status
  log "szerver elindult (pid $PID)"
}
stop_server() { [ -n "$PID" ] && kill "$PID" 2>/dev/null && wait "$PID" 2>/dev/null; PID=""; }
trap 'stop_server; exit 0' TERM INT

# Első indulás: hiányzó csempék letöltése
missing=0
for t in $TILES; do [ -f "$SEG/$t.rd5" ] || missing=1; done
[ "$missing" = 1 ] && fetch_tiles
start_server

while true; do
  sleep 60 & wait $!
  due=0
  if [ -f "$REQUEST" ]; then rm -f "$REQUEST"; due=1; log "frissítés kérve (admin)"; fi
  if [ ! -f "$LAST_CHECK" ] || [ -n "$(find "$LAST_CHECK" -mtime +"$((UPDATE_DAYS - 1))" 2>/dev/null)" ]; then due=1; fi
  if [ "$due" = 1 ]; then
    if ! fetch_tiles; then stop_server; start_server; else STATE="running"; write_status; fi
  fi
  # ha a szerver leállt (pl. memóriahiány), újraindítjuk
  if [ -n "$PID" ] && ! kill -0 "$PID" 2>/dev/null; then log "a szerver leállt – újraindítás"; start_server; fi
done
