// Design tokens — aequitas-implementation-handoff.md Section 17.
// "No gradients, no glassmorphism, no confetti, no gamification."

export const colors = {
  ink: "#1B1E23",
  paper: "#FAF9F7",
  muted: "#6B7280",
  accent: "#2F4A6B", // deep slate blue — reserved for primary actions only
  // Semantic hues: the doc mandates icon + label pairing (never color alone,
  // WCAG 1.4.1) but doesn't specify exact values. Chosen for >=4.5:1 text
  // contrast against `paper`; verify with axe-core per Section 18.
  consentGiven: "#1E6B3C",
  consentDeclined: "#8A2A2A",
  warning: "#8A5A00",
} as const;

export const type = {
  headingFamily: "ui-serif, Georgia, 'Times New Roman', serif",
  bodyFamily: "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif",
  baseSizePx: 16,
  lineHeight: 1.5,
} as const;

// 4/8/16/24/32/48
export const space = {
  xs: "4px",
  sm: "8px",
  md: "16px",
  lg: "24px",
  xl: "32px",
  xxl: "48px",
} as const;

export const target = {
  minInteractivePx: 44,
} as const;

export const focusRing = {
  width: "2px",
  style: "solid",
  color: colors.accent,
  offset: "2px",
} as const;

export const motion = {
  maxDurationMs: 150,
  easing: "ease-out",
  // Consumers must also honor `prefers-reduced-motion: reduce` and disable
  // non-essential animation entirely, not just shorten it.
} as const;
