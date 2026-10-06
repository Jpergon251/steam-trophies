export const TROPHY_TIER_THRESHOLDS = {
  silver: 40,
  gold: 15,
};

export function getTrophyTier(unlockPercentage) {
  if (
    unlockPercentage === null ||
    unlockPercentage === undefined ||
    Number.isNaN(Number(unlockPercentage))
  )
    return null;
  const percentage = Number(unlockPercentage);
  if (percentage <= TROPHY_TIER_THRESHOLDS.gold) return "gold";
  if (percentage <= TROPHY_TIER_THRESHOLDS.silver) return "silver";
  return "bronze";
}
