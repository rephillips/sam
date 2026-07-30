# Splunk ACS Helper (codename SAM)

Chrome MV3 extension for Splunk Cloud ACS administration (IP allow lists).
All code lives in `sam-extension/`. Repo: https://github.com/rephillips/sam.

## Commits

- **Never add co-author or tooling trailers to commit messages** — they were
  removed from history and are not wanted back. The commit author is the only
  attribution this repo carries.
- Every functional change: run the gates (below), verify in the dev harness,
  commit with a plain descriptive message, push to `main`.
- Version bumps (`npm version X --no-git-tag-version` + sed the manifest)
  happen when the user asks for a build; rebuild with `npm run package` AFTER
  bumping so the zip's manifest carries the new version.

## Build gates — run before every commit

```
node tools/lint-system.mjs     # tokens/classes/ids consistency — must pass
node tools/contrast.mjs        # WCAG AA audit (25 pairs) — must pass
node test/validate.test.mjs    # validators, routing, curl parity — must pass
```

If a contrast pair fails, the colour value is wrong — not the test.

## Design system semantics (design/DESIGN-SYSTEM.md is the full reference)

- **Tokens are the only source of values.** `design/tokens.css` is the ONLY
  file allowed to contain a raw colour, size, or duration. Components
  (`design/components.css`) reference semantic tokens only — never the
  primitive ramp. The linter enforces this.
- **Two tiers**: primitives (`--green-500`, `--slate-800`) → semantics
  (`--accent`, `--panel`, `--danger`). Retheming = editing the semantic layer.
- **Colour = meaning, never decoration**:
  - **Green** (`--accent`, `#27c987` family) — safe/routine/success: primary
    actions, links, focus, the token countdown. A deliberate user choice;
    do not revert to teal or solid-fill buttons.
  - **Red** (`--danger`) — destructive only.
  - **Amber** (`--warn`) — read-before-confirm; countdown's final 5 minutes.
  - **Violet** (`--gov`) — FedRAMP/GovCloud IL2 signalling ONLY. Never use
    violet for ordinary emphasis.
- **Buttons are tonal**: translucent hue wash + matching border + bright
  same-hue label (`--accent-soft*`, `--danger-soft*`) — not solid slabs.
- **Tooltips are hover/focus-only** (`.tip` + `data-tip` on a `.tip-glyph` ⓘ
  button) — never click-to-open, and never rely on native `title` (unreliable
  in extension popups). Actionable content goes in callouts/modals instead.
- **Status lines are per-panel**: IP-list operations report in `#listStatus`
  inside the IP Allow List panel; connection/token concerns in `#connStatus`.
  Never write a message into a panel the operator may have collapsed.
- **Destructive flow**: confirm modal shows exact subnets + equivalent curl,
  and requires typing `DELETE` before the danger button enables.
- New/changed components must be rendered in `design/styleguide.html` (the
  living guide) — the linter warns on components missing from it.

## Security invariants — do not weaken

- The API token lives ONLY in the service worker's `chrome.storage.session`
  (never storage.local/localStorage, never returned to the popup — `hasToken`
  is a boolean + expiry). It self-destructs 60 min after save (chrome.alarms),
  clears on screen lock (chrome.idle), and the worker refuses non-JWT-shaped
  values and non-extension message senders.
- Every curl rendered anywhere uses a placeholder token, never the real one.
- Subnets are validated locally (public, routable space only — integer-range
  checks in `acs.js`) before any request leaves the browser.
- The dev harness mock must never be weaker than the real thing: token in an
  in-memory Map, refuses real-JWT-shaped values.

## Dev workflow

```
cd sam-extension && npm run dev    # harness at http://localhost:8910
```

Scenarios: `popup.html?scenario=fresh|populated|empty|error|slow`, `&reset=1`
to clear state, `&ttl=<seconds>` to watch the token countdown expire quickly,
`&windowed=1` for the fluid windowed layout. The harness footer version reads
"dev" on purpose. Verify UI changes in the Browser pane before committing.

## Environments & features (acs.js is the single source of truth)

Four environments (GovCloud IL2 + staging, Commercial + staging) — staging
uses `staging.admin.*` hosts; ACS does NOT serve dev stacks. Seven features:
search-api, search-ui, hec, s2s, acs, idm-ui, idm-api. The UI is IPv4-only;
v6 plumbing stays in `acs.js`. Manifest `host_permissions` must cover every
environment host.
