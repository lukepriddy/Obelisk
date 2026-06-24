import React from 'react';
import { Gift, LockKeyhole, Plus, Trash2 } from 'lucide-react';
import {
  ProgressionRequirement,
  ProgressionResource,
  ProgressionReward,
  Zone,
} from '../types';

interface ZoneProgressionSettingsProps {
  zone: Zone;
  resources: ProgressionResource[];
  onUpdate: (updates: Partial<Zone>) => void;
}

export const ZoneProgressionSettings: React.FC<ZoneProgressionSettingsProps> = ({
  zone,
  resources,
  onUpdate,
}) => {
  const rewards = zone.progression_rewards || [];
  const requirements = zone.progression_requirements || [];

  const addReward = () => {
    if (!resources[0]) return;
    onUpdate({
      progression_rewards: [
        ...rewards,
        { resource_id: resources[0].id, amount: 1 },
      ],
    });
  };

  const updateReward = (index: number, updates: Partial<ProgressionReward>) => {
    onUpdate({
      progression_rewards: rewards.map((reward, i) =>
        i === index ? { ...reward, ...updates } : reward
      ),
    });
  };

  const addRequirement = () => {
    if (!resources[0]) return;
    onUpdate({
      progression_requirements: [
        ...requirements,
        { resource_id: resources[0].id, amount: 1, consume: false },
      ],
    });
  };

  const updateRequirement = (index: number, updates: Partial<ProgressionRequirement>) => {
    onUpdate({
      progression_requirements: requirements.map((requirement, i) =>
        i === index ? { ...requirement, ...updates } : requirement
      ),
    });
  };

  return (
    <div className="border-t border-zinc-800 pt-5 mt-2 space-y-5">
      <h3 className="text-emerald-400 font-bold uppercase tracking-wider text-sm">
        Progression
      </h3>

      <div>
        <label className="block text-xs font-bold text-zinc-400 uppercase mb-2 flex items-center gap-2">
          <Gift size={14} /> Rewards on first visit
        </label>
        <div className="space-y-2">
          {rewards.map((reward, index) => (
            <div key={`${reward.resource_id}-${index}`} className="flex items-center gap-2">
              <select
                value={reward.resource_id}
                onChange={e => updateReward(index, { resource_id: e.target.value })}
                className="h-10 flex-1 min-w-0 bg-zinc-800 border border-zinc-700 rounded px-2 text-xs text-white"
              >
                {resources.map(resource => (
                  <option key={resource.id} value={resource.id}>{resource.name}</option>
                ))}
              </select>
              <input
                type="number"
                min="1"
                step="1"
                value={reward.amount}
                onChange={e => updateReward(index, { amount: Math.max(1, Number(e.target.value) || 1) })}
                className="h-10 w-16 bg-zinc-800 border border-zinc-700 rounded px-2 text-xs text-white text-center"
                aria-label="Reward amount"
              />
              <button
                type="button"
                onClick={() => onUpdate({ progression_rewards: rewards.filter((_, i) => i !== index) })}
                className="w-8 h-8 flex items-center justify-center text-zinc-600 hover:text-red-400"
                aria-label="Remove reward"
              >
                <Trash2 size={13} />
              </button>
            </div>
          ))}
          <button
            type="button"
            onClick={addReward}
            className="flex items-center gap-1.5 text-xs text-zinc-500 hover:text-emerald-400"
          >
            <Plus size={13} /> Add reward
          </button>
        </div>
      </div>

      <div>
        <label className="block text-xs font-bold text-zinc-400 uppercase mb-2 flex items-center gap-2">
          <LockKeyhole size={14} /> Resource requirements
        </label>
        <div className="space-y-2">
          {requirements.map((requirement, index) => {
            const resource = resources.find(item => item.id === requirement.resource_id);
            return (
              <div key={`${requirement.resource_id}-${index}`} className="border border-zinc-800 rounded-lg p-2 space-y-2">
                <div className="flex items-center gap-2">
                  <select
                    value={requirement.resource_id}
                    onChange={e => updateRequirement(index, { resource_id: e.target.value })}
                    className="h-10 flex-1 min-w-0 bg-zinc-800 border border-zinc-700 rounded px-2 text-xs text-white"
                  >
                    {resources.map(item => (
                      <option key={item.id} value={item.id}>{item.name}</option>
                    ))}
                  </select>
                  <input
                    type="number"
                    min="1"
                    step="1"
                    value={requirement.amount}
                    onChange={e => updateRequirement(index, { amount: Math.max(1, Number(e.target.value) || 1) })}
                    className="h-10 w-16 bg-zinc-800 border border-zinc-700 rounded px-2 text-xs text-white text-center"
                    aria-label="Required amount"
                  />
                  <button
                    type="button"
                    onClick={() => onUpdate({ progression_requirements: requirements.filter((_, i) => i !== index) })}
                    className="w-8 h-8 flex items-center justify-center text-zinc-600 hover:text-red-400"
                    aria-label="Remove requirement"
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
                <label className="flex items-center gap-2 text-[10px] text-zinc-500 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={requirement.consume}
                    onChange={e => updateRequirement(index, { consume: e.target.checked })}
                    className="accent-emerald-500"
                  />
                  Consume {resource?.type === 'item' ? 'item' : 'amount'} when this zone first unlocks
                </label>
              </div>
            );
          })}
          <button
            type="button"
            onClick={addRequirement}
            className="flex items-center gap-1.5 text-xs text-zinc-500 hover:text-emerald-400"
          >
            <Plus size={13} /> Add requirement
          </button>
        </div>
      </div>
    </div>
  );
};
