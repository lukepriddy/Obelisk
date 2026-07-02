import React, { useEffect, useRef, useState } from 'react';
import { Check, ChevronDown, Dices, Gift, LockKeyhole, Plus, Trash2 } from 'lucide-react';
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
  // Hide the "resource requirements" (cost-to-unlock) section — used for
  // discoverable zones, which only ever grant, never gate on a cost.
  showRequirements?: boolean;
}

const ResourceSelect: React.FC<{
  value: string;
  resources: ProgressionResource[];
  onChange: (value: string) => void;
}> = ({ value, resources, onChange }) => {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const selected = resources.find(resource => resource.id === value) || resources[0];

  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);

  return (
    <div ref={rootRef} className="relative flex-1 min-w-0">
      <button
        type="button"
        onClick={() => setOpen(current => !current)}
        className={`h-10 w-full flex items-center justify-between gap-2 bg-zinc-800 border rounded px-3 text-xs text-white ${
          open ? 'border-emerald-500 ring-1 ring-emerald-500/30' : 'border-zinc-700'
        }`}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span className="truncate">{selected?.name || 'Select resource'}</span>
        <ChevronDown size={14} className={`shrink-0 text-zinc-400 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && (
        <div
          role="listbox"
          className="absolute z-50 left-0 right-0 top-full mt-1 overflow-hidden rounded-lg border border-zinc-700 bg-zinc-900 shadow-2xl"
        >
          {resources.map(resource => {
            const active = resource.id === value;
            return (
              <button
                key={resource.id}
                type="button"
                role="option"
                aria-selected={active}
                onClick={() => {
                  onChange(resource.id);
                  setOpen(false);
                }}
                className={`w-full h-10 px-3 flex items-center justify-between gap-3 text-left text-xs ${
                  active ? 'bg-emerald-600 text-white' : 'text-zinc-200 hover:bg-zinc-800'
                }`}
              >
                <span className="truncate">{resource.name}</span>
                {active && <Check size={14} className="shrink-0" />}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
};

export const ZoneProgressionSettings: React.FC<ZoneProgressionSettingsProps> = ({
  zone,
  resources,
  onUpdate,
  showRequirements = true,
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
          {rewards.map((reward, index) => {
            const isVariable = typeof reward.amount_max === 'number' && reward.amount_max > reward.amount;
            return (
              <div key={`${reward.resource_id}-${index}`} className="flex items-center gap-2">
                <ResourceSelect
                  value={reward.resource_id}
                  resources={resources}
                  onChange={resource_id => updateReward(index, { resource_id })}
                />
                <input
                  type="number"
                  min="1"
                  step="1"
                  value={reward.amount}
                  onChange={e => updateReward(index, { amount: Math.max(1, Number(e.target.value) || 1) })}
                  className="h-10 w-16 bg-zinc-800 border border-zinc-700 rounded px-2 text-xs text-white text-center"
                  aria-label="Reward amount"
                />
                {isVariable && (
                  <>
                    <span className="text-xs text-zinc-500">–</span>
                    <input
                      type="number"
                      min={reward.amount}
                      step="1"
                      value={reward.amount_max}
                      onChange={e => updateReward(index, { amount_max: Math.max(reward.amount, Number(e.target.value) || reward.amount) })}
                      className="h-10 w-16 bg-zinc-800 border border-zinc-700 rounded px-2 text-xs text-white text-center"
                      aria-label="Maximum reward amount"
                    />
                  </>
                )}
                <button
                  type="button"
                  onClick={() => updateReward(index, { amount_max: isVariable ? undefined : reward.amount + 2 })}
                  className={`w-8 h-8 shrink-0 flex items-center justify-center rounded transition-colors ${
                    isVariable ? 'text-emerald-400 bg-emerald-500/10' : 'text-zinc-600 hover:text-zinc-300'
                  }`}
                  aria-label="Toggle variable amount"
                  aria-pressed={isVariable}
                  title="Variable amount — grants a random number in this range"
                >
                  <Dices size={14} />
                </button>
                <button
                  type="button"
                  onClick={() => onUpdate({ progression_rewards: rewards.filter((_, i) => i !== index) })}
                  className="w-8 h-8 flex items-center justify-center text-zinc-600 hover:text-red-400"
                  aria-label="Remove reward"
                >
                  <Trash2 size={13} />
                </button>
              </div>
            );
          })}
          <button
            type="button"
            onClick={addReward}
            className="flex items-center gap-1.5 text-xs text-zinc-500 hover:text-emerald-400"
          >
            <Plus size={13} /> Add reward
          </button>
        </div>
      </div>

      {showRequirements && (
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
                  <ResourceSelect
                    value={requirement.resource_id}
                    resources={resources}
                    onChange={resource_id => updateRequirement(index, { resource_id })}
                  />
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
      )}
    </div>
  );
};
