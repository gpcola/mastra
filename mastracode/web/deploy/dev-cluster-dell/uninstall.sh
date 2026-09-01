#!/usr/bin/env bash
set -euo pipefail

FACTORY_PORT="${FACTORY_PORT:-4111}"
STUDIO_PORT="${STUDIO_PORT:-3001}"

echo "Removing Mastra Factory/Studio persistent dev-cluster services..."

sudo systemctl disable --now mastra-studio.service 2>/dev/null || true
sudo systemctl disable --now mastra-factory.service 2>/dev/null || true

sudo rm -f /etc/systemd/system/mastra-studio.service
sudo rm -f /etc/systemd/system/mastra-factory.service
sudo systemctl daemon-reload
sudo systemctl reset-failed mastra-studio.service mastra-factory.service 2>/dev/null || true

sudo ufw delete allow in on tailscale0 to any port "$FACTORY_PORT" proto tcp 2>/dev/null || true
sudo ufw delete allow in on tailscale0 to any port "$STUDIO_PORT" proto tcp 2>/dev/null || true

echo "Removed."
echo "The repository and application data were not changed."
