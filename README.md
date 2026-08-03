# Splunk ACS Helper

A Chrome (Manifest V3) extension for configuring Splunk Cloud IP allow lists
through the Admin Config Service (ACS). Stop hunting for the right curl
command: pick the stack and the feature, see what is currently allowed, and
make changes that are confirmed, validated, and verified before and after they
land.

Internal codename **SAM**, which the source tree and tooling still use.

## Install

1. Download the latest `splunk-acs-helper-X.Y.Z.zip` from
   [Releases](https://github.com/rephillips/sam/releases/latest) and unzip it.
2. Open `chrome://extensions` and enable **Developer mode**.
3. Choose **Load unpacked** and select the unzipped folder.

Chrome will ask you to approve the ACS host permissions on first load.

## What it does

- **Every ACS feature**: `search-api`, `search-ui`, `hec`, `s2s`, `acs`,
  `idm-ui`, `idm-api`, each naming the port it opens and what removing a
  subnet from it costs. The three that can lock you out of your own access
  (`search-api`, `search-ui`, and `acs`, which is the API this extension
  itself uses) raise that warning on the confirm dialog.
- **Four environments**: GovCloud IL2 and Commercial, each with a staging host
  (`staging.admin.*`). ACS does not serve dev stacks, so none is offered.
- **View, add, and delete** from one panel, with the feature named above the
  rows so a loaded list is never mistaken for another one.
- **Local validation first**: subnets must be public, routable space in CIDR
  notation. Private, loopback, link-local, CGNAT, and documentation ranges are
  rejected before any request leaves the browser, and a bare address is never
  silently treated as a `/32`.
- **Writes you can check**: each change shows the exact subnets affected plus
  the equivalent curl, removals require typing `DELETE`, and the list is
  re-read afterwards to confirm the change actually landed.
- **An activity log** of the session's requests with timestamps, status,
  latency, and the curl for each one.

## Token handling

The API token is held by the service worker in `chrome.storage.session` only.
It is never written to disk, never returned to the popup, and never rendered
on screen. It self-destructs 60 minutes after being saved, shown as a burning
fuse around the countdown in the top bar, and is cleared immediately when the
screen locks.

Curl is always displayed with a placeholder token. **Copy** substitutes the
real one so the command runs when pasted, which means a copied command should
be treated as a live credential.

## Development

```
cd sam-extension
npm run dev          # harness at http://localhost:8910
```

The harness needs no dependencies. `npm install` is only for the screenshot
tooling (`npm run shoot`), which pulls in Playwright.

The harness serves the real popup against a mock `chrome.*` API, so you can
iterate without packing and reloading the extension. Append
`?scenario=fresh|populated|empty|error|slow`, `&reset=1`, `&ttl=<seconds>` to
watch the token fuse burn down, or `&windowed=1` for the resizable layout.

Run all three gates before committing:

```
node tools/lint-system.mjs     # tokens, classes, and ids are consistent
node tools/contrast.mjs        # every colour pairing holds WCAG 2.1 AA
node test/validate.test.mjs    # validators, routing, and curl parity
```

## Layout

```
sam-extension/
  manifest.json      MV3 manifest and host permissions
  acs.js             routing, validation, curl builder. No secrets, fully testable
  background.js      service worker: token custody, fetch, error humanising
  popup.html/js      UI markup and behaviour
  design/            tokens, components, living style guide, system documentation
  test/              node test suite
  tools/             dev server, mock chrome API, linter, contrast audit, packager
CONTRIBUTING.md      working rules: design system semantics, gates, invariants
```

## Documentation

- [Extension reference](sam-extension/README.md), including the full feature
  table and the validation rules
- [Design system](sam-extension/design/DESIGN-SYSTEM.md), rendered live at
  `/design/styleguide.html` from the same stylesheets the popup loads
- [Configure IP allow lists with ACS](https://docs.splunk.com/Documentation/SplunkCloud/latest/Config/ConfigureIPAllowList)
- [ACS usage](https://docs.splunk.com/Documentation/SplunkCloud/latest/Config/ACSusage)

## Notes

The icon is an original chevron mark, not a Splunk trademark asset. Replace
`icons/*.png` (or re-run `tools/make_icons.py`) before any distribution that
should carry official branding.
