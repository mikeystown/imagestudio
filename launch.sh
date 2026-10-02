#!/usr/bin/env bash
# Starts the Image Studio server if needed, then opens it in a standalone browser window.
DIR="$(cd "$(dirname "$(readlink -f "$0")")" && pwd)"
PORT="${PORT:-5173}"
URL="http://127.0.0.1:$PORT"
LOG="$DIR/server.log"

if ! curl -sf -m 2 -o /dev/null "$URL/"; then
  cd "$DIR" && nohup node server.js >"$LOG" 2>&1 &
  for _ in $(seq 1 50); do
    curl -sf -m 2 -o /dev/null "$URL/" && break
    sleep 0.1
  done
  if ! curl -sf -m 2 -o /dev/null "$URL/"; then
    notify-send -i dialog-error "Image Studio failed to start" "$(tail -n 3 "$LOG")" 2>/dev/null
    exit 1
  fi
fi

if command -v brave >/dev/null; then
  exec brave --app="$URL" --class=ImageStudio
else
  exec xdg-open "$URL"
fi
