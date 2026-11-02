#!/bin/bash
# Watchdog: keeps the inference-service mini service running.
# Restarts it if it dies for any reason.
cd /home/z/my-project/mini-services/inference-service
while true; do
  if ! ss -ltn 2>/dev/null | grep -q ":3003 "; then
    echo "[$(date)] starting inference-service"
    bun run dev >> /tmp/inference.log 2>&1 &
    PID=$!
    echo "[$(date)] pid=$PID"
    sleep 4
    if ! kill -0 $PID 2>/dev/null; then
      echo "[$(date)] process exited immediately, retrying"
      continue
    fi
    disown $PID 2>/dev/null || true
  fi
  sleep 10
done
