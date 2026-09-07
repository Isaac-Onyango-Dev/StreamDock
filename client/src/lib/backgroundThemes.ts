/**
 * Catalogue of ambient background themes.
 *
 * The visuals themselves live in `styles/backgrounds.css`, keyed by the same
 * ids used here; this file only carries what the UI needs to list them. The
 * `swatchClass` is applied to both the Settings preview and nothing else — the
 * live background is driven by the `data-bg-theme` attribute against the same
 * CSS rule, so a preview cannot drift from what it previews.
 */
export interface BackgroundTheme {
  id: string;
  label: string;
  /** Short description shown as a tooltip. */
  hint: string;
  swatchClass: string;
}

/**
 * "Site Gradient" is deliberately not in this list: it is its own
 * `backgroundMode` ('gradient') rather than a `theme` variant, because it is
 * the app's default background and worth keeping addressable on its own. The
 * Settings UI renders it at the head of the same grid so the distinction stays
 * an implementation detail rather than something the user has to understand.
 */
export const SITE_GRADIENT_THEME: BackgroundTheme = {
  id: 'site-gradient',
  label: 'Site Gradient',
  hint: "The StreamDock website's own violet, pink and amber gradient",
  swatchClass: 'bg-theme-site-gradient',
};

export const BACKGROUND_THEMES: BackgroundTheme[] = [
  {
    id: 'glassmorphism',
    label: 'Glassmorphism',
    hint: 'Frosted pastel light, soft and translucent',
    swatchClass: 'bg-theme-glassmorphism',
  },
  {
    id: 'cyborg',
    label: 'Cyborg',
    hint: 'Brushed steel and cyan scanlines',
    swatchClass: 'bg-theme-cyborg',
  },
  {
    id: 'hazard',
    label: 'Hazard',
    hint: 'Amber warning stripes on dark',
    swatchClass: 'bg-theme-hazard',
  },
  {
    id: 'technology',
    label: 'Technology',
    hint: 'Blueprint circuit grid in deep blue',
    swatchClass: 'bg-theme-technology',
  },
  {
    id: 'aurora',
    label: 'Aurora',
    hint: 'Green and teal northern lights',
    swatchClass: 'bg-theme-aurora',
  },
  {
    id: 'synthwave',
    label: 'Synthwave',
    hint: 'Magenta horizon over a neon grid',
    swatchClass: 'bg-theme-synthwave',
  },
  {
    id: 'nebula',
    label: 'Nebula',
    hint: 'Deep-space purples and a scatter of stars',
    swatchClass: 'bg-theme-nebula',
  },
  {
    id: 'carbon',
    label: 'Carbon',
    hint: 'Woven carbon fibre, monochrome',
    swatchClass: 'bg-theme-carbon',
  },
  {
    id: 'matrix',
    label: 'Matrix',
    hint: 'Green digital rain columns',
    swatchClass: 'bg-theme-matrix',
  },
  {
    id: 'sunset',
    label: 'Sunset',
    hint: 'Warm dusk over a violet sky',
    swatchClass: 'bg-theme-sunset',
  },
  {
    id: 'midnight',
    label: 'Midnight',
    hint: 'Quiet navy and teal, minimal',
    swatchClass: 'bg-theme-midnight',
  },
];

/** Every selectable theme, with the default gradient first. */
export const ALL_BACKGROUND_THEMES: BackgroundTheme[] = [SITE_GRADIENT_THEME, ...BACKGROUND_THEMES];
