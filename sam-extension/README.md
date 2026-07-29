# SAM — Splunk API Management

A Chrome (Manifest V3) extension for Splunk Cloud ACS administration. This first
version covers **IP allow list management**, built against GovCloud IL2 as the
primary target, with commercial supported by the same code path.

## What it does

Reads and writes the ACS IP allow list for a stack, replacing the curl runbook:

| Action | Method | Endpoint |
| --- | --- | --- |
| View current allow list | `GET` | `/{stack}/adminconfig/v2/access/{feature}/ipallowlists` |
| Add subnets | `POST` | same, body `{"subnets": [...]}` |
| Remove subnets | `DELETE` | same, body `{"subnets": [...]}` |

IPv6 uses the `ipallowlists-v6` suffix. Feature types are `search-api`,
`search-ui`, `hec`, and `s2s`.

## Environment routing

The Environment selector picks the ACS host:

- **GovCloud IL2 (FedRAMP Moderate)** → `https://admin.splunkcloudgc.com`
- **GovCloud IL2 — Staging** → `https://staging.admin.splunkcloudgc.com`
- **Commercial** → `https://admin.splunk.com`
- **Commercial — Staging** → `https://staging.admin.splunk.com`

GovCloud is the default and is visually distinguished (purple badge plus a
banner) so it is never ambiguous which boundary you are operating in. Staging
environments carry a `· STAGING` badge suffix.

**Staging vs dev stacks:** ACS works with staging stacks — same API signature,
staging host (the ACS CLI equivalent is `--server=https://staging.admin.splunk.com`).
ACS does **not** work with dev stacks, which is why no dev environment exists
in the selector. The "Copy as curl" output routes to the right host
automatically because the host is baked into the URL.

Experience (Classic by default, or Victoria) is stored on the connection
profile. IP allow
list endpoints are identical across both experiences, so it does not affect
routing today — it is captured because apps and index endpoints do branch on it,
and that is the next surface to build.

## Public IP validation

Every subnet is validated locally **before any request leaves the browser**.
A subnet is rejected if it is malformed or if it is not public, routable space.

Rejected IPv4 blocks: `0.0.0.0/8`, `10.0.0.0/8`, `100.64.0.0/10` (CGNAT),
`127.0.0.0/8`, `169.254.0.0/16`, `172.16.0.0/12`, `192.0.0.0/24`, `192.0.2.0/24`,
`192.88.99.0/24`, `192.168.0.0/16`, `198.18.0.0/15`, `198.51.100.0/24`,
`203.0.113.0/24`, `224.0.0.0/4`, `240.0.0.0/4`.

Rejected IPv6 blocks: `::/128`, `::1/128`, `::ffff:0:0/96`, `64:ff9b::/96`,
`100::/64`, `2001:db8::/32`, `fc00::/7` (ULA), `fe80::/10`, `ff00::/8`.

Validation works on integer ranges rather than string prefixes, so it also
catches **partial overlaps**. `10.0.0.0/7` spans both private `10.x` and public
`11.x` space and is rejected with an explanation, where a naive prefix check
would let it through. `0.0.0.0/0` and `::/0` are rejected outright.

Other checks: octet range and leading-zero rejection, prefix length bounds,
malformed IPv6 (`2600:::1`, stray colons, multiple `::`), de-duplication, and
host-bit normalization — `34.210.15.7/24` is corrected to `34.210.15.0/24` with
a notice rather than being silently sent.

## Safety behaviour

- **Confirm step on every write**, showing exactly which subnets change.
- **Type-to-confirm on removals**: the Remove button stays disabled until the
  operator types `DELETE` into the confirm dialog, so a destructive change can
  never be two reflexive clicks.
- **Lockout warnings** on `search-api` and `search-ui` removals, and an explicit
  warning when a removal would empty an allow list (which denies all access).
- **Automatic re-read after every write.** SAM re-runs the `GET` and confirms the
  change actually landed, reporting a mismatch if ACS accepted the request but
  the list does not reflect it. This is the "confirm the subnet was added" step
  from the runbook, done automatically.
- **Copy as curl** on every confirm dialog, so the exact equivalent command can
  be pasted into a ticket, runbook, or change record. The read path has its own
  **"Show curl"** toggle on the IP Allow List panel, which reveals the equivalent
  `GET` for the current environment, stack, feature, and IP version and updates
  live as those change. All curl output uses a placeholder token — the real
  token is never rendered.
- **Activity log** of the session's requests — method, path, status, latency.

## Getting a token

The Connection panel has a **"? How do I get one"** disclosure next to the token
field (auto-expanded on first run, and available as a hover tooltip on the input
itself). It documents the procedure:

On the Splunk Cloud stack **ad hoc search head**:

1. Go to **Settings → Tokens → New Token**
2. Create the token. A long token string is generated.
3. Copy the token immediately and save it somewhere secure.

The token will not be viewable again after the dialog box is closed.

## Token handling

The API token is held by the service worker in `chrome.storage.session` only,
with access explicitly pinned to trusted contexts.

- Never written to `localStorage` or `chrome.storage.local`.
- Never returned to the popup after it is saved.
- **Self-destructs 60 minutes after save** — a fixed lifetime; no amount of
  activity extends it. A countdown badge in the top bar shows the time
  remaining and turns amber for the final five minutes. Re-saving the token
  restarts the clock.
- **Cleared on screen lock**, so stepping away from the machine ends the
  session's credential.
- Cleared when the browser closes, or manually via **Clear token**.
- **Shape-validated on save**: the worker refuses anything that is not a
  three-segment JWT, so a mispasted secret (an AWS key, a password) is never
  stored or transmitted.
- The message listener rejects senders other than the extension itself.
- Only the stack, environment, experience, and feature selection persist to disk.

Host permissions are scoped to the two ACS hosts and nothing else. All requests
originate from the extension's background context, which is what avoids CORS.

## Install

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. **Load unpacked** → select this folder

Or run `npm run package` to build `sam-extension.zip`.

## Develop without loading the extension

Opening `popup.html` directly does not work: Chrome blocks ES modules over
`file://`, and `chrome.*` does not exist outside an extension. The dev harness
solves both by serving the real `popup.html` and injecting a mock `chrome` API
at request time — there is no duplicate copy of the markup to drift.

```
npm install
npm run dev          # http://localhost:8910
```

The index links the popup, the style guide, and every scenario:

| Scenario | Shows |
| --- | --- |
| `?scenario=fresh` | First run — no token, no profile |
| `?scenario=populated` | Three subnets on the Search API list |
| `?scenario=empty` | Allow list returns nothing |
| `?scenario=error` | ACS returns 403 |
| `?scenario=slow` | 2.5s latency, for loading states |
| `?reset=1` | Clear stored profile, token, and fixtures |

## Design system

Tokens and components live in `design/`, documented in
[`design/DESIGN-SYSTEM.md`](design/DESIGN-SYSTEM.md) and rendered live at
`/design/styleguide.html` from the same stylesheets the popup loads.

`popup.css` is now four lines — the popup shell only. Everything visual comes
from `design/tokens.css` and `design/components.css`, and the linter fails the
build if a raw colour or duration appears outside the token layer.

## Test

```
npm run check                  # validator suite + WCAG contrast audit
node tools/lint-system.mjs     # token, class, and id consistency
npm run shoot /tmp/shots       # capture all 10 UI states
npm run diff before/ after/    # pixel-diff two capture directories
```

`npm test` runs 60 assertions covering address validation, reserved-block
overlap detection, URL routing for both environments, curl parity with the
documented commands, and removal risk assessment. `npm run contrast` checks 23
colour pairings against WCAG 2.1 AA.

## Layout

```
manifest.json      MV3 manifest, host permissions
acs.js             routing, validation, curl builder — no secrets, fully testable
background.js      service worker: token custody, fetch, error humanizing
popup.html/js      UI markup and behaviour
popup.css          popup shell only — width and scroll
design/            tokens, components, style guide, system docs
icons/             generated by tools/make_icons.py
test/              node test suite
tools/             dev server, mock chrome API, linter, contrast audit,
                   screenshot harness, visual diff, packager
```

## Notes

The icon is an original chevron mark, not a Splunk trademark asset. Replace
`icons/*.png` (or re-run `tools/make_icons.py`) before any internal distribution
that should carry official branding.

## References

- [ACS usage](https://docs.splunk.com/Documentation/SplunkCloud/latest/Config/ACSusage)
- [Configure IP allow list with ACS](https://docs.splunk.com/Documentation/SplunkCloud/latest/Config/ConfigureIPAllowList)
