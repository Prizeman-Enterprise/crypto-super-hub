/**
 * Fixed risk colour bands (Ben Cowen style). Same mapping everywhere:
 * main risk number, slider dot, saved plan indicator, risk band rows.
 *
 * Risk 0–20   → Strong Green
 * Risk 25–40 → Light Green → Neutral
 * Risk 45–55 → Soft Neutral (near white)
 * Risk 60–75 → Light Red
 * Risk 80–100 → Strong Red
 * Intensity increases toward extremes. Risk 15 is never red.
 */

function clamp(v: number): number {
  return Math.min(100, Math.max(0, v));
}

function lerp(a: number, b: number, t: number): number {
  return Math.round(a + t * (b - a));
}

// Key points: strong green, light green, neutral, light red, strong red
const STRONG_GREEN = { r: 22, g: 163, b: 74 };
const LIGHT_GREEN = { r: 134, g: 239, b: 172 };
const NEUTRAL = { r: 248, g: 250, b: 252 };
const LIGHT_RED = { r: 252, g: 165, b: 165 };
const STRONG_RED = { r: 220, g: 53, b: 69 };

function getRiskRgb(risk: number): { r: number; g: number; b: number } {
  const v = clamp(risk);
  if (v <= 20) {
    const t = v / 20;
    return { r: lerp(STRONG_GREEN.r, LIGHT_GREEN.r, t), g: lerp(STRONG_GREEN.g, LIGHT_GREEN.g, t), b: lerp(STRONG_GREEN.b, LIGHT_GREEN.b, t) };
  }
  if (v <= 40) {
    const t = (v - 20) / 20;
    return { r: lerp(LIGHT_GREEN.r, NEUTRAL.r, t), g: lerp(LIGHT_GREEN.g, NEUTRAL.g, t), b: lerp(LIGHT_GREEN.b, NEUTRAL.b, t) };
  }
  if (v <= 55) {
    const t = (v - 40) / 15;
    return { r: lerp(NEUTRAL.r, NEUTRAL.r, t), g: lerp(NEUTRAL.g, NEUTRAL.g, t), b: lerp(NEUTRAL.b, NEUTRAL.b, t) };
  }
  if (v <= 75) {
    const t = (v - 55) / 20;
    return { r: lerp(NEUTRAL.r, LIGHT_RED.r, t), g: lerp(NEUTRAL.g, LIGHT_RED.g, t), b: lerp(NEUTRAL.b, LIGHT_RED.b, t) };
  }
  const t = (v - 75) / 25;
  return { r: lerp(LIGHT_RED.r, STRONG_RED.r, t), g: lerp(LIGHT_RED.g, STRONG_RED.g, t), b: lerp(LIGHT_RED.b, STRONG_RED.b, t) };
}

export function getRiskColor(risk: number): string {
  const { r, g, b } = getRiskRgb(risk);
  return `rgb(${r},${g},${b})`;
}

export function getRiskBg(risk: number, alpha: number = 0.48): string {
  const { r, g, b } = getRiskRgb(risk);
  return `rgba(${r},${g},${b},${alpha})`;
}

export function getRiskBgRgba(risk: number, alpha: number): string {
  return getRiskBg(risk, alpha);
}
