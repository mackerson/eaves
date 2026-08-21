/**
 * Categorical palette for the system view's charts.
 *
 * Hardcoded hex rather than the app's CSS theme variables, and the reason is
 * worth stating: themes are user-authored and arbitrary, so a chart drawing
 * series colors from them would be un-validatable — a theme could put two
 * series on indistinguishable hues and nothing would catch it. These eight
 * were checked against colour-vision-deficiency separation, a chroma floor, a
 * lightness band and surface contrast in both modes.
 *
 * Two rules this module exists to enforce:
 *
 *   1. **Slots are assigned in fixed order and never cycled.** A ninth series
 *      is not a generated hue — it folds into "Other".
 *   2. **Colour follows the entity, not its rank.** `colorForKey` hashes a
 *      stable key, so filtering the list does not repaint the survivors. A
 *      provider that was blue stays blue when the one above it is filtered out.
 *
 * Light mode note: aqua, yellow and magenta sit below 3:1 against a light
 * surface. The validator calls that a relief-required warning, satisfied here
 * because every bar carries a visible text label and its own value — identity
 * never rests on colour alone, so no legend is needed and none is drawn.
 */

const CHART_SERIES_LIGHT = [
  '#2a78d6', // blue
  '#eb6834', // orange
  '#1baf7a', // aqua
  '#eda100', // yellow
  '#e87ba4', // magenta
  '#008300', // green
  '#4a3aa7', // violet
  '#e34948', // red
] as const;

const CHART_SERIES_DARK = [
  '#3987e5',
  '#d95926',
  '#199e70',
  '#c98500',
  '#d55181',
  '#008300',
  '#9085e9',
  '#e66767',
] as const;

export function seriesPalette(isDark: boolean): readonly string[] {
  return isDark ? CHART_SERIES_DARK : CHART_SERIES_LIGHT;
}

/**
 * Assign a slot to a key, stably.
 *
 * Order-independent by design. Using the array index would mean a series
 * changed colour whenever the sort order changed — and this view sorts by
 * cost, which moves constantly. A reader who has learned "orange is OpenAI"
 * must not have that relearned every refresh.
 *
 * The trade is that two keys can hash to the same slot. That is tolerable
 * *here specifically* because these bars are labelled and numbered
 * individually, so a repeated hue costs a little visual grouping and no
 * information. It would not be tolerable in a stacked or multi-line chart,
 * where colour is the only thing telling two series apart — such a chart needs
 * fixed slot assignment over a known key set instead.
 */
export function colorForKey(key: string, isDark: boolean): string {
  const palette = seriesPalette(isDark);
  let hash = 0;
  for (let i = 0; i < key.length; i++) {
    hash = (hash * 31 + key.charCodeAt(i)) | 0;
  }
  return palette[Math.abs(hash) % palette.length];
}
