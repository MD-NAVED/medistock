// Client-side mirror of the server's feature-tier ladder (server/index.js).
// Used ONLY to show/hide buttons and show upgrade prompts — the server's
// requireFeature() is the real enforcement.

export const TIER_RANK = { starter: 0, pro: 1, elite: 2 };

export const FEATURE_MIN_TIER = {
  khata: 'pro',
  whatsapp_bill: 'pro',
  import: 'pro',
  reports: 'pro',
  staff_unlimited: 'elite',
  scanner: 'elite',
  whatsapp_summary: 'elite',
};

export const FEATURE_LABELS = {
  khata: 'Khata (Udhaar Book)',
  whatsapp_bill: 'WhatsApp bill sending',
  import: 'Excel/CSV data import',
  reports: 'Full sales & purchase reports',
  staff_unlimited: 'Unlimited staff accounts',
  scanner: 'Camera invoice scanner',
  whatsapp_summary: 'WhatsApp daily business summary',
};

export function tierAllows(tier, feature) {
  const need = FEATURE_MIN_TIER[feature];
  if (!need) return true;
  return (TIER_RANK[tier] ?? 0) >= TIER_RANK[need];
}

export const userTier = (user) => user?.tier || 'starter';
