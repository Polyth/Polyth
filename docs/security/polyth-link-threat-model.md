# Polyth Link threat model

Each row is a required mitigation. Tests live in `packages/server/test/authIngress.test.ts`,
`packages/server/test/httpTunnel.test.ts`, `packages/server/test/remotePolicyCoverage.test.ts`,
`crates/polyth-link-core`, and `packages/tunnel/test`.

Format: asset · attacker · entry · impact · mitigation · test · remaining limitation.

## QR / pairing

| Threat | Asset | Attacker | Entry | Impact | Mitigation | Test | Remaining limitation |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Photographed QR | Invite secret | Bystander | Camera | Claim race | 120s TTL, single claimant, dual confirmation | pairing TTL + claimant tests | Owner must reject a surprise device |
| Two phones scan | Invitation | Owner + thief | Same QR | Thief binds first | First valid proof binds EndpointId; others get generic invalid | `second_claimant_is_rejected` | Owner must mint a new QR |
| Expired replay | Invitation | Network | Stale ticket | Pairing | Monotonic host expiry; restart wipes invites | `restart_invalidates_invitations` | User creates a new QR after reboot |
| Brute pairingId | Invitation | Remote | Guess | Denial | 128-bit id, generic errors, rate limits | rate-limit constants | Relay still sees EndpointIds |
| Malicious QR | Device trust | Phisher | Fake ticket | Wrong host | Dial exact `host.endpointId`; no TOFU | ticket endpoint match | User must compare words |
| Auto-approve | Device trust | Thief | Scan | Instant access | Both confirmations required | `both_confirmations_required` | Social engineering of the phrase |
| Re-pair revoked | Grants | Stolen phone | Old key | Access return | Re-pair is a new invitation + local allow | store revoke tests | Admin must not restore blindly |

## Network

| Threat | Asset | Attacker | Entry | Impact | Mitigation | Test | Remaining limitation |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Hostile Wi-Fi | Session | MITM | LAN | Tamper | Iroh authenticated QUIC; no plain HTTP secure mode | protocol ALPN tests | Relay metadata (timing, size) |
| Malicious relay | Payload | Relay operator | Relay | Read | Relay cannot decrypt; no app tokens on relay | architecture | EndpointIds visible to relay |
| Direct address poison | Path | LAN | Candidate list | Downgrade | Candidates must match host EndpointId | ticket parser | Iroh still selects path |
| 0-RTT mutation | Grants | Replay | Early data | Duplicate write | `DISABLE_0RTT`; `max_tls_tickets(0)` | `zero_rtt_is_disabled_in_v1` | Depends on Iroh honoring ticket cap |

## Local host

| Threat | Asset | Attacker | Entry | Impact | Mitigation | Test | Remaining limitation |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Loopback confused deputy | Auth | Remote via tunnel | `127.0.0.1` | Local-user | Ingress kind, never address | `authIngress` tests | Unix socket file permissions |
| Spoofed internal header | Principal | Public client | Header | Tunnel principal | Public listener ignores tunnel tokens | `httpTunnel` | Operator must not expose ingress socket |
| Corrupt identity | Host key | Disk error | File | Silent new identity | Fail closed except ENOENT | identity tests | Admin recovery is manual |
| Shared data dir | Host key | Second process | Same path | Split brain | Identity lock file on create | lock path | Advisory only |

## Mobile

| Threat | Asset | Attacker | Entry | Impact | Mitigation | Test | Remaining limitation |
| --- | --- | --- | --- | --- | --- | --- | --- |
| XSS / JS dep | Device key | WebView | Renderer | Key theft | Keys never in JS/Preferences | native API surface | Renderer still sees session UI |
| Local app on proxy | API | Other app | localhost | Session steal | 256-bit bootstrap nonce + cookie | `local_proxy` tests | Same-user local attackers |
| Backup clone | Device key | Cloud backup | Restore | Identity copy | OS secure store; no Auto Backup for keys | documented | Hardware non-export not claimed |

## API / mutations

| Threat | Asset | Attacker | Entry | Impact | Mitigation | Test | Remaining limitation |
| --- | --- | --- | --- | --- | --- | --- | --- |
| SSRF / CONNECT | LAN | Paired device | Path | Other services | Fixed target, relative paths only | `absolute_urls_are_denied` | Canonical Polyth APIs remain |
| Grant bypass | Routes | Paired device | Unknown path | Extra API | Default deny + manifests | remote policy coverage | New packages must declare policy |
| Blind POST retry | Mutations | Transport | Drop | Duplicate | Mutations return outcome-unknown | protocol retry helpers | UI must reconcile |
| Stale grants | Terminal | Revoked cap | Open WS | Continued use | Grant revision + connection close | revoke closes map | In-flight streams need host reset |
