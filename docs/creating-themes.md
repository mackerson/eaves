# Creating Themes for Eaves

This guide explains how to create custom themes for Eaves. A theme controls
the app's **colors**, and optionally its **fonts** and **icon set**. Themes are
hot-reloaded and appear under Settings → Appearance.

> **Scope note:** the visible app background (gradient / image / local file) and
> UI transparency are configured in **Settings → Appearance → Background**, not
> in a theme file. `theme.json` carries `background` and `transparency` fields in
> its schema, but they are **not currently applied on theme select** — see
> [Backgrounds & transparency](#backgrounds--transparency) below.

## Quick Start

1. Create a folder in your themes directory (see [Theme Location](#theme-location)):
   ```
   ~/.config/eaves/themes/my-theme/
   ```

2. Create a `theme.json` file in that folder with your theme definition.

3. The theme will automatically appear in Settings → Appearance → Theme.

Changes to `theme.json` are hot-reloaded — no restart needed.

## Theme Location

| Platform | Path |
|----------|------|
| macOS | `~/Library/Application Support/eaves/themes/` |
| Linux | `~/.config/eaves/themes/` |
| Windows | `%APPDATA%\eaves\themes\` |

Each theme lives in its own folder with a `theme.json` file:
```
themes/
├── my-cool-theme/
│   └── theme.json
├── another-theme/
│   └── theme.json
```

## Theme Structure

### Minimal Theme

```json
{
  "id": "my-theme",
  "name": "My Theme",
  "category": "Custom",
  "isDark": true,
  "colors": {
    "bgPrimary": "#1a1a1a",
    "bgSecondary": "#242424",
    "bgTertiary": "#2d2d2d",
    "bgHover": "#333333",
    "bgActive": "#3a3a3a",
    "bgInput": "#2d2d2d",
    "bgModal": "#1e1e1e",
    "bgOverlay": "rgba(0, 0, 0, 0.8)",
    "textPrimary": "#ffffff",
    "textSecondary": "#b0b0b0",
    "textTertiary": "#808080",
    "textDisabled": "#555555",
    "textInverse": "#1a1a1a",
    "accentPrimary": "#667eea",
    "accentSecondary": "#764ba2",
    "accentHover": "#7c8ef0",
    "accentActive": "#5a6fd8",
    "borderPrimary": "#3a3a3a",
    "borderSecondary": "#2d2d2d"
  }
}
```

### Required Fields

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | Unique identifier. Any non-empty string; keep it lowercase with no spaces by convention. |
| `name` | string | Display name shown in theme selector |
| `colors` | object | All 19 color keys are required (see [Color Reference](#color-reference)) |

### Optional Fields

| Field | Type | Description |
|-------|------|-------------|
| `isDark` | boolean | `true` for dark themes, `false` for light. Defaults to `true` when omitted. |
| `category` | string | Category for grouping (default: `"Custom"`) |
| `iconSet` | string | Preferred icon style: `"emoji"` or `"pixelart"` (see [Icon Sets](#icon-sets)) |
| `fonts` | object | `sans` / `mono` font stacks (see [Fonts](#fonts)) |
| `background` | object | Schema-only — **not applied on theme select**. See [Backgrounds & transparency](#backgrounds--transparency). |
| `transparency` | object | Only `uiBlur` is effective; per-panel opacity keys are inert. See [Backgrounds & transparency](#backgrounds--transparency). |

## Color Reference

All colors in the `colors` object are required:

### Background Colors
| Key | Used For |
|-----|----------|
| `bgPrimary` | Main app background |
| `bgSecondary` | Sidebar, cards, secondary surfaces |
| `bgTertiary` | Nested elements, code blocks |
| `bgHover` | Hover states |
| `bgActive` | Active/pressed states |
| `bgInput` | Input field backgrounds |
| `bgModal` | Modal/dialog backgrounds |
| `bgOverlay` | Modal backdrop (use rgba for transparency) |

### Text Colors
| Key | Used For |
|-----|----------|
| `textPrimary` | Main text content |
| `textSecondary` | Secondary text, labels |
| `textTertiary` | Placeholder text, hints |
| `textDisabled` | Disabled elements |
| `textInverse` | Text on accent backgrounds |

### Accent Colors
| Key | Used For |
|-----|----------|
| `accentPrimary` | Primary buttons, links, highlights |
| `accentSecondary` | Secondary accents, gradients |
| `accentHover` | Hover state for accent elements |
| `accentActive` | Active/pressed accent elements |

### Border Colors
| Key | Used For |
|-----|----------|
| `borderPrimary` | Main borders |
| `borderSecondary` | Subtle borders |

### Status Colors (Optional)
| Key | Default | Used For |
|-----|---------|----------|
| `statusSuccess` | `#10b981` | Success messages |
| `statusWarning` | `#f59e0b` | Warnings |
| `statusError` | `#ef4444` | Errors |
| `statusInfo` | `#3b82f6` | Info messages |

## Icon Sets

A theme can specify a preferred icon style that matches its aesthetic:

```json
{
  "iconSet": "pixelart"
}
```

### Available Icon Sets

| Value | Description |
|-------|-------------|
| `emoji` | Standard emoji icons |
| `pixelart` | Retro pixel art icons using [Pixelarticons](https://pixelarticons.com) |

### How It Works

- The app's default chrome uses **Lucide** icons.
- If a theme specifies `iconSet`, that set is used instead.
- If no theme (bundled or user) supplies `iconSet`, the app falls back to
  **Lucide** — not emoji.

A theme may only declare `"emoji"` or `"pixelart"`; `lucide` is the app default,
not a theme-selectable value.

## Fonts

A theme can supply font stacks for body and monospace text:

```json
{
  "fonts": {
    "sans": "'Inter', system-ui, sans-serif",
    "mono": "'JetBrains Mono', ui-monospace, monospace"
  }
}
```

| Field | Type | Description |
|-------|------|-------------|
| `sans` | string | CSS font stack for body / UI text (`--font-sans`) |
| `mono` | string | CSS font stack for monospace / code (`--font-mono`) |

Both are optional and are sanitized before being emitted as CSS variables.

> **Settings override wins.** If the user sets a font preference in
> Settings → Appearance, that preference is applied as an inline style and
> **overrides** the theme's font stacks (this exists so accessibility/font-size
> choices always take effect). Treat theme `fonts` as a default, not a guarantee.

## Backgrounds & transparency

The visible app background and UI transparency are a **Settings feature**, not a
theme-authoring feature. Configure them in **Settings → Appearance → Background**:

| Capability | Where |
|------------|-------|
| Background source: none / gradient / URL / **local file** | Settings → Appearance → Background |
| Background opacity and blur | Settings sliders |
| Transparent UI chrome (panels show the background through) | Automatic when the settings background is not `none` |

When a settings background is active, panels switch to transparent surfaces and
`transparency.uiBlur` (from the active theme) drives a `backdrop-filter` frosted-glass
effect. The top menu bar always stays opaque for readability.

### Schema fields that are not (yet) applied

`theme.json` accepts the following fields, but the current app **does not apply
them on theme select**. They validate, but have no runtime effect — do not rely
on them:

- `background` (`type` / `value` / `defaultOpacity` / `defaultBlur` / `locked`) —
  a theme cannot set or lock the app background. Use Settings → Appearance.
- `transparency.sidebar` and `transparency.mainContent` — per-panel opacity is
  not consumed by any CSS. Only `transparency.uiBlur` is effective.

Note also that theme backgrounds could only ever express `gradient` or `url`
types; **local image files are a Settings-only option** via the file picker.

> Wiring theme-controlled backgrounds (the "skin" experience) is tracked as a
> post-beta backlog item. Until then, keep background/transparency out of shared
> themes to avoid promising behavior that doesn't apply.

## Complete Example

A theme using colors, an icon set, and custom fonts — all of which apply today:

```json
{
  "id": "aurora-dream",
  "name": "Aurora Dream",
  "category": "Custom",
  "isDark": true,
  "iconSet": "pixelart",
  "fonts": {
    "sans": "'Inter', system-ui, sans-serif",
    "mono": "'JetBrains Mono', ui-monospace, monospace"
  },
  "colors": {
    "bgPrimary": "#0f0f1a",
    "bgSecondary": "#171727",
    "bgTertiary": "#1f1f35",
    "bgHover": "#282843",
    "bgActive": "#313151",
    "bgInput": "#171727",
    "bgModal": "#0f0f1a",
    "bgOverlay": "rgba(15, 15, 26, 0.95)",
    "textPrimary": "#e0e0ff",
    "textSecondary": "#a0a0d0",
    "textTertiary": "#7070a0",
    "textDisabled": "#404060",
    "textInverse": "#0f0f1a",
    "accentPrimary": "#667eea",
    "accentSecondary": "#764ba2",
    "accentHover": "#818cf8",
    "accentActive": "#4f46e5",
    "borderPrimary": "#282843",
    "borderSecondary": "#1f1f35"
  }
}
```

## Tips for Theme Creation

### Color Harmony
- Use a color palette tool like [Coolors](https://coolors.co) or [Adobe Color](https://color.adobe.com)
- Ensure sufficient contrast between text and background colors
- Test your theme with actual content to verify readability

### Dark vs Light Themes
- Set `isDark: true` for dark themes, `isDark: false` for light themes
- This affects Tailwind CSS dark mode classes and system preferences

### Testing
- Changes hot-reload automatically — just save your `theme.json`
- Test with different types of content (chat, settings, etc.)

## Troubleshooting

### Theme not appearing
- Verify the folder structure: `themes/my-theme/theme.json`
- Check that `theme.json` is valid JSON
- Ensure all required color fields are present
- A theme that fails validation is **skipped silently** and simply won't appear
  in the selector. Validation failures are logged in the **main process**
  (not the renderer DevTools console) — check the app's main log if a theme
  won't load.

### Colors not applying
- Verify color values are valid CSS colors (hex, rgb, rgba)
- Confirm all 19 required color keys are present; a missing key can invalidate
  the theme

## Sharing Themes

To share your theme, zip the theme folder and share it. Users can extract it to
their themes directory:

```
themes/
└── your-theme/
    └── theme.json
```
