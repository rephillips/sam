# SAM Design System

SAM is an operator tool. Someone uses it to change the network boundary of a
production Splunk Cloud stack, sometimes a FedRAMP-audited one, often while
something is already on fire. That single fact drives every decision here: the
interface has to be legible under stress, it must never make a destructive
action look routine, and it must never quietly fail to tell someone what
happened.

This document is the reference. The executable version is
`design/styleguide.html`, which renders every token and component from the same
stylesheets the extension loads. When the two disagree, the style guide is
right and this file is stale.

## Files

| File | Role |
| --- | --- |
| `design/tokens.css` | Every raw value in the system. The only file permitted to contain a literal colour, size, or duration. |
| `design/components.css` | Every component, composed entirely from tokens. |
| `popup.css` | The popup shell — width and scroll behaviour. Nothing else. |
| `design/styleguide.html` | Living documentation, rendered from the real stylesheets. |
| `tools/lint-system.mjs` | Fails the build when the rules below are broken. |
| `tools/contrast.mjs` | Fails the build when a colour pairing drops below WCAG AA. |

## Principles

**Tokens are the only source of values.** A component that hardcodes `#00b5a0`
is a component that cannot be rethemed, cannot be audited for contrast, and
will drift the moment someone copies it. The linter enforces this rather than
trusting discipline, because discipline is exactly what erodes under deadline.

**Two tiers, and the indirection earns its keep.** Primitives (`--teal-500`)
name colours. Semantics (`--accent`, `--danger`, `--gov`) name meanings, and
components only ever reference semantics. That is what makes a Splunk-branded
theme or a light mode a change to one file instead of a change to ninety rules.

**Severity is encoded, not decorated.** Green is the safe, routine register —
it carries the primary action, links, focus, and success. Red is destructive.
Amber says read this before you confirm. Violet means FedRAMP, and
means nothing else — the moment violet is used for ordinary emphasis, the one
visual signal that tells an operator they are in an audited environment stops
being a signal.

**Accessibility is a build gate, not a review step.** Twenty-three colour
pairings are checked on every run. This is not box-ticking: the original UI had
input borders at 1.34:1 against their panel, which is close enough to invisible
that a low-vision operator could not locate the field they were about to type a
production credential into.

**The system covers what SAM needs and stops.** Table, tabs, toast, empty
state, and skeleton exist because the ACS roadmap needs them. There is no
grid system, no icon library, and no six-size button scale, because a 430px
popup will never use them and unused abstraction is a maintenance liability
dressed as foresight.

## Using it

The dev harness renders the real popup against a mock `chrome.*` API, so you
can iterate on CSS without packing and reloading an extension:

```
npm install
npm run dev          # http://localhost:8910
```

The index page links the popup, the style guide, and every popup scenario —
first run, populated, empty list, ACS error, slow network. Edit CSS, refresh.

Before committing:

```
npm run check        # validator tests + contrast audit
node tools/lint-system.mjs
```

## Tokens

### Surfaces

| Token | Value | Use |
| --- | --- | --- |
| `--bg` | `#0e1117` | Application background |
| `--panel` | `#161b24` | Panel headers and cards |
| `--panel-2` | `#1c2230` | Raised rows inside a panel |
| `--surface-code` | `#0b0f16` | Inputs, code blocks, inset areas |
| `--scrim` | `rgba(0,0,0,.72)` | Modal backdrop |

### Boundaries

The distinction between these two is a WCAG requirement, and getting it wrong
is the easiest way to fail an audit.

| Token | Value | Contrast rule |
| --- | --- | --- |
| `--line` | `#2a3242` | Separates regions. Decorative, exempt from contrast minimums. |
| `--line-strong` | `#5b6c8e` | Outlines controls the user must find. Holds ≥3:1 on every surface (WCAG 1.4.11). |

### Text

| Token | Value | Minimum ratio held |
| --- | --- | --- |
| `--text` | `#e6edf3` | 13.46:1 |
| `--muted` | `#8b98a9` | 5.42:1 |
| `--text-faint` | `#7d8a9a` | 4.91:1 |

### Intent

Each intent supplies a solid for fills, a `-fg` for text on dark surfaces, and
a `-bg` / `-line` pair for tinted callouts.

| Intent | Solid | Foreground | Meaning |
| --- | --- | --- | --- |
| accent | `--accent` | `--accent-hi`, `--ok-fg` | Routine, safe, success |
| danger | `--danger` | `--danger-fg` | Removes access or data |
| warn | `--warn` | `--warn-fg` | Read before confirming |
| gov | `--gov` | `--gov-fg` | FedRAMP / GovCloud IL2 only |

The product **accent is a modern green** (`--green-600/500/400`): `--accent` =
`--green-500`, `--accent-hi` = `--green-400`. It carries link text, success, the
active tab, focus, callout titles, and info tints, so the accent reads as one
colour everywhere it appears — not just on the button. Teal (`--teal-*`) is
retired from the accent role and kept only as a primitive for reference.

The **primary and danger buttons are tonal**, not solid fills: a translucent
wash of the hue over the surface, a matching border, and a bright same-hue label
rather than an ink.

| Button | Fill / hover / active | Label | Border |
| --- | --- | --- | --- |
| primary (green) | `--accent-soft` · `--accent-soft-hover` · `--accent-soft-active` | `--accent-soft-fg` | `--accent-soft-line` |
| danger (red) | `--danger-soft` · `--danger-soft-hover` · `--danger-soft-active` | `--danger-fg` | `--danger-soft-line` |

The tonal fills are washes, so their label contrast is checked against the fill
*composited over the panel* — that is the pairing `npm run contrast` audits, not
the raw hue.

### Type

Six sizes: `--fs-2xs` 9px, `--fs-xs` 10.5px, `--fs-sm` 11.5px, `--fs-md` 13px,
`--fs-lg` 14px, `--fs-xl` 15px. The pre-system popup had drifted to ten sizes,
several separated by half a point, which at this scale reads as inconsistency
rather than hierarchy.

### Space, radius, motion

Space is a 4px base with 2px half-steps (`--space-1` through `--space-10`);
prefer even steps outside dense controls. Radius runs `--radius-xs` 3px through
`--radius-lg` 9px. Durations live in tokens (`--dur-fast`, `--dur-med`,
`--dur-spin`, `--dur-shimmer`) specifically so `prefers-reduced-motion` can zero
every animation in the system from one place.

## Components

### Button

Variants are `--primary`, `--ghost`, `--danger`, plus `--full` and `--sm`
modifiers. States are default, hover, active, disabled, and `is-loading`.

The primary and danger buttons are **tonal**: a translucent fill of the intent
hue over the surface, a matching border, and a bright same-hue label — not a
solid slab with ink text. The primary is a modern green, distinct from the teal
product accent; danger is red. Ghost stays a bordered transparent button.

Only one primary button per panel — it names the action the panel exists for.
Destructive confirmation uses `--danger`, and always behind a modal that shows
exactly what will change. Because the tonal danger fill is quieter than the old
solid red slab, the modal — spelling out exactly which subnets change, with the
equivalent `curl` — is what carries the weight of "this is destructive," not the
button colour alone. The loading state deliberately keeps the button's width by
making the label transparent and drawing the spinner over it, so nothing below
shifts mid-request.

Keyboard behaviour is native `<button>` throughout: Tab reaches it, Enter and
Space activate it. Icon-only buttons carry an `aria-label` naming the specific
target ("Remove 52.24.108.7/32"), never a bare "Remove".

### Field

`.field` wraps a label and control; `.field__hint` carries the explanatory line
underneath; `.field__labelrow` handles a label with a trailing action, like the
token help toggle. Controls take `--line-strong` borders and show both a colour
change and a ring on focus, so focus does not rely on colour alone.

### Callout and Notice

Both carry contextual messages, and they are not interchangeable. A **Notice**
spans the popup edge to edge and describes the whole session — the FedRAMP
banner is the only current instance. A **Callout** is inset and describes the
field beside it.

Callout variants map to intent: `--info` explains, `--warn` says read this
before confirming, `--danger` reports a failure, `--gov` marks an audited
environment.

These four replaced what had become four separately-maintained boxes
(`.help`, `.help-warn`, `.warn-box`, `.gov-notice`) with nearly identical rules
and slightly different padding.

### Status line

`.status--ok`, `--err`, `--info`. Carries the outcome of the last action, with
`role="status"` and `aria-live="polite"` so screen readers announce results
without stealing focus.

**Known issue:** the popup's only status line lives inside the Connection
panel, which auto-collapses after a successful connection. Validation failures
from the IP Allow List panel therefore write to an element the operator cannot
see, and the interface appears to do nothing. The `.toast` component was built
to fix this; the wiring has not been done.

### Item list, Table, Tabs

`.item-list` renders monospace rows with a trailing action — allow list
subnets today. `.table` handles tabular data with `--mono` and `--num` cell
modifiers, `--num` using tabular figures so columns align. `.tabs` uses
`.tab.is-active`; it now drives the IP Allow List panel's View / Add / Delete
switch, wired in `popup.js` with `role="tablist"`, `aria-selected`, a roving
`tabindex`, and arrow-key navigation (the CSS alone does not provide these).
Visible focus comes from the global `:focus-visible` rule, so tabs need no
focus style of their own.

### Toast

Transient confirmation, fixed to the bottom of the popup. Use it only for an
outcome the operator can afford to miss. Anything they must act on belongs in a
status line or a modal, because those do not disappear.

### Empty state

For "nothing here yet", with a title, an explanation, and the action that
resolves it. A failed request is **not** an empty state — it is actionable in a
different way and belongs in a danger callout.

### Modal

`.modal__card` with title, body, and right-aligned actions. Closes on Escape,
on backdrop click, and on Cancel. Carries `role="dialog"`, `aria-modal`, and
`aria-labelledby`.

SAM's confirm dialog always shows the exact subnets affected and the equivalent
`curl`, so an operator can see precisely what is about to happen and reproduce
it outside the extension if they would rather. Destructive confirms add a
type-to-confirm challenge: the danger button stays disabled until the operator
types `DELETE` exactly, which converts "two reflexive clicks" into a deliberate
act. The challenge input is auto-focused on open and Enter submits once the
word matches. Focus is not yet trapped inside the card — that is an open gap.

### Skeleton

Use only where the final layout is already known, so nothing shifts when data
arrives. Otherwise put the spinner on the button that started the request.

## Accessibility contract

Every pairing in `tools/contrast.mjs` holds WCAG 2.1 AA: 4.5:1 for text, 3:1
for interactive boundaries and focus indicators. Twenty-three pairings are
checked and all pass.

Focus is visible on every interactive element and is never removed without an
equally visible replacement. Status changes are announced via `aria-live`.
Colour is never the sole carrier of meaning — status text is prefixed by words,
and the environment badge states "GOVCLOUD IL2" rather than relying on violet.

Two gaps remain, both documented above: the modal does not trap focus, and the
status line can render inside a collapsed panel.

## Changing the system

To change a value, edit `tokens.css` and run `npm run contrast`. If a pairing
fails, the value is wrong — not the test.

To add a component, check first whether an existing one with a new variant
covers it; four near-duplicate callouts is how the pre-system CSS got where it
was. If it is genuinely new, build it from tokens only, add it to
`styleguide.html` in every variant and state, and give it an accessibility
note. The linter reports components defined but never rendered in the guide, so
an undocumented component shows up as a warning rather than quietly existing.

Never add a value to `components.css`. The linter fails on raw colours and raw
durations, and that failure is the feature.

## What the migration changed

The refactor was not visually neutral, and these are the deliberate deltas:

Input borders moved from `#2a3242` to `#5b6c8e`, which is the visible change.
At 1.34:1 the old border failed WCAG 1.4.11; the new one holds 3.27:1. The
danger button's background darkened from `#e5534b` to `#d8322a` because white
on the old red measured 4.12:1, below the 4.5:1 text minimum. Hint text
lightened from `#6f7d8f` to `#7d8a9a` for the same reason — it passed on the
app background and failed inside panels, where hints actually live.

Beyond the accessibility corrections, the type scale collapsed from ten sizes
to six, which shifts most text by half a point and makes each state roughly
2–5% taller. Spacing values snapped to the scale, moving a handful of paddings
by 1–2px. The modal gained a shadow, buttons and inputs gained hover and focus
transitions, and the Load button now shows a spinner while a request is in
flight.
