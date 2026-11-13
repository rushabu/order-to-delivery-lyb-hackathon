# Design tokens: "Kilometre stone"

The product lives on Indian highways, so the look is the road's own. Source of truth: `src/index.css` (CSS variables, light and dark). Motion values in seconds: `src/lib/motion.ts`. Theme switching: `src/lib/theme.ts`. Components use the tokens through Tailwind classes (`bg-accent`, `text-ink`, `text-accent-ink` and so on).

## Colour

| Token | Light | Dark | Use |
|---|---|---|---|
| `--canvas` (concrete) | `#e9ecee` | `#12161e` | Page background |
| `--surface` / `--raised` | `#fbfcfc` / `#ffffff` | `#1a202b` / `#202836` | Panels, inputs |
| `--ink` (asphalt) | `#1b2230` | `#edf0f4` | Text |
| `--muted` | `#555f6e` | `#9aa5b5` | Secondary text |
| `--accent` (marker yellow) | `#ffc531` | `#ffc531` | Primary buttons, selection, the truck in focus. Always a fill under asphalt text, never text on a light surface |
| `--accent-ink` (sign blue) | `#1446a0` | `#8fb4ff` | Links, chart bars, the active route on the map |
| `--rail` | `#1b2230` | `#0e1219` | Coordinator side rail, landing story section |
| `--low` (go) | `#1f6b57` | `#7fd3b7` | "On schedule" |
| `--medium` (caution) | `#9c4500` | `#ffb37a` | "At risk" |
| `--high` (stop) | `#b3261e` | `#ff9b92` | "Delayed" |

Risk is always an icon plus a word, so colour never carries meaning alone. Caution orange is darker and redder than marker yellow.

## Contrast (WCAG ratio, computed)

| Pair | Ratio |
|---|---|
| Ink on canvas (light / dark) | 13.4 / 15.8 |
| Muted on surface (light / dark) | 6.3 / 6.6 |
| Asphalt on marker yellow | 10.1 |
| Sign blue on surface (light / dark) | 8.5 / 7.9 |
| Go, caution, stop on their soft fills (light) | 5.3, 5.3, 5.1 |
| Go, caution, stop on their soft fills (dark) | 7.6, 8.1, 7.1 |
| Rail text, rail muted on rail | 11.4, 6.2 |

Focus ring: 2 px asphalt outline with a 5 px marker-yellow halo, visible on concrete, white and yellow.

## Type

One family, Archivo (variable weight and width), self-hosted through `@fontsource-variable/archivo`.

| Role | Setting |
|---|---|
| Body | Archivo, normal width, 15 px / 24 px |
| Headings | Width 112%, weight 600-750 |
| Signage numbers (clock, KPIs, ETA) | `.wide` (width 125%), weight 800, tabular figures (`.tnum`) |
| Landing headline | `text-hero` (clamp 2.6-5.4 rem), width 125% on screens 640 px and up, 100% on phones |

## Shape, space, motion

- Radius: badges 4 px, controls 8 px, panels 14 px. Road graphics are pill-shaped.
- Interface motion stays within 150-300 ms with an ease-out curve.
- The landing page has one orchestrated moment: the hero road drives in on load, then scrolling replays the worked example from DESIGN.md 6.6.
- Lane markings flow (`.lane-flow`) and reported incidents pulse (`.pulse-ring`). Both stop under `prefers-reduced-motion`, and `MotionConfig reducedMotion="user"` turns off transforms app-wide.

## Navigation

- `Ctrl K` (`⌘K` on a Mac) opens the command palette on every signed-in screen: pages for the role, every visible shipment with its risk and ETA, theme and sign-out.
- The public landing page is `/`; signed-in users go straight to their home.
