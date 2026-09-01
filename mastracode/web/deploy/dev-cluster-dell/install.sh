#!/usr/bin/env bash
set -euo pipefail

EXPECTED_HOST="${EXPECTED_HOST:-dev-cluster-dell}"
RUN_USER="${RUN_USER:-gp}"
WEB="${WEB:-/home/gp/projects/mastra-factory-testflight/mastracode/web}"
FACTORY_PORT="${FACTORY_PORT:-4111}"
STUDIO_PORT="${STUDIO_PORT:-3001}"

FACTORY_UNIT="/etc/systemd/system/mastra-factory.service"
STUDIO_UNIT="/etc/systemd/system/mastra-studio.service"

fail() {
  echo "ERROR: $*" >&2
  exit 1
}

need() {
  command -v "$1" >/dev/null 2>&1 || fail "Required command not found: $1"
}

echo "================================================================"
echo " Mastra Factory + Studio — dev-cluster-dell service installer"
echo "================================================================"

need sudo
need systemctl
need curl
need ss
need tailscale
need ufw
need python3
need fuser

[[ "$(hostname -s)" == "$EXPECTED_HOST" ]] || fail "Run this on $EXPECTED_HOST (current host: $(hostname -s))."
[[ -d "$WEB" ]] || fail "Mastra web directory not found: $WEB"
[[ -f "$WEB/package.json" ]] || fail "package.json not found under: $WEB"
id "$RUN_USER" >/dev/null 2>&1 || fail "Linux user does not exist: $RUN_USER"

PNPM="$(sudo -u "$RUN_USER" -H bash -lc 'command -v pnpm')" || true
[[ -n "$PNPM" && -x "$PNPM" ]] || fail "pnpm is not available for user $RUN_USER."

TAILSCALE_IPV4="$(tailscale ip -4 | head -n1)"
[[ -n "$TAILSCALE_IPV4" ]] || fail "No Tailscale IPv4 address found. Is tailscaled connected?"

TAILSCALE_DNS="$(tailscale status --json | python3 -c 'import json,sys; print(json.load(sys.stdin).get("Self",{}).get("DNSName","").rstrip("."))')" || true

UFW_STATUS="$(sudo ufw status verbose)"
grep -q '^Status: active' <<<"$UFW_STATUS" || fail "UFW must be active before exposing Factory/Studio."
grep -Eq '^Default: deny \(incoming\)' <<<"$UFW_STATUS" || fail "UFW incoming policy must be DENY. Refusing to expose development services otherwise."

echo "host=$(hostname -s)"
echo "tailscale_ipv4=$TAILSCALE_IPV4"
echo "tailscale_dns=${TAILSCALE_DNS:-unknown}"
echo "web=$WEB"
echo "pnpm=$PNPM"
echo

stop_known_port_owner() {
  local port="$1"
  local pids
  pids="$(sudo fuser -n tcp "$port" 2>/dev/null || true)"
  [[ -z "$pids" ]] && return 0

  for pid in $pids; do
    [[ "$pid" =~ ^[0-9]+$ ]] || continue

    local cmd cwd
    cmd="$(sudo tr '\0' ' ' <"/proc/$pid/cmdline" 2>/dev/null || true)"
    cwd="$(sudo readlink -f "/proc/$pid/cwd" 2>/dev/null || true)"

    if [[ "$cmd $cwd" == *"mastra-factory-testflight"* || "$cmd" == *"mastra studio"* || "$cwd" == *"/mastracode/web"* ]]; then
      echo "Stopping existing Mastra process on port $port: pid=$pid"
      echo "  $cmd"
      sudo kill -TERM "$pid" 2>/dev/null || true
    else
      fail "Port $port is owned by an unknown process (pid=$pid): $cmd"
    fi
  done

  for _ in $(seq 1 30); do
    if ! sudo fuser -n tcp "$port" >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.5
  done

  fail "Port $port did not become free after stopping the existing Mastra process."
}

echo "Stopping old manually-started Factory/Studio processes when safely identifiable..."
sudo systemctl stop mastra-studio.service 2>/dev/null || true
sudo systemctl stop mastra-factory.service 2>/dev/null || true
stop_known_port_owner "$STUDIO_PORT"
stop_known_port_owner "$FACTORY_PORT"

PATH_VALUE="$(dirname "$PNPM"):/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"

echo "Writing systemd units..."

sudo tee "$FACTORY_UNIT" >/dev/null <<EOF
[Unit]
Description=Mastra Factory development service
Documentation=https://factory.mastra.ai/
After=network-online.target tailscaled.service
Wants=network-online.target tailscaled.service

[Service]
Type=simple
User=$RUN_USER
Group=$RUN_USER
WorkingDirectory=$WEB
Environment=PATH=$PATH_VALUE
Environment=NODE_ENV=development
Environment=HOST=0.0.0.0
Environment=PORT=$FACTORY_PORT
Environment=MASTRACODE_AUTH_DISABLED=1
Environment=MASTRACODE_PUBLIC_URL=http://$EXPECTED_HOST:$FACTORY_PORT
Environment=MASTRACODE_ALLOWED_ORIGINS=http://$EXPECTED_HOST:$STUDIO_PORT,http://localhost:$STUDIO_PORT
ExecStart=$PNPM run api
Restart=on-failure
RestartSec=5
KillSignal=SIGINT
TimeoutStopSec=30

[Install]
WantedBy=multi-user.target
EOF

sudo tee "$STUDIO_UNIT" >/dev/null <<EOF
[Unit]
Description=Mastra Studio development service
After=network-online.target tailscaled.service mastra-factory.service
Wants=network-online.target tailscaled.service mastra-factory.service

[Service]
Type=simple
User=$RUN_USER
Group=$RUN_USER
WorkingDirectory=$WEB
Environment=PATH=$PATH_VALUE
ExecStart=$PNPM exec mastra studio --port $STUDIO_PORT --server-host $EXPECTED_HOST --server-port $FACTORY_PORT --server-protocol http --server-api-prefix /api
Restart=on-failure
RestartSec=5
KillSignal=SIGINT
TimeoutStopSec=20

[Install]
WantedBy=multi-user.target
EOF

echo "Restricting browser access to the Tailscale interface..."
sudo ufw allow in on tailscale0 to any port "$FACTORY_PORT" proto tcp comment 'Mastra Factory tailnet'
sudo ufw allow in on tailscale0 to any port "$STUDIO_PORT" proto tcp comment 'Mastra Studio tailnet'

sudo systemctl daemon-reload
sudo systemctl enable mastra-factory.service mastra-studio.service
sudo systemctl restart mastra-factory.service

echo "Waiting for Factory..."
for _ in $(seq 1 120); do
  if curl -fsS --max-time 2 "http://127.0.0.1:$FACTORY_PORT/" >/dev/null 2>&1; then
    break
  fi
  if ! systemctl is-active --quiet mastra-factory.service; then
    echo
    sudo journalctl -u mastra-factory.service -n 80 --no-pager
    fail "Factory service exited during startup."
  fi
  sleep 0.5
done
curl -fsS --max-time 3 "http://127.0.0.1:$FACTORY_PORT/" >/dev/null || {
  sudo journalctl -u mastra-factory.service -n 80 --no-pager
  fail "Factory did not become reachable on port $FACTORY_PORT."
}

sudo systemctl restart mastra-studio.service

echo "Waiting for Studio..."
for _ in $(seq 1 80); do
  if curl -fsS --max-time 2 "http://127.0.0.1:$STUDIO_PORT/" >/dev/null 2>&1; then
    break
  fi
  if ! systemctl is-active --quiet mastra-studio.service; then
    echo
    sudo journalctl -u mastra-studio.service -n 80 --no-pager
    fail "Studio service exited during startup."
  fi
  sleep 0.5
done
curl -fsS --max-time 3 "http://127.0.0.1:$STUDIO_PORT/" >/dev/null || {
  sudo journalctl -u mastra-studio.service -n 80 --no-pager
  fail "Studio did not become reachable on port $STUDIO_PORT."
}

echo
echo "=== SERVICE STATUS ==="
systemctl --no-pager --full status mastra-factory.service mastra-studio.service | sed -n '1,40p' || true

echo
echo "=== LISTENERS ==="
ss -ltnp | grep -E ":($FACTORY_PORT|$STUDIO_PORT)\\b" || true

echo
echo "=== AUTH CAPABILITIES ==="
curl -fsS --max-time 3 "http://127.0.0.1:$FACTORY_PORT/api/auth/capabilities" || true
echo

echo
echo "=== UFW ==="
sudo ufw status numbered | grep -E "($FACTORY_PORT|$STUDIO_PORT|tailscale0)" || true

echo
echo "================================================================"
echo " READY"
echo "================================================================"
echo
echo "Factory: http://$EXPECTED_HOST:$FACTORY_PORT"
echo "Studio:  http://$EXPECTED_HOST:$STUDIO_PORT"
echo
if [[ -n "$TAILSCALE_DNS" ]]; then
  echo "Full MagicDNS name: $TAILSCALE_DNS"
fi
echo
echo "No SSH tunnel or Windows PowerShell launcher is required."
echo "The services will start automatically on boot."
