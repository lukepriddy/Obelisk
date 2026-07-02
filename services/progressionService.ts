import {
  PlayerProgress,
  ProgressionRequirement,
  ProgressionResource,
  ProgressionReward,
  Zone,
} from '../types';

const PLAYER_ID_KEY = 'obelisk_player_id';
const PROGRESS_KEY_PREFIX = 'obelisk_progress_';

const clampAmount = (value: unknown) => {
  const amount = Math.floor(Number(value));
  return Number.isFinite(amount) ? Math.max(0, amount) : 0;
};

const getPlayerId = () => {
  try {
    const existing = localStorage.getItem(PLAYER_ID_KEY);
    if (existing) return existing;
    const id = crypto.randomUUID();
    localStorage.setItem(PLAYER_ID_KEY, id);
    return id;
  } catch {
    return crypto.randomUUID();
  }
};

const storageKey = (tourId: string) => `${PROGRESS_KEY_PREFIX}${tourId}`;

const createProgress = (tourId: string, resources: ProgressionResource[]): PlayerProgress => ({
  version: 1,
  player_id: getPlayerId(),
  tour_id: tourId,
  balances: Object.fromEntries(resources.map(resource => [
    resource.id,
    clampAmount(resource.starting_amount),
  ])),
  granted_zone_ids: [],
  unlocked_zone_ids: [],
  updated_at: new Date().toISOString(),
});

export const loadPlayerProgress = (
  tourId: string,
  resources: ProgressionResource[],
): PlayerProgress => {
  let progress = createProgress(tourId, resources);
  try {
    const raw = localStorage.getItem(storageKey(tourId));
    if (raw) {
      const saved = JSON.parse(raw) as Partial<PlayerProgress>;
      progress = {
        ...progress,
        ...saved,
        version: 1,
        player_id: saved.player_id || progress.player_id,
        tour_id: tourId,
        balances: { ...progress.balances, ...(saved.balances || {}) },
        granted_zone_ids: Array.isArray(saved.granted_zone_ids) ? saved.granted_zone_ids : [],
        unlocked_zone_ids: Array.isArray(saved.unlocked_zone_ids) ? saved.unlocked_zone_ids : [],
      };
    }
  } catch {
    // Invalid or unavailable local storage falls back to a fresh local state.
  }

  resources.forEach(resource => {
    if (!Number.isFinite(progress.balances[resource.id])) {
      progress.balances[resource.id] = clampAmount(resource.starting_amount);
    }
  });
  return progress;
};

export const savePlayerProgress = (progress: PlayerProgress) => {
  const next = { ...progress, updated_at: new Date().toISOString() };
  try {
    localStorage.setItem(storageKey(progress.tour_id), JSON.stringify(next));
  } catch {
    // The active session still works when storage is unavailable.
  }
  return next;
};

export const resetPlayerProgress = (
  tourId: string,
  resources: ProgressionResource[],
) => {
  try { localStorage.removeItem(storageKey(tourId)); } catch {}
  return savePlayerProgress(createProgress(tourId, resources));
};

const requirementsFor = (zone: Zone): ProgressionRequirement[] =>
  Array.isArray(zone.progression_requirements) ? zone.progression_requirements : [];

const rewardsFor = (zone: Zone): ProgressionReward[] =>
  Array.isArray(zone.progression_rewards) ? zone.progression_rewards : [];

// Rolled once at grant time so the same reward can vary between playthroughs
// (a fixed reward is just the min/max case where they're equal).
const resolveRewardAmount = (reward: ProgressionReward) => {
  const min = clampAmount(reward.amount);
  const max = clampAmount(reward.amount_max);
  return max > min ? min + Math.floor(Math.random() * (max - min + 1)) : min;
};

export const hasProgressionRequirements = (zone: Zone) =>
  requirementsFor(zone).some(rule => rule.resource_id && clampAmount(rule.amount) > 0);

const requiredTotals = (zone: Zone) =>
  requirementsFor(zone).reduce<Record<string, number>>((totals, rule) => {
    if (!rule.resource_id) return totals;
    totals[rule.resource_id] = (totals[rule.resource_id] || 0) + clampAmount(rule.amount);
    return totals;
  }, {});

export const canMeetProgressionRequirements = (zone: Zone, progress: PlayerProgress) => {
  if (progress.unlocked_zone_ids.includes(zone.id)) return true;
  return Object.entries(requiredTotals(zone)).every(
    ([resourceId, amount]) => (progress.balances[resourceId] || 0) >= amount,
  );
};

export const unlockProgressionZone = (
  zone: Zone,
  progress: PlayerProgress,
): PlayerProgress => {
  if (progress.unlocked_zone_ids.includes(zone.id)) return progress;
  if (!canMeetProgressionRequirements(zone, progress)) return progress;

  const balances = { ...progress.balances };
  requirementsFor(zone).forEach(rule => {
    if (!rule.consume || !rule.resource_id) return;
    balances[rule.resource_id] = Math.max(
      0,
      (balances[rule.resource_id] || 0) - clampAmount(rule.amount),
    );
  });

  return savePlayerProgress({
    ...progress,
    balances,
    unlocked_zone_ids: [...progress.unlocked_zone_ids, zone.id],
  });
};

export const grantZoneRewards = (
  zone: Zone,
  progress: PlayerProgress,
): { progress: PlayerProgress; granted: ProgressionReward[] } => {
  if (progress.granted_zone_ids.includes(zone.id)) {
    return { progress, granted: [] };
  }

  const rewards = rewardsFor(zone)
    .map(reward => ({ ...reward, amount: resolveRewardAmount(reward) }))
    .filter(reward => reward.resource_id && reward.amount > 0);

  if (rewards.length === 0) return { progress, granted: [] };

  const balances = { ...progress.balances };
  rewards.forEach(reward => {
    balances[reward.resource_id] = (balances[reward.resource_id] || 0) + reward.amount;
  });

  return {
    progress: savePlayerProgress({
      ...progress,
      balances,
      granted_zone_ids: [...progress.granted_zone_ids, zone.id],
    }),
    granted: rewards,
  };
};
