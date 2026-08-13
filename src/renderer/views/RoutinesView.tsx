import { useState, useEffect, useCallback, useMemo } from 'react';
import { useProjectStore, useUIStore, useSidebarPinsStore } from '@/stores';
import { Routine, Workflow, Activity } from '@/types';
import { useToastStore } from '@/stores/useToastStore';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  RefreshCw,
  ChevronDown,
  ChevronRight,
  Play,
  Pencil,
  Trash2,
  Loader2,
  Clock,
  Filter,
  AlertTriangle,
  PauseCircle,
  Pin,
  PinOff,
} from 'lucide-react';

// ─── Types ───────────────────────────────────────────────────────────────────

interface RoutineFormData {
  name: string;
  description: string;
  cronSchedule: string;
  enabled: boolean;
  workflowId?: string;
}

interface RoutineFormProps {
  routine: RoutineFormData | Routine;
  onChange: (updates: Partial<RoutineFormData>) => void;
  onSave: () => void;
  onCancel: () => void;
  isEditing?: boolean;
  workflows: Workflow[];
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function describeCron(cron: string): string {
  const parts = cron.split(' ');
  if (parts.length !== 5) return cron;

  const [minute, hour, dayOfMonth, month, dayOfWeek] = parts;

  if (minute === '0' && hour !== '*' && dayOfMonth === '*' && month === '*' && dayOfWeek === '*') {
    return `Daily at ${hour}:00`;
  }
  if (minute !== '*' && hour !== '*' && dayOfMonth === '*' && month === '*' && dayOfWeek === '*') {
    return `Daily at ${hour}:${minute.padStart(2, '0')}`;
  }
  if (hour.startsWith('*/')) {
    return `Every ${hour.slice(2)} hours`;
  }
  if (minute.startsWith('*/')) {
    return `Every ${minute.slice(2)} minutes`;
  }
  if (dayOfWeek === '1-5') {
    return `Weekdays at ${hour}:${minute.padStart(2, '0')}`;
  }
  if (dayOfWeek === '0,6' || dayOfWeek === '6,0') {
    return `Weekends at ${hour}:${minute.padStart(2, '0')}`;
  }
  return cron;
}

/**
 * Executor errors arrive with a full Node stack trace appended. The row wants
 * the one line that says what broke; the whole thing stays in the tooltip.
 */
function summarizeError(error: string): string {
  const firstLine = error.split('\n', 1)[0].trim();
  return firstLine.length > 160 ? `${firstLine.slice(0, 159)}…` : firstLine;
}

function formatTimestamp(timestamp?: number): string {
  if (!timestamp) return 'Never';
  return new Date(timestamp).toLocaleString();
}

function formatRelativeTime(timestamp: number): string {
  const diff = Date.now() - timestamp;
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(timestamp).toLocaleDateString();
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSec = seconds % 60;
  return `${minutes}m ${remainingSec}s`;
}

function formatDateGroup(timestamp: number): string {
  const date = new Date(timestamp);
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);

  if (date.toDateString() === today.toDateString()) return 'Today';
  if (date.toDateString() === yesterday.toDateString()) return 'Yesterday';
  return date.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });
}

// ─── Schedule Builder ────────────────────────────────────────────────────────

type ScheduleFrequency = 'minutes' | 'hourly' | 'daily' | 'weekly' | 'monthly' | 'custom';

const DAYS_OF_WEEK = [
  { value: 0, label: 'Sun', short: 'S' },
  { value: 1, label: 'Mon', short: 'M' },
  { value: 2, label: 'Tue', short: 'T' },
  { value: 3, label: 'Wed', short: 'W' },
  { value: 4, label: 'Thu', short: 'T' },
  { value: 5, label: 'Fri', short: 'F' },
  { value: 6, label: 'Sat', short: 'S' },
];

const MINUTE_INTERVALS = ['5', '10', '15', '30', '45'];
const HOUR_INTERVALS = ['1', '2', '3', '4', '6', '8', '12'];
const HOURS = Array.from({ length: 24 }, (_, i) => i);
const MINUTES = Array.from({ length: 12 }, (_, i) => i * 5);
const MONTH_DAYS = Array.from({ length: 31 }, (_, i) => i + 1);

/** Try to parse a cron string into our visual schedule state */
function parseCronToSchedule(cron: string): {
  frequency: ScheduleFrequency;
  minuteInterval: string;
  hourInterval: string;
  hour: number;
  minute: number;
  days: number[];
  monthDay: number;
} {
  const defaults = {
    frequency: 'daily' as ScheduleFrequency,
    minuteInterval: '30',
    hourInterval: '6',
    hour: 9,
    minute: 0,
    days: [1, 2, 3, 4, 5],
    monthDay: 1,
  };

  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return { ...defaults, frequency: 'custom' };

  const [minPart, hourPart, dayPart, monthPart, dowPart] = parts;

  // Every N minutes: */N * * * *
  if (minPart.startsWith('*/') && hourPart === '*' && dayPart === '*' && monthPart === '*' && dowPart === '*') {
    return { ...defaults, frequency: 'minutes', minuteInterval: minPart.slice(2) };
  }

  // Every N hours: 0 */N * * *
  if (hourPart.startsWith('*/') && dayPart === '*' && monthPart === '*' && dowPart === '*') {
    return { ...defaults, frequency: 'hourly', hourInterval: hourPart.slice(2), minute: Number(minPart) || 0 };
  }

  // Monthly: M H D * *
  if (dayPart !== '*' && monthPart === '*' && dowPart === '*' && !dayPart.includes('/') && !dayPart.includes('-')) {
    return { ...defaults, frequency: 'monthly', hour: Number(hourPart) || 0, minute: Number(minPart) || 0, monthDay: Number(dayPart) || 1 };
  }

  // Weekly: M H * * D,D,D
  if (dayPart === '*' && monthPart === '*' && dowPart !== '*') {
    const parsedDays = dowPart.split(',').flatMap((seg) => {
      if (seg.includes('-')) {
        const [start, end] = seg.split('-').map(Number);
        const result: number[] = [];
        for (let i = start; i <= end; i++) result.push(i);
        return result;
      }
      return [Number(seg)];
    });
    return { ...defaults, frequency: 'weekly', hour: Number(hourPart) || 0, minute: Number(minPart) || 0, days: parsedDays };
  }

  // Daily: M H * * *
  if (dayPart === '*' && monthPart === '*' && dowPart === '*' && !hourPart.includes('/') && !minPart.includes('/')) {
    return { ...defaults, frequency: 'daily', hour: Number(hourPart) || 0, minute: Number(minPart) || 0 };
  }

  return { ...defaults, frequency: 'custom' };
}

/** Build a cron string from visual schedule state */
function buildCronFromSchedule(
  frequency: ScheduleFrequency,
  state: { minuteInterval: string; hourInterval: string; hour: number; minute: number; days: number[]; monthDay: number },
): string {
  switch (frequency) {
    case 'minutes':
      return `*/${state.minuteInterval} * * * *`;
    case 'hourly':
      return `${state.minute} */${state.hourInterval} * * *`;
    case 'daily':
      return `${state.minute} ${state.hour} * * *`;
    case 'weekly': {
      const dayStr = state.days.length > 0 ? state.days.sort((a, b) => a - b).join(',') : '1';
      return `${state.minute} ${state.hour} * * ${dayStr}`;
    }
    case 'monthly':
      return `${state.minute} ${state.hour} ${state.monthDay} * *`;
    default:
      return '0 9 * * *';
  }
}

function ScheduleBuilder({ value, onChange }: { value: string; onChange: (cron: string) => void }) {
  const parsed = useMemo(() => parseCronToSchedule(value), [value]);
  const [frequency, setFrequency] = useState<ScheduleFrequency>(parsed.frequency);
  const [minuteInterval, setMinuteInterval] = useState(parsed.minuteInterval);
  const [hourInterval, setHourInterval] = useState(parsed.hourInterval);
  const [hour, setHour] = useState(parsed.hour);
  const [minute, setMinute] = useState(parsed.minute);
  const [days, setDays] = useState<number[]>(parsed.days);
  const [monthDay, setMonthDay] = useState(parsed.monthDay);
  const [showAdvanced, setShowAdvanced] = useState(parsed.frequency === 'custom');

  // Sync cron output when visual state changes (but not in custom mode)
  useEffect(() => {
    if (frequency === 'custom') return;
    const cron = buildCronFromSchedule(frequency, { minuteInterval, hourInterval, hour, minute, days, monthDay });
    if (cron !== value) onChange(cron);
  }, [frequency, minuteInterval, hourInterval, hour, minute, days, monthDay]);

  const toggleDay = useCallback((day: number) => {
    setDays((prev) => {
      const next = prev.includes(day) ? prev.filter((d) => d !== day) : [...prev, day];
      return next.length > 0 ? next : prev; // Prevent empty selection
    });
  }, []);

  const formatHour = (h: number) => {
    if (h === 0) return '12 AM';
    if (h < 12) return `${h} AM`;
    if (h === 12) return '12 PM';
    return `${h - 12} PM`;
  };

  return (
    <div className="space-y-3">
      <label className="block text-sm font-medium mb-1">Schedule</label>

      {/* Frequency selector */}
      <div className="flex flex-wrap gap-1.5">
        {([
          ['minutes', 'Minutes'],
          ['hourly', 'Hourly'],
          ['daily', 'Daily'],
          ['weekly', 'Weekly'],
          ['monthly', 'Monthly'],
        ] as [ScheduleFrequency, string][]).map(([freq, label]) => (
          <button
            key={freq}
            type="button"
            onClick={() => { setFrequency(freq); setShowAdvanced(false); }}
            className={`px-3 py-1.5 text-sm rounded-md border transition-colors ${
              frequency === freq && !showAdvanced
                ? 'bg-accent-primary text-white border-accent-primary'
                : 'bg-bg-tertiary border-border-secondary text-text-secondary hover:border-accent-primary hover:text-text-primary'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {/* Frequency-specific options */}
      {!showAdvanced && frequency === 'minutes' && (
        <div className="flex items-center gap-2 text-sm">
          <span className="text-text-secondary">Every</span>
          <Select value={minuteInterval} onValueChange={setMinuteInterval}>
            <SelectTrigger className="w-20">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {MINUTE_INTERVALS.map((m) => (
                <SelectItem key={m} value={m}>{m}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <span className="text-text-secondary">minutes</span>
        </div>
      )}

      {!showAdvanced && frequency === 'hourly' && (
        <div className="flex items-center gap-2 text-sm flex-wrap">
          <span className="text-text-secondary">Every</span>
          <Select value={hourInterval} onValueChange={setHourInterval}>
            <SelectTrigger className="w-20">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {HOUR_INTERVALS.map((h) => (
                <SelectItem key={h} value={h}>{h}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <span className="text-text-secondary">{Number(hourInterval) === 1 ? 'hour' : 'hours'}, at minute</span>
          <Select value={String(minute)} onValueChange={(v) => setMinute(Number(v))}>
            <SelectTrigger className="w-20">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {MINUTES.map((m) => (
                <SelectItem key={m} value={String(m)}>{String(m).padStart(2, '0')}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}

      {!showAdvanced && frequency === 'daily' && (
        <div className="flex items-center gap-2 text-sm">
          <span className="text-text-secondary">Every day at</span>
          <Select value={String(hour)} onValueChange={(v) => setHour(Number(v))}>
            <SelectTrigger className="w-28">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {HOURS.map((h) => (
                <SelectItem key={h} value={String(h)}>{formatHour(h)}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <span className="text-text-tertiary">:</span>
          <Select value={String(minute)} onValueChange={(v) => setMinute(Number(v))}>
            <SelectTrigger className="w-20">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {MINUTES.map((m) => (
                <SelectItem key={m} value={String(m)}>{String(m).padStart(2, '0')}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}

      {!showAdvanced && frequency === 'weekly' && (
        <div className="space-y-3">
          <div className="flex gap-1">
            {DAYS_OF_WEEK.map((d) => (
              <button
                key={d.value}
                type="button"
                onClick={() => toggleDay(d.value)}
                className={`w-10 h-10 rounded-md text-sm font-medium transition-colors ${
                  days.includes(d.value)
                    ? 'bg-accent-primary text-white'
                    : 'bg-bg-tertiary text-text-secondary hover:bg-bg-hover border border-border-secondary'
                }`}
                title={d.label}
              >
                {d.short}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-2 text-sm">
            <span className="text-text-secondary">at</span>
            <Select value={String(hour)} onValueChange={(v) => setHour(Number(v))}>
              <SelectTrigger className="w-28">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {HOURS.map((h) => (
                  <SelectItem key={h} value={String(h)}>{formatHour(h)}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <span className="text-text-tertiary">:</span>
            <Select value={String(minute)} onValueChange={(v) => setMinute(Number(v))}>
              <SelectTrigger className="w-20">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {MINUTES.map((m) => (
                  <SelectItem key={m} value={String(m)}>{String(m).padStart(2, '0')}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex gap-2 text-xs">
            <button
              type="button"
              onClick={() => setDays([1, 2, 3, 4, 5])}
              className="text-accent-primary hover:underline"
            >
              Weekdays
            </button>
            <button
              type="button"
              onClick={() => setDays([0, 6])}
              className="text-accent-primary hover:underline"
            >
              Weekends
            </button>
            <button
              type="button"
              onClick={() => setDays([0, 1, 2, 3, 4, 5, 6])}
              className="text-accent-primary hover:underline"
            >
              Every day
            </button>
          </div>
        </div>
      )}

      {!showAdvanced && frequency === 'monthly' && (
        <div className="flex items-center gap-2 text-sm flex-wrap">
          <span className="text-text-secondary">On day</span>
          <Select value={String(monthDay)} onValueChange={(v) => setMonthDay(Number(v))}>
            <SelectTrigger className="w-20">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {MONTH_DAYS.map((d) => (
                <SelectItem key={d} value={String(d)}>{d}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <span className="text-text-secondary">at</span>
          <Select value={String(hour)} onValueChange={(v) => setHour(Number(v))}>
            <SelectTrigger className="w-28">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {HOURS.map((h) => (
                <SelectItem key={h} value={String(h)}>{formatHour(h)}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <span className="text-text-tertiary">:</span>
          <Select value={String(minute)} onValueChange={(v) => setMinute(Number(v))}>
            <SelectTrigger className="w-20">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {MINUTES.map((m) => (
                <SelectItem key={m} value={String(m)}>{String(m).padStart(2, '0')}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}

      {/* Human-readable summary + advanced toggle */}
      <div className="flex items-center justify-between text-xs pt-1">
        <span className="text-text-tertiary font-mono bg-bg-tertiary px-2 py-1 rounded">
          {value}
        </span>
        <button
          type="button"
          onClick={() => {
            if (!showAdvanced) {
              setFrequency('custom');
            } else {
              const reparsed = parseCronToSchedule(value);
              setFrequency(reparsed.frequency === 'custom' ? 'daily' : reparsed.frequency);
              setMinuteInterval(reparsed.minuteInterval);
              setHourInterval(reparsed.hourInterval);
              setHour(reparsed.hour);
              setMinute(reparsed.minute);
              setDays(reparsed.days);
              setMonthDay(reparsed.monthDay);
            }
            setShowAdvanced(!showAdvanced);
          }}
          className="text-accent-primary hover:underline"
        >
          {showAdvanced ? 'Use visual editor' : 'Edit cron expression'}
        </button>
      </div>

      {/* Advanced cron input */}
      {showAdvanced && (
        <div>
          <Input
            value={value}
            onChange={(e) => onChange(e.target.value)}
            className="font-mono"
            placeholder="0 9 * * *"
          />
          <div className="mt-2 text-xs text-text-tertiary space-y-1">
            <p className="font-medium">Format: minute hour day month weekday</p>
            <div className="grid grid-cols-2 gap-x-4 gap-y-1">
              <span><code className="bg-bg-tertiary px-1 rounded">0 9 * * *</code> - Daily at 9 AM</span>
              <span><code className="bg-bg-tertiary px-1 rounded">0 */6 * * *</code> - Every 6 hours</span>
              <span><code className="bg-bg-tertiary px-1 rounded">0 9 * * 1-5</code> - Weekdays at 9 AM</span>
              <span><code className="bg-bg-tertiary px-1 rounded">*/30 * * * *</code> - Every 30 min</span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── RoutineForm ─────────────────────────────────────────────────────────────

function RoutineForm({ routine, onChange, onSave, onCancel, isEditing = false, workflows }: RoutineFormProps) {
  return (
    <div className="mb-6 p-6 bg-bg-secondary border border-border-primary rounded-lg">
      <h3 className="text-xl font-semibold mb-4">
        {isEditing ? 'Edit Routine' : 'Create New Routine'}
      </h3>
      <div className="space-y-4">
        <div>
          <label className="block text-sm font-medium mb-2">Name</label>
          <Input
            value={routine.name}
            onChange={(e) => onChange({ name: e.target.value })}
            placeholder="Daily backup routine"
          />
        </div>
        <div>
          <label className="block text-sm font-medium mb-2">Description (optional)</label>
          <Textarea
            value={routine.description || ''}
            onChange={(e) => onChange({ description: e.target.value })}
            placeholder="Backs up important data every day"
            rows={2}
          />
        </div>
        <ScheduleBuilder
          value={routine.cronSchedule}
          onChange={(cron) => onChange({ cronSchedule: cron })}
        />
        <div>
          <label className="block text-sm font-medium mb-2">Workflow (optional)</label>
          <Select
            value={routine.workflowId || '__none__'}
            onValueChange={(val) => onChange({ workflowId: val === '__none__' ? undefined : val })}
          >
            <SelectTrigger>
              <SelectValue placeholder="No workflow" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__none__">No workflow</SelectItem>
              {workflows.map((wf) => (
                <SelectItem key={wf.id} value={wf.id}>
                  {wf.name}
                  {wf.description && (
                    <span className="text-text-tertiary ml-2 text-xs">
                      — {wf.description}
                    </span>
                  )}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="mt-1 text-xs text-text-tertiary">
            Link a workflow to execute on schedule
          </p>
        </div>
        <div className="flex items-center gap-2">
          <input
            type="checkbox"
            id={isEditing ? 'enabled-edit' : 'enabled'}
            checked={routine.enabled}
            onChange={(e) => onChange({ enabled: e.target.checked })}
            className="w-4 h-4 cursor-pointer"
          />
          <label htmlFor={isEditing ? 'enabled-edit' : 'enabled'} className="text-sm cursor-pointer">
            {isEditing ? 'Enabled' : 'Enable immediately'}
          </label>
        </div>
        <div className="flex gap-2">
          <Button onClick={onSave}>
            {isEditing ? 'Save Changes' : 'Create Routine'}
          </Button>
          <Button variant="outline" onClick={onCancel}>
            Cancel
          </Button>
        </div>
      </div>
    </div>
  );
}

// ─── Execution History ───────────────────────────────────────────────────────

const ROUTINE_EXECUTION_TYPES = [
  'routine:execution:started',
  'routine:execution:completed',
  'routine:execution:failed',
];

interface ExecutionData {
  routineId?: string;
  routineName?: string;
  workflowId?: string;
  duration?: number;
  success?: boolean;
  error?: string;
  startTime?: number;
}

function ExecutionHistory({
  routines,
  workflows,
  projectId,
}: {
  routines: Routine[];
  workflows: Workflow[];
  projectId: string;
}) {
  const [executions, setExecutions] = useState<Activity[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [filterRoutineId, setFilterRoutineId] = useState('__all__');
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());

  const loadExecutions = useCallback(async () => {
    setIsLoading(true);
    try {
      const result = await window.electron.getActivities({
        types: ROUTINE_EXECUTION_TYPES,
        projectId,
        limit: 200,
      });
      if (result.success && result.activities) {
        setExecutions(result.activities);
      }
    } catch (error) {
      console.error('Failed to load execution history:', error);
    } finally {
      setIsLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    loadExecutions();
  }, [loadExecutions]);

  // Real-time updates
  useEffect(() => {
    const unsubscribe = window.electron.onActivityNew((activity: Activity) => {
      if (ROUTINE_EXECUTION_TYPES.includes(activity.type)) {
        setExecutions((prev) => [activity, ...prev].slice(0, 200));
      }
    });
    return unsubscribe;
  }, []);

  const toggleExpanded = useCallback((id: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const filtered = useMemo(() => {
    if (filterRoutineId === '__all__') return executions;
    return executions.filter((a) => {
      const data = a.data as ExecutionData | undefined;
      return data?.routineId === filterRoutineId;
    });
  }, [executions, filterRoutineId]);

  // Group by date
  const grouped = useMemo(() => {
    const groups: { label: string; items: Activity[] }[] = [];
    let currentLabel = '';
    for (const activity of filtered) {
      const label = formatDateGroup(activity.timestamp);
      if (label !== currentLabel) {
        currentLabel = label;
        groups.push({ label, items: [] });
      }
      groups[groups.length - 1].items.push(activity);
    }
    return groups;
  }, [filtered]);

  const workflowMap = useMemo(
    () => new Map(workflows.map((w) => [w.id, w.name])),
    [workflows],
  );

  function renderStatus(activity: Activity) {
    const data = activity.data as ExecutionData | undefined;
    if (activity.type === 'routine:execution:completed') {
      return data?.success ? (
        <Badge className="bg-green-500/20 text-green-400 border-green-500/30">Success</Badge>
      ) : (
        <Badge className="bg-yellow-500/20 text-yellow-400 border-yellow-500/30">Completed</Badge>
      );
    }
    if (activity.type === 'routine:execution:failed') {
      return <Badge className="bg-red-500/20 text-red-400 border-red-500/30">Failed</Badge>;
    }
    return <Badge className="bg-blue-500/20 text-blue-400 border-blue-500/30">Running</Badge>;
  }

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12 text-text-tertiary">
        <Loader2 className="w-5 h-5 animate-spin mr-2" />
        Loading execution history...
      </div>
    );
  }

  return (
    <div className="space-y-4 mt-4">
      {/* Filter bar */}
      <div className="flex items-center gap-3">
        <Filter className="w-4 h-4 text-text-tertiary" />
        <Select value={filterRoutineId} onValueChange={setFilterRoutineId}>
          <SelectTrigger className="w-64">
            <SelectValue placeholder="All routines" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__all__">All routines</SelectItem>
            {routines.map((r) => (
              <SelectItem key={r.id} value={r.id}>{r.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          variant="ghost"
          size="icon"
          onClick={loadExecutions}
          title="Refresh"
        >
          <RefreshCw className="w-4 h-4" />
        </Button>
        <span className="text-sm text-text-tertiary ml-auto">
          {filtered.length} {filtered.length === 1 ? 'event' : 'events'}
        </span>
      </div>

      {/* Execution list */}
      {filtered.length === 0 ? (
        <div className="text-center py-12 text-text-tertiary">
          <Clock className="w-12 h-12 mx-auto mb-3 opacity-40" />
          <p className="text-lg">No execution history yet</p>
          <p className="text-sm mt-1">Run a routine to see results here</p>
        </div>
      ) : (
        <div className="space-y-6">
          {grouped.map((group) => (
            <div key={group.label}>
              <h3 className="text-xs font-semibold text-text-tertiary uppercase tracking-wider mb-3">
                {group.label}
              </h3>
              <div className="space-y-2">
                {group.items.map((activity) => {
                  const data = activity.data as ExecutionData | undefined;
                  const isExpanded = expandedIds.has(activity.id);
                  const hasFailed = activity.type === 'routine:execution:failed';
                  const hasError = hasFailed && data?.error;

                  return (
                    <div
                      key={activity.id}
                      className="p-4 bg-bg-secondary border border-border-primary rounded-lg hover:border-border-secondary transition-colors"
                    >
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-3">
                          {hasError ? (
                            <button
                              onClick={() => toggleExpanded(activity.id)}
                              className="flex items-center gap-1 text-text-tertiary hover:text-text-primary"
                            >
                              {isExpanded ? (
                                <ChevronDown className="w-4 h-4" />
                              ) : (
                                <ChevronRight className="w-4 h-4" />
                              )}
                            </button>
                          ) : (
                            <span className="w-5" />
                          )}
                          {renderStatus(activity)}
                          <span className="font-medium">
                            {data?.routineName || 'Unknown routine'}
                          </span>
                          {data?.workflowId && workflowMap.has(data.workflowId) && (
                            <span className="text-sm text-text-tertiary">
                              via {workflowMap.get(data.workflowId)}
                            </span>
                          )}
                        </div>
                        <div className="flex items-center gap-4 text-sm text-text-tertiary">
                          {data?.duration != null && (
                            <span className="font-mono">{formatDuration(data.duration)}</span>
                          )}
                          <span>{formatRelativeTime(activity.timestamp)}</span>
                        </div>
                      </div>
                      {isExpanded && hasError && (
                        <div className="mt-3 ml-8 p-3 bg-red-500/10 border border-red-500/20 rounded text-sm text-red-400 font-mono whitespace-pre-wrap">
                          {data?.error}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── RoutinesView ────────────────────────────────────────────────────────────

export function RoutinesView() {
  const { currentProjectId } = useProjectStore();
  const { pendingCreate, clearPendingCreate, setView } = useUIStore();
  const showToast = useToastStore((s) => s.showToast);
  const [routines, setRoutines] = useState<Routine[]>([]);
  const [workflows, setWorkflows] = useState<Workflow[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isCreating, setIsCreating] = useState(false);
  const [editingRoutine, setEditingRoutine] = useState<Routine | null>(null);
  const [activeTab, setActiveTab] = useState('routines');
  const [schedulerPaused, setSchedulerPaused] = useState(false);
  const [pauseBusy, setPauseBusy] = useState(false);
  const [newRoutine, setNewRoutine] = useState<RoutineFormData>({
    name: '',
    description: '',
    cronSchedule: '0 9 * * *',
    enabled: true,
    workflowId: undefined,
  });

  // Pause state lives in settings, so read it from the scheduler rather than
  // assuming a fresh mount means running.
  useEffect(() => {
    let cancelled = false;
    window.electron
      .getSchedulerStatus()
      .then((status) => {
        if (!cancelled) setSchedulerPaused(status?.paused === true);
      })
      .catch(() => { /* leave as not-paused; the toggle re-reads on use */ });
    return () => { cancelled = true; };
  }, []);

  // Handle creation mode signal from sidebar
  useEffect(() => {
    if (pendingCreate) {
      setActiveTab('routines');
      setIsCreating(true);
      clearPendingCreate();
    }
  }, [pendingCreate, clearPendingCreate]);

  const fetchRoutines = useCallback(async () => {
    if (!currentProjectId) return;

    setIsLoading(true);
    try {
      const [routineResult, workflowResult] = await Promise.all([
        window.electron.getRoutines(currentProjectId),
        window.electron.getWorkflows(currentProjectId),
      ]);
      setRoutines(routineResult || []);
      setWorkflows(workflowResult || []);
    } catch (error) {
      console.error('Failed to fetch routines:', error);
      showToast('Failed to load routines', 'error');
    } finally {
      setIsLoading(false);
    }
  }, [currentProjectId, showToast]);

  useEffect(() => {
    fetchRoutines();
  }, [fetchRoutines]);

  const handleCreateRoutine = async () => {
    if (!currentProjectId || !newRoutine.name.trim()) {
      showToast('Please enter a routine name', 'error');
      return;
    }

    try {
      const result = await window.electron.createRoutine({
        projectId: currentProjectId,
        name: newRoutine.name.trim(),
        description: newRoutine.description.trim() || undefined,
        cronSchedule: newRoutine.cronSchedule,
        enabled: newRoutine.enabled,
        workflowId: newRoutine.workflowId,
      });

      if (result.success && result.routine) {
        setRoutines((prev) => [...prev, result.routine!]);
        showToast('Routine created successfully', 'success');
        setIsCreating(false);
        setNewRoutine({
          name: '',
          description: '',
          cronSchedule: '0 9 * * *',
          enabled: true,
          workflowId: undefined,
        });
      } else {
        showToast(result.error || 'Failed to create routine', 'error');
      }
    } catch (error) {
      console.error('Failed to create routine:', error);
      showToast('Failed to create routine', 'error');
    }
  };

  const handleToggleEnabled = async (routineId: string) => {
    const routine = routines.find((r) => r.id === routineId);
    if (!routine) return;

    try {
      const result = await window.electron.updateRoutine(routineId, {
        enabled: !routine.enabled,
      });

      if (result.success && result.routine) {
        setRoutines((prev) => prev.map((r) => (r.id === routineId ? result.routine! : r)));
        showToast(result.routine.enabled ? 'Routine enabled' : 'Routine disabled', 'success');
      } else {
        showToast(result.error || 'Failed to update routine', 'error');
      }
    } catch (error) {
      console.error('Failed to toggle routine:', error);
      showToast('Failed to update routine', 'error');
    }
  };

  const handleDeleteRoutine = async (routineId: string) => {
    const routine = routines.find((r) => r.id === routineId);
    if (!routine) return;

    if (!confirm(`Are you sure you want to delete "${routine.name}"?`)) {
      return;
    }

    try {
      const result = await window.electron.deleteRoutine(routineId);

      if (result.success) {
        setRoutines((prev) => prev.filter((r) => r.id !== routineId));
        showToast('Routine deleted', 'success');
      } else {
        showToast(result.error || 'Failed to delete routine', 'error');
      }
    } catch (error) {
      console.error('Failed to delete routine:', error);
      showToast('Failed to delete routine', 'error');
    }
  };

  const handleTogglePaused = async () => {
    setPauseBusy(true);
    try {
      const next = !schedulerPaused;
      const result = await window.electron.setRoutinesPaused(next);
      if (!result?.success) {
        showToast(result?.error || 'Could not change pause state', 'error');
        return;
      }
      setSchedulerPaused(next);
      if (next) {
        showToast('All routines paused', 'success');
      } else {
        // Say what resuming actually did — silently moving schedules would look
        // like the routines had been skipped.
        showToast(
          result.rescheduled
            ? `Routines resumed — ${result.rescheduled} moved to their next slot`
            : 'Routines resumed',
          'success'
        );
      }
    } catch (err: unknown) {
      showToast(err instanceof Error ? err.message : 'Could not change pause state', 'error');
    } finally {
      setPauseBusy(false);
    }
  };

  const handleTogglePinned = async (routine: Routine) => {
    try {
      const result = await window.electron.updateRoutine(routine.id, { pinned: !routine.pinned });
      if (result?.success && result.routine) {
        setRoutines((prev) => prev.map((r) => (r.id === routine.id ? result.routine! : r)));
        useSidebarPinsStore.getState().notifyRoutinePinsChanged();
      } else {
        showToast(result?.error || 'Could not update pin', 'error');
      }
    } catch (err: unknown) {
      showToast(err instanceof Error ? err.message : 'Could not update pin', 'error');
    }
  };

  const handleExecuteRoutine = async (routineId: string) => {
    const routine = routines.find((r) => r.id === routineId);
    if (!routine) return;

    try {
      showToast(`Executing "${routine.name}"...`);
      const result = await window.electron.executeRoutine(routineId);

      if (result.success) {
        showToast(`"${routine.name}" executed successfully`, 'success');
        fetchRoutines();
      } else {
        showToast(result.error || 'Failed to execute routine', 'error');
      }
    } catch (error) {
      console.error('Failed to execute routine:', error);
      showToast('Failed to execute routine', 'error');
    }
  };

  const handleUpdateRoutine = async () => {
    if (!editingRoutine) return;

    try {
      const result = await window.electron.updateRoutine(editingRoutine.id, {
        name: editingRoutine.name,
        description: editingRoutine.description,
        cronSchedule: editingRoutine.cronSchedule,
        enabled: editingRoutine.enabled,
        workflowId: editingRoutine.workflowId,
      });

      if (result.success && result.routine) {
        setRoutines((prev) => prev.map((r) => (r.id === editingRoutine.id ? result.routine! : r)));
        showToast('Routine updated', 'success');
        setEditingRoutine(null);
      } else {
        showToast(result.error || 'Failed to update routine', 'error');
      }
    } catch (error) {
      console.error('Failed to update routine:', error);
      showToast('Failed to update routine', 'error');
    }
  };

  const workflowMap = useMemo(
    () => new Map(workflows.map((w) => [w.id, w.name])),
    [workflows],
  );

  if (!currentProjectId) {
    return (
      <div className="p-8 text-center">
        <div className="text-6xl mb-4">⏰</div>
        <h2 className="text-2xl font-bold mb-2">No Project Selected</h2>
        <p className="text-text-secondary">Select or create a project to manage routines</p>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="p-8 text-center">
        <Loader2 className="w-8 h-8 animate-spin mx-auto mb-4 text-text-tertiary" />
        <p className="text-text-secondary">Loading routines...</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="p-8 pb-0">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h1 className="text-3xl font-bold">Routines</h1>
            <p className="text-text-secondary mt-1">Scheduled tasks and workflows</p>
          </div>
          {activeTab === 'routines' && !isCreating && !editingRoutine && (
            <div className="flex items-center gap-2">
              <Button
                variant={schedulerPaused ? 'default' : 'outline'}
                onClick={handleTogglePaused}
                disabled={pauseBusy}
                title={
                  schedulerPaused
                    ? 'Resume the scheduler. Anything that came due while paused moves to its next slot rather than firing at once.'
                    : 'Stop all scheduled runs. Manual Run still works.'
                }
              >
                {schedulerPaused ? (
                  <><Play className="h-4 w-4 mr-1.5" aria-hidden />Resume all</>
                ) : (
                  <><PauseCircle className="h-4 w-4 mr-1.5" aria-hidden />Pause all</>
                )}
              </Button>
              <Button onClick={() => setIsCreating(true)}>
                + New Routine
              </Button>
            </div>
          )}
        </div>

        {schedulerPaused && activeTab === 'routines' && (
          <div
            className="mb-4 flex items-center gap-2 rounded-md border px-3 py-2 text-sm"
            style={{ borderColor: '#f59e0b55', background: '#f59e0b14', color: '#f59e0b' }}
          >
            <PauseCircle className="h-4 w-4 shrink-0" aria-hidden />
            <span>
              All routines are paused. Nothing runs on a schedule until you resume — manual
              <strong> Run</strong> still works.
            </span>
          </div>
        )}
      </div>

      <Tabs value={activeTab} onValueChange={setActiveTab} className="flex-1 flex flex-col min-h-0">
        <div className="px-8">
          <TabsList>
            <TabsTrigger value="routines">Routines</TabsTrigger>
            <TabsTrigger value="history">Execution History</TabsTrigger>
          </TabsList>
        </div>

        <TabsContent value="routines" className="flex-1 overflow-y-auto px-8 py-6 mt-0">
          {/* Creation Form */}
          {isCreating && (
            <RoutineForm
              routine={newRoutine}
              onChange={(updates) => setNewRoutine((prev) => ({ ...prev, ...updates }))}
              onSave={handleCreateRoutine}
              onCancel={() => setIsCreating(false)}
              workflows={workflows}
            />
          )}

          {/* Edit Form */}
          {editingRoutine && (
            <RoutineForm
              routine={editingRoutine}
              onChange={(updates) =>
                setEditingRoutine((prev) => (prev ? { ...prev, ...updates } : null))
              }
              onSave={handleUpdateRoutine}
              onCancel={() => setEditingRoutine(null)}
              isEditing
              workflows={workflows}
            />
          )}

          {/* Routines List */}
          {routines.length === 0 && !isCreating ? (
            <div className="text-center py-12 text-text-tertiary">
              <Clock className="w-12 h-12 mx-auto mb-3 opacity-40" />
              <p className="text-lg">No routines yet</p>
              <p className="text-sm mt-2">Create your first routine to automate recurring tasks</p>
            </div>
          ) : (
            <div className="space-y-3">
              {routines.map((routine) => {
                const isBeingEdited = editingRoutine?.id === routine.id;
                const linkedWorkflow = routine.workflowId
                  ? workflowMap.get(routine.workflowId)
                  : null;

                return (
                  <div
                    key={routine.id}
                    className={`p-5 bg-bg-secondary border rounded-lg transition-colors ${
                      isBeingEdited
                        ? 'border-accent-primary opacity-50'
                        : 'border-border-primary hover:border-border-secondary'
                    }`}
                  >
                    <div className="flex items-start justify-between">
                      <div className="flex-1 min-w-0">
                        {/* Title row with badges */}
                        <div className="flex items-center gap-2 mb-2 flex-wrap">
                          <h3 className="text-lg font-semibold">{routine.name}</h3>
                          <Badge
                            className={`cursor-pointer transition-colors ${
                              routine.enabled
                                ? 'bg-green-500/20 text-green-400 border-green-500/30 hover:bg-green-500/30'
                                : 'bg-gray-500/20 text-gray-400 border-gray-500/30 hover:bg-gray-500/30'
                            }`}
                            onClick={() => !isBeingEdited && handleToggleEnabled(routine.id)}
                          >
                            {routine.enabled ? 'Enabled' : 'Disabled'}
                          </Badge>
                          {linkedWorkflow && (
                            <Badge
                              variant="outline"
                              className="cursor-pointer hover:text-accent-primary hover:border-accent-primary transition-colors"
                              onClick={() => setView('workflows')}
                            >
                              {linkedWorkflow}
                            </Badge>
                          )}
                          {/* A routine that keeps failing should say so on the
                              row itself — reconstructing it from the activity
                              feed is how a 534-run flatline goes unnoticed. */}
                          {routine.consecutiveFailures > 0 && (
                            <Badge className="bg-red-500/20 text-red-400 border-red-500/30">
                              <AlertTriangle className="h-3 w-3 mr-1" aria-hidden />
                              {routine.consecutiveFailures === 1
                                ? 'Last run failed'
                                : `Failing — ${routine.consecutiveFailures} runs`}
                            </Badge>
                          )}
                        </div>

                        {routine.consecutiveFailures > 0 && routine.lastError && (
                          <p
                            className="text-xs mb-2 truncate"
                            style={{ color: '#f87171' }}
                            title={routine.lastError}
                          >
                            {summarizeError(routine.lastError)}
                          </p>
                        )}

                        {routine.description && (
                          <p className="text-text-secondary text-sm mb-3">{routine.description}</p>
                        )}

                        {/* Details grid */}
                        <div className="flex flex-wrap gap-x-6 gap-y-1 text-sm">
                          <div>
                            <span className="text-text-tertiary">Schedule: </span>
                            <span className="font-mono bg-bg-tertiary px-1.5 py-0.5 rounded text-xs">
                              {routine.cronSchedule}
                            </span>
                            <span className="text-text-tertiary ml-1.5">
                              ({describeCron(routine.cronSchedule)})
                            </span>
                          </div>
                          <div>
                            <span className="text-text-tertiary">Last: </span>
                            <span>{formatTimestamp(routine.lastRun)}</span>
                          </div>
                          <div>
                            <span className="text-text-tertiary">Next: </span>
                            <span className="text-accent-primary font-medium">
                              {routine.nextRun ? formatTimestamp(routine.nextRun) : 'Not scheduled'}
                            </span>
                          </div>
                        </div>
                      </div>

                      {/* Action buttons */}
                      <div className="flex gap-1 flex-shrink-0 ml-4">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => handleTogglePinned(routine)}
                          disabled={isBeingEdited}
                          title={routine.pinned ? 'Unpin from sidebar' : 'Pin to sidebar'}
                        >
                          {routine.pinned
                            ? <PinOff className="h-4 w-4" aria-hidden />
                            : <Pin className="h-4 w-4" aria-hidden />}
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => handleExecuteRoutine(routine.id)}
                          disabled={isBeingEdited}
                          title="Run now"
                        >
                          <Play className="w-4 h-4 mr-1" />
                          Run
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => setEditingRoutine(routine)}
                          disabled={isBeingEdited || isCreating}
                          title="Edit"
                        >
                          <Pencil className="w-4 h-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => handleDeleteRoutine(routine.id)}
                          disabled={isBeingEdited}
                          className="hover:text-red-500"
                          title="Delete"
                        >
                          <Trash2 className="w-4 h-4" />
                        </Button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </TabsContent>

        <TabsContent value="history" className="flex-1 overflow-y-auto px-8 pb-8 mt-0">
          <ExecutionHistory
            routines={routines}
            workflows={workflows}
            projectId={currentProjectId}
          />
        </TabsContent>
      </Tabs>
    </div>
  );
}
