# Security Policy

Session Steward runs on your machine, listens on loopback only, and can approve or deny tool permission requests for your coding agents. Reports about anything that weakens those boundaries are very welcome.

## Reporting a vulnerability

Please report privately through [GitHub Security Advisories](https://github.com/xoqiu09/session-steward/security/advisories/new). Do not open a public issue for security problems.

Include the version (`steward version`), your OS, and steps to reproduce. You should get a first response within 7 days.

## In scope

- Bypassing panel or ingest token checks, or the Host / Origin / `X-Steward` checks
- A panel decision applying to a different permission request than the one shown
- Remote access (`remote_hosts`) reaching write endpoints, `/hook/*`, or managed terminals
- Secrets, prompts or command output stored or sent beyond what the README documents
- `steward install` / `uninstall` corrupting or leaking other tools' hook configuration

## Out of scope

- Attacks that require an already compromised local user account
- Exposing the panel publicly yourself (for example with `tailscale funnel` or a public reverse proxy)
- Commands you configure yourself in `checks`, `agents` or `summary_command`
