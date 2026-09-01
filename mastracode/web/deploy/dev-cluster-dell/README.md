# dev-cluster-dell: persistent Factory + Studio

This directory contains the host setup used to run Mastra Factory and Mastra Studio as persistent services on `dev-cluster-dell`.

## Result

Once installed, the normal browser URLs are:

- Factory: `http://dev-cluster-dell:4111`
- Studio: `http://dev-cluster-dell:3001`

This follows the same host-plus-port pattern used by other development-cluster services such as Grafana. No Windows PowerShell launcher, SSH port-forward, or per-session tunnel is required.

## Security model

The installer deliberately separates application authentication from network access:

- Factory runs with `MASTRACODE_AUTH_DISABLED=1` for this single-operator development deployment.
- Factory and Studio listen on the Dell so they can be reached by hostname.
- UFW **must** already be active with a default-deny incoming policy or the installer refuses to proceed.
- The installer allows ports 4111 and 3001 only on `tailscale0`.
- Tailscale access controls remain the outer access boundary.
- No secrets are written into the systemd units.

The Factory source explicitly supports `MASTRACODE_AUTH_DISABLED=1` as the operator-controlled auth opt-out. This is intended for this private dev-cluster deployment, not a public or Internet-facing Factory.

## Install

Run on `dev-cluster-dell` from the repository checkout:

```bash
cd /home/gp/projects/mastra-factory-testflight
bash mastracode/web/deploy/dev-cluster-dell/install.sh
```

The installer:

1. validates the host, repo, pnpm, Tailscale, and UFW safety preconditions;
2. stops only safely-identifiable existing Mastra processes using ports 4111/3001;
3. installs `mastra-factory.service` and `mastra-studio.service`;
4. enables both at boot;
5. adds tailnet-only UFW rules;
6. starts Factory, then Studio;
7. verifies both HTTP endpoints and prints the final URLs.

## Day-to-day operation

No shell command is normally required. Open:

```text
http://dev-cluster-dell:4111
http://dev-cluster-dell:3001
```

Useful service commands:

```bash
sudo systemctl status mastra-factory mastra-studio
sudo systemctl restart mastra-factory mastra-studio
sudo journalctl -u mastra-factory -f
sudo journalctl -u mastra-studio -f
```

## Rollback

```bash
cd /home/gp/projects/mastra-factory-testflight
bash mastracode/web/deploy/dev-cluster-dell/uninstall.sh
```

Rollback removes the systemd units and the two UFW allow rules. It does **not** remove the repository, databases, Factory state, or credentials.

## Windows prerequisite

The Windows machine must be connected to the same Tailscale tailnet with MagicDNS enabled. MagicDNS resolves the device name `dev-cluster-dell`, so no hosts-file or PowerShell configuration is required.
