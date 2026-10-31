# Security policy

Polyth runs coding agents that can read and change files, run commands and
reach the network on your behalf, so we treat security reports as a priority.

## Reporting a vulnerability

Please **do not open a public issue** for a security problem. Report it
privately through GitHub: open the repository's **Security** tab and choose
**Report a vulnerability**. If you cannot use GitHub, email
**max@polyth.app** instead. Include:

- what an attacker can do and under which conditions;
- the affected version or commit and your deployment (local, Docker, behind a
  proxy, desktop, Polyth Link);
- steps to reproduce, ideally a minimal proof of concept.

We will acknowledge the report, keep you updated while we investigate and
credit you in the fix unless you prefer otherwise. Please give us a reasonable
time to release a fix before any public disclosure.

## Supported versions

Security fixes go to the latest release (built from `master`) and to the
nightly builds (built from `devel`); older releases are not patched. Fixes land
on `devel` first and reach `master` with the next promotion or a dedicated
release. Please verify reports against the latest release or `devel` when you
can.

## Scope

In scope: the server, web and desktop clients, the mobile client, Polyth Link,
the Docker images and the packages in this repository. Especially interesting:
authentication and pairing, Space (tenant) isolation, permission and approval
bypasses, secret exposure (Credential Vault, logs, prompts), path traversal and
sandbox escapes in file, terminal and browser tools.

Out of scope: vulnerabilities in the third-party agent CLIs and model providers
Polyth launches (report those to their vendors), and findings that require an
already compromised host account.

## Deployment notes

The server binds loopback by default. For remote access use Polyth Link or a
TLS reverse proxy configured with `POLYTH_PUBLIC_ORIGIN` and
`POLYTH_TRUSTED_PROXIES`; never expose plain HTTP on a public interface, and
never enable `POLYTH_DEBUG_AGENT_ACCESS` outside a trusted loopback setup. See
[docs/agents/security.md](docs/agents/security.md) and
[docs/security/polyth-link-threat-model.md](docs/security/polyth-link-threat-model.md).
