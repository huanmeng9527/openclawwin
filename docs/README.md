# TLS Setup Guide

OpenClaw Gateway is designed to run **behind a TLS-terminating reverse proxy**.
This keeps the gateway code simple and delegates TLS to a battle-tested layer.

## Architecture

```
Internet  ← HTTPS/WSS →  [Caddy / Nginx]  ← HTTP/WSS →  [Gateway :8080]
                            ↑                      ↑
                      handles TLS               plaintext only
                      issues cert               (127.0.0.1 only)
```

## Quick Start

### Option A: Caddy (Recommended)

```bash
# 1. Edit Caddyfile with your domain
cp Caddyfile /etc/caddy/Caddyfile
nano /etc/caddy/Caddyfile   # set your domain

# 2. Start gateway directly (no TLS in gateway)
python -c "
from openclaw_runtime.gateway import Gateway, GatewayConfig, TLSConfig
gw = Gateway(GatewayConfig(
    workspace='./workspace',
    tls=TLSConfig(enabled=False),  # trust upstream proxy
))
gw.serve_http(host='127.0.0.1', port=8080)
"
```

### Option B: Docker Compose (Production)

```bash
cp .env.example .env
nano .env   # set DOMAIN and EMAIL
docker compose up -d
```

## Files

| File | Purpose |
|------|---------|
| `Caddyfile` | Caddy reverse proxy config with TLS, WSS, security headers |
| `nginx-tls-proxy.conf` | Nginx equivalent config |
| `docker-compose.yml` | Full stack: Gateway + Caddy in containers |
| `.env.example` | Environment variables template |

## Security Notes

- **Never expose gateway directly to the internet**
- Gateway binds to `127.0.0.1:8080` only — the proxy is the only public-facing component
- TLS 1.2 minimum, no legacy SSL/TLS 1.0/1.1
- HSTS header set with `max-age=31536000`
- Client connections rate-limited at the proxy layer
