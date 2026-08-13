import { useState, useEffect, useRef, useMemo } from 'react';
import { RotateCcw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { useToastStore, useAgentStore } from '@/stores';
import { Agent, InstructTemplate, ContextFormatting, AgentArchetype, MCPServer, ChannelBehavior } from '@/types';
import { TOOL_CATALOG, CATEGORY_LABELS, getToolsByCategory, type ToolInventoryEntry } from '../../shared/toolCatalog';
import {
  SELECTABLE_ARCHETYPES,
  getArchetype,
  type ArchetypeFieldSpec,
} from '../../shared/archetypes';
import { Badge } from '@/components/ui/badge';
import { ModelCombobox } from '@/components/ModelCombobox';
import { MEMORY_EXTRACTOR_PROMPT } from '../../shared/shadowDefaults';
import { DEFAULT_PROMPT_TEMPLATE, PROMPT_TEMPLATE_VARIABLES } from '../../shared/promptTemplate';

interface AgentEditorViewProps {
  agentId?: string;
  agents: Agent[];
  onClose: () => void;
  onSave: () => Promise<void>;
}

export function AgentEditorView({ agentId, agents, onClose, onSave }: AgentEditorViewProps) {
  const showToast = useToastStore((state) => state.showToast);
  const { createAgent, updateAgent } = useAgentStore();

  const [loading, setLoading] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [activeSection, setActiveSection] = useState('identity');
  const [toolSearch, setToolSearch] = useState('');
  const [newMcp, setNewMcp] = useState({
    name: '', transport: 'stdio' as MCPServer['transport'], command: '', args: '', url: '',
  });
  const [toolInventory, setToolInventory] = useState<ToolInventoryEntry[]>([]);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const sectionRefs = useRef<Record<string, HTMLElement | null>>({});

  // Form state
  interface AgentFormState {
    // Basic Info
    name: string;
    description: string;
    color: string;
    avatar: string | undefined;
    provider: 'anthropic' | 'openai' | 'google' | 'openrouter' | 'ollama' | 'lmstudio';
    model: string;
    temperature: number;
    topP: number | undefined;
    maxOutputTokens: number | undefined;
    maxSteps: number | undefined;
    contextWindow: number | undefined;
    debugLogging: boolean;
    // System Prompt
    systemPrompt: string;
    promptTemplate: string;
    greeting: string;
    // Instruct Template
    useInstructTemplate: boolean;
    instructTemplate: InstructTemplate;
    // Stopping Strings
    stoppingStringsJson: string;
    // Context Variables
    contextVariables: Record<string, string>;
    newVarKey: string;
    newVarValue: string;
    // Context Formatting
    contextFormatting: ContextFormatting;
    // Archetype
    useArchetype: boolean;
    archetype: AgentArchetype;
    // Channel behavior
    channelBehavior: ChannelBehavior;
    // Custom Pricing
    promptCostPer1M: number | undefined;
    completionCostPer1M: number | undefined;
    // Default Tools
    defaultTools: string[];
    // Tool schema registration: 'auto' = default by provider
    toolSendMode: 'auto' | 'all' | 'enabled';
    compactionMode: 'auto' | 'manual' | 'off';
    // MCP Servers — read-only here; managed via the AgentCard "Configure MCP"
    // modal (add/update/delete-mcp-server IPC).
    mcpServers: MCPServer[];
  }

  const defaultFormState: AgentFormState = {
    name: '',
    description: '',
    color: '#3b82f6',
    avatar: undefined,
    provider: 'ollama',
    model: '',
    temperature: 0.7,
    topP: undefined,
    maxOutputTokens: undefined,
    maxSteps: undefined,
    contextWindow: undefined,
    debugLogging: false,
    systemPrompt: '',
    promptTemplate: '',
    greeting: '',
    useInstructTemplate: false,
    instructTemplate: { name: 'Custom', includeNames: 'auto' },
    stoppingStringsJson: '[]',
    contextVariables: {},
    newVarKey: '',
    newVarValue: '',
    contextFormatting: {
      alwaysAddCharacterName: false,
      trimSpaces: true,
      namesAsStopStrings: true,
    },
    useArchetype: false,
    archetype: {
      type: 'task-oriented',
      allowScheduling: false,
      allowSelfModification: false,
      allowGoalSetting: false,
      enableReflection: false,
      autonomyLevel: 'low',
    },
    channelBehavior: { respondTo: 'mentions-only', verbosity: 'brief' },
    promptCostPer1M: undefined,
    completionCostPer1M: undefined,
    defaultTools: [],
    toolSendMode: 'auto',
    compactionMode: 'auto',
    mcpServers: [],
  };

  // Synchronously seed the form from the agent we're editing (if available)
  // so the fetchModels effect below doesn't fire for the stale 'ollama'
  // default before loadAgentData has a chance to run.
  const initialAgent = agentId ? agents.find(a => a.id === agentId) : undefined;
  function agentToFormState(agent: Agent, base: AgentFormState): AgentFormState {
    return {
      ...base,
      name: agent.name,
      description: agent.description,
      color: agent.color,
      avatar: agent.avatar,
      provider: agent.provider,
      model: agent.model,
      temperature: agent.temperature,
      topP: agent.topP,
      maxOutputTokens: agent.maxOutputTokens,
      maxSteps: agent.maxSteps,
      contextWindow: agent.contextWindow,
      debugLogging: agent.debugLogging || false,
      systemPrompt: agent.systemPrompt || agent.description,
      promptTemplate: agent.promptTemplate || '',
      greeting: agent.greeting || '',
      useInstructTemplate: !!agent.instructTemplate,
      instructTemplate: agent.instructTemplate || base.instructTemplate,
      stoppingStringsJson: agent.stoppingStrings
        ? JSON.stringify(agent.stoppingStrings, null, 2)
        : base.stoppingStringsJson,
      contextVariables: agent.contextVariables || base.contextVariables,
      contextFormatting: agent.contextFormatting || base.contextFormatting,
      useArchetype: !!agent.archetype,
      archetype: agent.archetype || base.archetype,
      channelBehavior: agent.channelBehavior || base.channelBehavior,
      mcpServers: agent.mcpServers || base.mcpServers,
      defaultTools: agent.defaultTools || base.defaultTools,
      toolSendMode: agent.toolSendMode || 'auto',
      compactionMode: agent.compactionMode ?? 'auto',
      promptCostPer1M: agent.promptCostPer1M,
      completionCostPer1M: agent.completionCostPer1M,
    };
  }

  const [form, setForm] = useState<AgentFormState>(() =>
    initialAgent ? agentToFormState(initialAgent, defaultFormState) : defaultFormState
  );
  // True once we know what we're editing — i.e. either it's a new agent or we
  // resolved the existing agent. The fetchModels effect uses this to skip the
  // mount-time fire when the form is still showing defaults waiting on agents.
  const loadedRef = useRef(!agentId || !!initialAgent);
  const [availableModels, setAvailableModels] = useState<string[]>([]);
  const [loadingModels, setLoadingModels] = useState(false);
  const [modelError, setModelError] = useState<string | null>(null);

  // Capability gating: hide knobs the (provider, model) pair won't accept.
  // Optimistic default keeps everything visible while we resolve.
  type ModelCapabilities = Awaited<ReturnType<typeof window.electron.getModelCapabilities>>;
  const [capabilities, setCapabilities] = useState<ModelCapabilities>({
    temperature: true, topP: true, stopSequences: true,
    rawPrompt: false, maxOutputTokens: true, toolUse: true,
  });

  useEffect(() => {
    if (!form.provider || !form.model) return;
    let cancelled = false;
    window.electron.getModelCapabilities({ provider: form.provider, modelId: form.model })
      .then((caps) => { if (!cancelled) setCapabilities(caps); })
      .catch(() => { /* keep optimistic defaults on failure */ });
    return () => { cancelled = true; };
  }, [form.provider, form.model]);

  // Live-detected context window (LM Studio / Ollama). Null for cloud models
  // or when the local server is unreachable. Used to fill the "Auto-detect"
  // placeholder and explain what the running server actually loaded.
  type DetectedContext = Awaited<ReturnType<typeof window.electron.detectModelContext>>;
  const [detectedContext, setDetectedContext] = useState<DetectedContext>(null);

  useEffect(() => {
    if (!form.provider || !form.model) { setDetectedContext(null); return; }
    let cancelled = false;
    setDetectedContext(null);
    window.electron.detectModelContext({ provider: form.provider, modelId: form.model })
      .then((info) => { if (!cancelled) setDetectedContext(info); })
      .catch(() => { /* leave null — UI falls back to plain "Auto-detect" */ });
    return () => { cancelled = true; };
  }, [form.provider, form.model]);

  // Tool inventory (built-in + loaded plugins, with per-turn token estimates).
  // Static for the session; fetch once. MCP-server tools aren't included.
  useEffect(() => {
    let cancelled = false;
    window.electron.getToolInventory()
      .then((inv) => { if (!cancelled) setToolInventory(inv); })
      .catch(() => { /* leave empty — token chip + plugin group just won't show */ });
    return () => { cancelled = true; };
  }, []);

  const setField = <K extends keyof AgentFormState>(key: K, value: AgentFormState[K]) => {
    setForm(prev => ({ ...prev, [key]: value }));
    setDirty(true);
  };

  // Fetch models for every provider — every adapter in
  // src/main/services/providers.ts implements fetchModels now (anthropic,
  // openai, google, openrouter, ollama, lmstudio). The main-side handler
  // returns a typed error when the credential is missing, which we surface
  // as modelError; we don't gate at the renderer.
  useEffect(() => {
    // Skip the mount-time fire when we're editing an existing agent that
    // hasn't been resolved yet — otherwise we'd probe the stale 'ollama'
    // default before loadAgentData flips the provider, spamming the main
    // process with bogus connection errors.
    if (!loadedRef.current) return;
    let cancelled = false;
    setModelError(null);

    const fetchModels = async () => {
      setLoadingModels(true);
      try {
        const result = await window.electron.fetchModels(form.provider);
        if (cancelled) return;
        if (result.success && result.models) {
          setAvailableModels(result.models);
          if (result.models.length > 0 && (!form.model || !result.models.includes(form.model))) {
            setField('model', result.models[0]);
          }
        } else {
          setModelError(result.error || 'Failed to fetch models');
          setAvailableModels([]);
        }
      } catch (error: any) {
        if (cancelled) return;
        setModelError(error.message || 'Failed to fetch models');
        setAvailableModels([]);
      } finally {
        // Always clear the spinner — even on cancellation. Holding it past a
        // cancelled fetch leaves the agent editor stuck on "Loading models..."
        // when the user switches provider mid-flight (e.g. mount default
        // 'ollama' → loadAgentData flips to 'anthropic' before ollama responds).
        setLoadingModels(false);
      }
    };

    fetchModels();
    return () => { cancelled = true; };
  }, [form.provider]);

  // Fallback for the rare case where `agents` arrives after mount (lazy init
  // couldn't find the agent). Flipping loadedRef *before* setForm ensures the
  // fetchModels effect — which re-runs when form.provider changes — sees the
  // settled state and only fires once for the real provider.
  useEffect(() => {
    if (agentId && !loadedRef.current) {
      const agent = agents.find(a => a.id === agentId);
      if (agent) {
        loadedRef.current = true;
        setForm(prev => agentToFormState(agent, prev));
      }
    }
  }, [agentId, agents]);

  const handleSave = async () => {
    if (!form.name.trim() || !form.model.trim()) {
      showToast('Name and model are required', 'error');
      return;
    }

    try {
      setLoading(true);

      // Parse stopping strings
      let stoppingStrings: string[] | undefined;
      try {
        const parsed = JSON.parse(form.stoppingStringsJson);
        if (Array.isArray(parsed) && parsed.length > 0) {
          stoppingStrings = parsed;
        }
      } catch (e) {
        showToast('Invalid JSON for stopping strings', 'error');
        return;
      }

      const agentData: any = {
        name: form.name.trim(),
        description: form.description.trim(),
        systemPrompt: form.systemPrompt.trim() || form.description.trim(),
        // null (not undefined) so clearing the textarea actually clears the
        // saved template — buildUpdateFields skips undefined keys.
        promptTemplate: form.promptTemplate.trim() || null,
        greeting: form.greeting.trim() || undefined,
        provider: form.provider,
        model: form.model.trim(),
        temperature: form.temperature,
        // Only persist top_p when the model accepts it AND the user actually
        // dialed something in — otherwise leave it undefined so we don't send
        // a stale value to the SDK on a model that doesn't honor it.
        topP: capabilities.topP && typeof form.topP === 'number' ? form.topP : undefined,
        maxOutputTokens: form.maxOutputTokens || undefined,
        maxSteps: form.maxSteps || undefined,
        // `?? null` (not `|| null`): preserve a 0 the user typed instead of
        // silently collapsing it. Zod's `.positive()` will surface a clear
        // "must be positive" error. `null` (vs undefined) routes through
        // buildUpdateFields to actually clear the column on save.
        contextWindow: form.contextWindow ?? null,
        debugLogging: form.debugLogging,
        color: form.color,
        avatar: form.avatar || undefined,
        defaultTools: form.defaultTools.length > 0 ? form.defaultTools : undefined,
        // null (not undefined) so the DB column actually clears when the user
        // switches back to Auto — buildUpdateFields skips undefined keys.
        toolSendMode: form.toolSendMode === 'auto' ? null : form.toolSendMode,
        compactionMode: form.compactionMode === 'auto' ? null : form.compactionMode,
        // Note: mcpServers are managed via separate add/update/delete endpoints in the MCP tab,
        // not through the agent create/update payload.
        // `?? undefined` (not `|| undefined`): a typed 0 is a real value —
        // "$0 / free endpoint" override — not an absence. See buildUpdateFields.
        promptCostPer1M: form.promptCostPer1M ?? undefined,
        completionCostPer1M: form.completionCostPer1M ?? undefined,
      };

      // Add optional advanced features only if configured
      if (form.useInstructTemplate && form.instructTemplate.name) {
        agentData.instructTemplate = form.instructTemplate;
      }

      if (stoppingStrings && stoppingStrings.length > 0) {
        agentData.stoppingStrings = stoppingStrings;
      }

      if (Object.keys(form.contextVariables).length > 0) {
        agentData.contextVariables = form.contextVariables;
      }

      // Always send contextFormatting if any option is set — not gated on instruct template
      const hasFormattingConfig = Object.values(form.contextFormatting).some(v => v !== undefined);
      if (hasFormattingConfig) {
        agentData.contextFormatting = form.contextFormatting;
      }

      if (form.useArchetype) {
        agentData.archetype = form.archetype;
      }

      agentData.channelBehavior = form.channelBehavior;

      if (agentId) {
        await updateAgent(agentId, agentData);
        showToast('Agent updated', 'success');
      } else {
        await createAgent(agentData);
        showToast('Agent created', 'success');
      }

      await onSave();
      onClose();
    } catch (error: any) {
      console.error('Failed to save agent:', error);
      showToast(error.message || 'Failed to save agent', 'error');
    } finally {
      setLoading(false);
    }
  };

  const handleAddVariable = () => {
    if (form.newVarKey.trim()) {
      setForm(prev => ({
        ...prev,
        contextVariables: {
          ...prev.contextVariables,
          [prev.newVarKey.trim()]: prev.newVarValue,
        },
        newVarKey: '',
        newVarValue: '',
      }));
      setDirty(true);
    }
  };

  const handleRemoveVariable = (key: string) => {
    setForm(prev => {
      const newVars = { ...prev.contextVariables };
      delete newVars[key];
      return { ...prev, contextVariables: newVars };
    });
    setDirty(true);
  };

  // ── MCP servers (persist immediately via IPC; edit-only, needs an agentId) ─
  // These changes save independently of the form's Save button, so they update
  // form.mcpServers directly (not via setField — no "unsaved" flag).
  const handleAddMcp = async () => {
    if (!agentId) return;
    const valid = newMcp.name.trim() &&
      (newMcp.transport === 'stdio' ? newMcp.command.trim() : newMcp.url.trim());
    if (!valid) return;
    const data: Omit<MCPServer, 'id'> = {
      name: newMcp.name.trim(),
      transport: newMcp.transport,
      enabled: true,
      config: newMcp.transport === 'stdio'
        ? { command: newMcp.command.trim(), args: newMcp.args.trim() ? newMcp.args.trim().split(/\s+/) : [] }
        : { url: newMcp.url.trim() },
    };
    try {
      const created = await window.electron.addMCPServer(agentId, data);
      setForm(prev => ({ ...prev, mcpServers: [...prev.mcpServers, created] }));
      setNewMcp({ name: '', transport: 'stdio', command: '', args: '', url: '' });
      showToast('MCP server added', 'success');
    } catch (e: any) {
      showToast(e?.message || 'Failed to add MCP server', 'error');
    }
  };
  const handleToggleMcp = async (serverId: string, enabled: boolean) => {
    if (!agentId) return;
    try {
      const res = await window.electron.updateMCPServer(agentId, serverId, { enabled });
      if (res && res.success === false) throw new Error('Update rejected');
      setForm(prev => ({
        ...prev,
        mcpServers: prev.mcpServers.map(s => s.id === serverId ? { ...s, enabled } : s),
      }));
    } catch (e: any) {
      showToast(e?.message || 'Failed to update MCP server', 'error');
    }
  };
  const handleDeleteMcp = async (serverId: string) => {
    if (!agentId) return;
    if (!window.confirm('Delete this MCP server?')) return;
    try {
      const res = await window.electron.deleteMCPServer(agentId, serverId);
      if (res && res.success === false) throw new Error('Delete rejected');
      setForm(prev => ({ ...prev, mcpServers: prev.mcpServers.filter(s => s.id !== serverId) }));
      showToast('MCP server removed', 'success');
    } catch (e: any) {
      showToast(e?.message || 'Failed to remove MCP server', 'error');
    }
  };

  // ── Section nav + scroll-spy ────────────────────────────────────────────
  const sections = useMemo(() => [
    { id: 'identity', label: 'Identity' },
    { id: 'persona', label: 'Persona & prompt' },
    { id: 'sampling', label: 'Sampling' },
    { id: 'tools', label: 'Tools & context' },
    ...(capabilities.rawPrompt ? [{ id: 'local', label: 'Local formatting' }] : []),
    { id: 'channel', label: 'Channel behavior' },
    { id: 'autonomy', label: 'Autonomy' },
    { id: 'connections', label: 'Connections' },
    { id: 'debug', label: 'Debug' },
  ], [capabilities.rawPrompt]);

  useEffect(() => {
    const root = scrollRef.current;
    if (!root) return;
    const observer = new IntersectionObserver(
      (entries) => {
        const top = entries
          .filter(e => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
        if (top) setActiveSection((top.target as HTMLElement).id.replace('sec-', ''));
      },
      { root, rootMargin: '0px 0px -72% 0px', threshold: 0 },
    );
    sections.forEach(s => {
      const el = sectionRefs.current[s.id];
      if (el) observer.observe(el);
    });
    return () => observer.disconnect();
  }, [sections]);

  const scrollToSection = (id: string) => {
    const el = sectionRefs.current[id];
    const root = scrollRef.current;
    if (el && root) {
      root.scrollTo({ top: el.offsetTop - 12, behavior: 'smooth' });
      setActiveSection(id);
    }
  };
  const registerSection = (id: string) => (el: HTMLElement | null) => {
    sectionRefs.current[id] = el;
  };
  const sectionNumber = (id: string) =>
    String(sections.findIndex(s => s.id === id) + 1).padStart(2, '0');
  const sectionHead = (id: string, title: string) => (
    <div className="flex items-baseline gap-3 mb-5">
      <span className="font-mono text-sm text-muted-foreground">{sectionNumber(id)}</span>
      <h2 className="text-xl font-semibold">{title}</h2>
    </div>
  );
  const segBtn = (active: boolean) =>
    `px-3 py-1.5 rounded-md text-sm transition-colors ${
      active ? 'bg-background shadow-sm text-foreground' : 'text-muted-foreground hover:text-foreground'
    }`;

  // ── Archetype (driven by the shared registry) ───────────────────────────
  const activeArchetype = getArchetype(form.useArchetype ? form.archetype.type : 'task-oriented');
  const archetypeIsLegacy = !!(form.useArchetype && activeArchetype?.legacy);

  const selectArchetype = (type: string) => {
    if (type === 'task-oriented') {
      setField('useArchetype', false);
      setField('archetype', { ...form.archetype, type: 'task-oriented', leadAgentId: undefined });
    } else {
      setField('useArchetype', true);
      setField('archetype', {
        ...form.archetype,
        type: type as AgentArchetype['type'],
        ...(type === 'shadow' ? {} : { leadAgentId: undefined }),
      });
    }
  };

  // Renders an archetype-declared conditional field from its spec. Only the
  // control kinds actually in use are implemented; unknown kinds render nothing.
  const renderArchetypeField = (spec: ArchetypeFieldSpec) => {
    if (spec.control.kind !== 'agent-ref') return null;
    const c = spec.control;
    const key = spec.key as keyof AgentArchetype;
    const current = form.archetype[key] as string | undefined;
    const eligible = agents.filter(a =>
      (c.excludeSelf ? a.id !== agentId : true) &&
      (c.excludeArchetypes ? !c.excludeArchetypes.includes(a.archetype?.type ?? 'task-oriented') : true),
    );
    const pickFirst = () => setField('archetype', { ...form.archetype, [key]: eligible[0]?.id });
    const clear = () => setField('archetype', { ...form.archetype, [key]: undefined });
    return (
      <div key={spec.key}>
        <Label>{spec.label}</Label>
        {spec.description && (
          <p className="text-sm text-muted-foreground mt-1 mb-2">{spec.description}</p>
        )}
        <div className="space-y-2">
          <label className="flex items-center gap-2 cursor-pointer">
            <input type="radio" name={`arch-${spec.key}`} checked={!!current} onChange={pickFirst} />
            <span className="text-sm font-medium">{c.valueLabel ?? 'A specific agent'}</span>
          </label>
          <label className="flex items-center gap-2 cursor-pointer">
            <input type="radio" name={`arch-${spec.key}`} checked={!current} onChange={clear} />
            <span className="text-sm font-medium">{c.nullLabel ?? 'Any'}</span>
          </label>
        </div>
        {current && (
          <select
            value={current}
            onChange={(e) => setField('archetype', { ...form.archetype, [key]: e.target.value || undefined })}
            className="mt-3 w-full px-3 py-2 border border-border rounded-md bg-background"
          >
            {eligible.map(a => (
              <option key={a.id} value={a.id}>{a.name} ({a.provider}/{a.model})</option>
            ))}
          </select>
        )}
      </div>
    );
  };

  // ── Resolved-behavior helper text (so "Auto" isn't a mystery) ────────────
  const isLocalProvider = ['ollama', 'lmstudio'].includes(form.provider);
  const toolSendResolved = form.toolSendMode === 'all'
    ? 'Every tool schema is sent, so the model can enable and call a tool in the same turn — at full token cost each request.'
    : form.toolSendMode === 'enabled'
      ? 'Only the session-enabled tools (plus discovery tools) are sent. A newly enabled tool becomes callable on the next turn.'
      : `Auto → ${isLocalProvider ? 'enabled-only (protects the local context budget)' : 'all tools (cloud models have room)'}.`;
  const compactionResolved = form.compactionMode === 'off'
    ? 'Compaction is disabled — once history exceeds the budget the oldest messages are dropped (lossy), as before.'
    : form.compactionMode === 'manual'
      ? 'Summarized only when you trigger it.'
      : 'Over-budget conversations summarize their oldest turns via the system agent (a brief “Compacting…” indicator shows). A manual trigger and an editable summary are coming next.';

  const toolQuery = toolSearch.trim().toLowerCase();

  // Token weight + trust tiers for the default-tool selection.
  const invByName = new Map(toolInventory.map(e => [e.name, e]));
  const pluginTools = toolInventory.filter(e => e.source === 'plugin');
  const sizedSelected = form.defaultTools.filter(n => invByName.has(n));
  const selectionTokens = sizedSelected.reduce((sum, n) => sum + (invByName.get(n)?.estTokens ?? 0), 0);
  const unsizedSelected = form.defaultTools.length - sizedSelected.length;

  return (
    <div className="flex flex-col h-full">
      {/* Sticky header */}
      <div className="border-b border-border px-8 py-4 flex items-center gap-4">
        <div
          className="w-10 h-10 rounded-full flex items-center justify-center text-white font-bold flex-none overflow-hidden border border-border"
          style={{ backgroundColor: form.color }}
        >
          {form.avatar
            ? <img src={`avatar://${form.avatar}`} alt="" className="w-full h-full object-cover" />
            : (form.name[0]?.toUpperCase() || '?')}
        </div>
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h1 className="text-xl font-semibold truncate">{agentId ? 'Edit Agent' : 'Create Agent'}</h1>
            {dirty && (
              <span className="inline-flex items-center gap-1.5 text-xs text-amber-500 font-mono">
                <span className="w-1.5 h-1.5 rounded-full bg-amber-500" />unsaved
              </span>
            )}
          </div>
          <p className="text-sm text-muted-foreground truncate">
            {agentId
              ? <>Editing <span className="text-foreground font-medium">{form.name || 'agent'}</span></>
              : 'Create a new AI agent'}
            {form.model && <> · <span className="font-mono">{form.provider}/{form.model}</span></>}
          </p>
        </div>
        <div className="ml-auto flex gap-2">
          <Button variant="ghost" onClick={onClose} disabled={loading}>Cancel</Button>
          <Button onClick={handleSave} disabled={loading}>{loading ? 'Saving...' : 'Save Agent'}</Button>
        </div>
      </div>

      {/* Section nav + scrolling document */}
      <div className="flex-1 flex min-h-0">
        <nav className="w-52 flex-none border-r border-border overflow-y-auto py-6 px-3">
          <div className="font-mono text-[10px] tracking-wider uppercase text-muted-foreground px-3 pb-3">
            Configure
          </div>
          {sections.map(s => {
            const active = activeSection === s.id;
            return (
              <button
                key={s.id}
                onClick={() => scrollToSection(s.id)}
                className={`w-full flex items-center gap-3 text-left px-3 py-2 rounded-md text-sm mb-0.5 border-l-2 transition-colors ${
                  active
                    ? 'border-primary bg-accent text-foreground'
                    : 'border-transparent text-muted-foreground hover:text-foreground hover:bg-accent/50'
                }`}
              >
                <span className="font-mono text-[10px] text-muted-foreground w-4">{sectionNumber(s.id)}</span>
                <span className="flex-1">{s.label}</span>
              </button>
            );
          })}
        </nav>

        <div ref={scrollRef} className="flex-1 overflow-y-auto">
          <div className="max-w-5xl px-10 lg:px-12 py-8 pb-32 space-y-14">

            {/* 01 Identity */}
            <section id="sec-identity" ref={registerSection('identity')} className="scroll-mt-4">
              {sectionHead('identity', 'Identity')}
              <div className="space-y-5">
                <div>
                  <Label htmlFor="name">Agent Name *</Label>
                  <Input
                    id="name"
                    value={form.name}
                    onChange={(e) => setField('name', e.target.value)}
                    placeholder="My Agent"
                    className="mt-2"
                  />
                </div>

                <div>
                  <Label htmlFor="description">Short Description</Label>
                  <Input
                    id="description"
                    value={form.description}
                    onChange={(e) => setField('description', e.target.value)}
                    placeholder="A brief description for the UI"
                    className="mt-2"
                  />
                  <p className="text-sm text-muted-foreground mt-1">
                    Shown on cards and in menus. Full instructions live in Persona &amp; prompt.
                  </p>
                </div>

                <div className="space-y-1">
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <Label htmlFor="provider">Provider *</Label>
                    <select
                      id="provider"
                      value={form.provider}
                      onChange={(e) => setField('provider', e.target.value as AgentFormState['provider'])}
                      className="mt-2 w-full px-3 py-2 border border-border rounded-md bg-background"
                    >
                      <option value="anthropic">Anthropic</option>
                      <option value="openai">OpenAI</option>
                      <option value="google">Google</option>
                      <option value="openrouter">OpenRouter</option>
                      <option value="ollama">Ollama</option>
                      <option value="lmstudio">LM Studio</option>
                    </select>
                  </div>

                  <div>
                    <Label htmlFor="model">Model *</Label>
                    {availableModels.length > 30 ? (
                      <div className="mt-2">
                        <ModelCombobox
                          value={form.model}
                          options={availableModels}
                          onChange={(next) => setField('model', next)}
                          disabled={loadingModels}
                          placeholder={
                            form.provider === 'openrouter' ? 'anthropic/claude-sonnet-4-5' :
                            'Search models…'
                          }
                        />
                      </div>
                    ) : availableModels.length > 0 ? (
                      <select
                        id="model"
                        value={form.model}
                        onChange={(e) => setField('model', e.target.value)}
                        disabled={loadingModels}
                        className="mt-2 w-full px-3 py-2 border border-border rounded-md bg-background disabled:opacity-50"
                      >
                        {!availableModels.includes(form.model) && form.model && (
                          <option value={form.model}>{form.model}</option>
                        )}
                        {availableModels.map((model) => (
                          <option key={model} value={model}>{model}</option>
                        ))}
                      </select>
                    ) : (
                      <Input
                        id="model"
                        value={form.model}
                        onChange={(e) => setField('model', e.target.value)}
                        disabled={loadingModels}
                        placeholder={
                          form.provider === 'anthropic' ? 'claude-sonnet-4-20250514' :
                          form.provider === 'openai' ? 'gpt-4o' :
                          form.provider === 'openrouter' ? 'anthropic/claude-sonnet-4-5' :
                          form.provider === 'ollama' ? 'llama3.2' :
                          'model-name'
                        }
                        className="mt-2"
                      />
                    )}
                  </div>
                </div>

                {/* Full row, not the model column: a "start your model server"
                    message is a sentence, and half of a two-column grid wraps
                    it into a sliver that truncates the endpoint — the one part
                    you need to see. */}
                {loadingModels && (
                  <p className="text-sm text-muted-foreground">Loading models...</p>
                )}
                {modelError && (
                  <p className="text-xs text-destructive">{modelError}</p>
                )}
                </div>

                <details className="rounded-md border border-border/60 bg-muted/30 px-3 py-2 text-sm">
                  <summary className="cursor-pointer text-sm text-muted-foreground hover:text-foreground transition-colors">
                    Model capabilities — what this model accepts
                  </summary>
                  <ul className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
                    {([
                      ['temperature', 'Sampling temperature'],
                      ['topP', 'Top-p (nucleus)'],
                      ['stopSequences', 'Custom stop strings'],
                      ['maxOutputTokens', 'Max output tokens'],
                      ['toolUse', 'Tool / function calling'],
                      ['rawPrompt', 'Raw-prompt / instruct mode'],
                    ] as const).map(([key, label]) => (
                      <li key={key} className="flex items-center gap-2">
                        <span aria-hidden style={{ color: capabilities[key] ? '#22c55e' : 'var(--text-tertiary, #888)' }}>
                          {capabilities[key] ? '✓' : '—'}
                        </span>
                        <span style={{ opacity: capabilities[key] ? 1 : 0.55 }}>{label}</span>
                      </li>
                    ))}
                  </ul>
                  {detectedContext && (
                    <div className="mt-3 border-t border-border/60 pt-2 text-xs">
                      <div className="flex items-center justify-between">
                        <span className="text-muted-foreground">Context window (detected)</span>
                        <span className="font-mono">{detectedContext.contextWindow.toLocaleString()} tokens</span>
                      </div>
                      {typeof detectedContext.maxContextLength === 'number' &&
                       typeof detectedContext.loadedContextLength === 'number' &&
                       detectedContext.loadedContextLength < detectedContext.maxContextLength && (
                        <p className="mt-1 text-muted-foreground/80">
                          Model supports up to {detectedContext.maxContextLength.toLocaleString()}, but the server
                          loaded it at {detectedContext.loadedContextLength.toLocaleString()}. Raise the context
                          length in {form.provider === 'lmstudio' ? 'LM Studio' : 'your server'} to use more.
                        </p>
                      )}
                    </div>
                  )}
                </details>

                <div className="grid grid-cols-2 gap-6">
                  <div>
                    <Label htmlFor="color">Color</Label>
                    <div className="flex items-center gap-3 mt-2">
                      <input
                        id="color"
                        type="color"
                        value={form.color}
                        onChange={(e) => setField('color', e.target.value)}
                        className="w-16 h-10 rounded border border-border cursor-pointer"
                      />
                      <Input
                        value={form.color}
                        onChange={(e) => setField('color', e.target.value)}
                        className="flex-1"
                      />
                    </div>
                  </div>

                  <div>
                    <Label>Avatar</Label>
                    <div className="flex items-center gap-3 mt-2">
                      {form.avatar ? (
                        <img
                          src={`avatar://${form.avatar}`}
                          alt="Agent avatar"
                          className="w-16 h-16 rounded-full object-cover border border-border"
                        />
                      ) : (
                        <div
                          className="w-16 h-16 rounded-full flex items-center justify-center text-white text-xl font-bold border border-border"
                          style={{ backgroundColor: form.color }}
                        >
                          {form.name[0]?.toUpperCase() || '?'}
                        </div>
                      )}
                      <div className="flex flex-col gap-2">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={async () => {
                            const result = await window.electron.pickAvatar();
                            if (!result.canceled && result.filename) {
                              setField('avatar', result.filename);
                            }
                          }}
                        >
                          {form.avatar ? 'Change' : 'Upload'}
                        </Button>
                        {form.avatar && (
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => setField('avatar', undefined)}
                            className="text-muted-foreground"
                          >
                            Remove
                          </Button>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </section>

            {/* 02 Persona & prompt */}
            <section id="sec-persona" ref={registerSection('persona')} className="scroll-mt-4">
              {sectionHead('persona', 'Persona & prompt')}
              <div className="space-y-5">
                <div>
                  <Label htmlFor="systemPrompt">System Prompt / Instructions</Label>
                  <p className="text-sm text-muted-foreground mt-1 mb-3">
                    Full personality, instructions, and behavior for the agent.
                    Supports mustache variables like {`{{user}}`}, {`{{char}}`}, {`{{description}}`}.
                    {form.useArchetype && form.archetype.type === 'shadow' && (
                      <> For shadows, this is the instruction sent on every flush along with the event digest. Leave empty for the default memory extractor behavior.</>
                    )}
                  </p>
                  {form.useArchetype && form.archetype.type === 'shadow' && (
                    <div className="mb-3">
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          if (form.systemPrompt.trim() && !window.confirm(
                            'Replace the current System Prompt with the memory extractor template?'
                          )) return;
                          setField('systemPrompt', MEMORY_EXTRACTOR_PROMPT);
                        }}
                      >
                        Use memory extractor template
                      </Button>
                    </div>
                  )}
                  <Textarea
                    id="systemPrompt"
                    value={form.systemPrompt}
                    onChange={(e) => setField('systemPrompt', e.target.value)}
                    placeholder="You are a helpful assistant..."
                    className="min-h-[280px] font-mono text-sm"
                  />
                </div>

                <div>
                  <Label htmlFor="greeting">Opening Message <span className="text-muted-foreground font-normal">(optional)</span></Label>
                  <p className="text-sm text-muted-foreground mt-1 mb-3">
                    Auto-posted as the agent's first message when a new chat is created. Leave blank for none.
                  </p>
                  <Textarea
                    id="greeting"
                    value={form.greeting}
                    onChange={(e) => setField('greeting', e.target.value)}
                    placeholder="Hi! I'm here to help..."
                    className="min-h-[100px] text-sm"
                  />
                </div>

                <details className="rounded-lg border border-border">
                  <summary className="cursor-pointer px-4 py-3 text-sm font-medium text-muted-foreground hover:text-foreground">
                    Prompt template &amp; context variables
                    <span className="ml-2 font-mono text-[10px] uppercase tracking-wide text-primary border border-primary/40 rounded px-1.5 py-0.5">advanced</span>
                  </summary>
                  <div className="px-4 pb-4 pt-1 border-t border-border space-y-5">
                    <div>
                      <div className="flex items-center justify-between mb-1">
                        <Label htmlFor="promptTemplate">Prompt Template <span className="text-muted-foreground font-normal">(optional)</span></Label>
                        {!form.promptTemplate.trim() ? (
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            onClick={() => setField('promptTemplate', DEFAULT_PROMPT_TEMPLATE)}
                          >
                            Load default template
                          </Button>
                        ) : (
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            onClick={() => {
                              if (window.confirm('Clear the template and fall back to the built-in scaffolding?')) {
                                setField('promptTemplate', '');
                              }
                            }}
                          >
                            Reset to built-in
                          </Button>
                        )}
                      </div>
                      <p className="text-sm text-muted-foreground mb-3">
                        Wraps the System Prompt with structural context — project name, participants, tool inventory, etc.
                        Leave blank to use the built-in scaffolding.
                      </p>
                      <Textarea
                        id="promptTemplate"
                        value={form.promptTemplate}
                        onChange={(e) => setField('promptTemplate', e.target.value)}
                        placeholder={DEFAULT_PROMPT_TEMPLATE}
                        className="min-h-[160px] font-mono text-xs"
                      />
                      <details className="mt-2">
                        <summary className="cursor-pointer text-sm text-muted-foreground hover:text-foreground">
                          Available variables
                        </summary>
                        <ul className="mt-2 grid grid-cols-1 md:grid-cols-2 gap-x-4 gap-y-1 text-xs">
                          {PROMPT_TEMPLATE_VARIABLES.map(v => (
                            <li key={v.name} className="flex gap-2">
                              <code className="font-mono text-foreground">{`{{${v.name}}}`}</code>
                              <span className="text-muted-foreground">— {v.description}</span>
                            </li>
                          ))}
                        </ul>
                      </details>
                    </div>

                    <div>
                      <Label>Context Variables</Label>
                      <p className="text-sm text-muted-foreground mt-1 mb-3">
                        Custom {`{{name}}`} → value pairs substituted into prompts and templates.
                      </p>
                      <div className="space-y-3 mb-4">
                        {Object.entries(form.contextVariables).map(([key, value]) => (
                          <div key={key} className="flex items-center gap-3">
                            <code className="px-3 py-2 bg-muted rounded text-sm flex-shrink-0 w-32 font-mono">
                              {`{{${key}}}`}
                            </code>
                            <Input value={value} disabled className="flex-1" />
                            <Button variant="ghost" size="sm" onClick={() => handleRemoveVariable(key)}>
                              Remove
                            </Button>
                          </div>
                        ))}
                      </div>
                      <div className="flex gap-3">
                        <Input
                          value={form.newVarKey}
                          onChange={(e) => setField('newVarKey', e.target.value)}
                          placeholder="Variable name"
                          className="w-48"
                        />
                        <Input
                          value={form.newVarValue}
                          onChange={(e) => setField('newVarValue', e.target.value)}
                          placeholder="Value"
                          className="flex-1"
                        />
                        <Button onClick={handleAddVariable}>Add</Button>
                      </div>
                    </div>
                  </div>
                </details>
              </div>
            </section>

            {/* 03 Sampling */}
            <section id="sec-sampling" ref={registerSection('sampling')} className="scroll-mt-4">
              {sectionHead('sampling', 'Sampling')}
              <div className="space-y-5">
                <div className="grid grid-cols-2 gap-4">
                  {capabilities.temperature && (
                    <div>
                      <Label htmlFor="temperature">Temperature</Label>
                      <Input
                        id="temperature"
                        type="number"
                        step="0.1"
                        min="0"
                        max="2"
                        value={form.temperature}
                        onChange={(e) => setField('temperature', parseFloat(e.target.value))}
                        className="mt-2"
                      />
                      <p className="text-sm text-muted-foreground mt-1">0 focused · 2 creative.</p>
                    </div>
                  )}
                  <div>
                    <Label htmlFor="maxSteps">Max Steps</Label>
                    <Input
                      id="maxSteps"
                      type="number"
                      value={form.maxSteps || ''}
                      onChange={(e) => setField('maxSteps', e.target.value ? parseInt(e.target.value) : undefined)}
                      placeholder="10"
                      className="mt-2"
                    />
                    <p className="text-sm text-muted-foreground mt-1">Tool-call rounds per turn before it must reply. 1–50.</p>
                  </div>
                </div>

                <details className="rounded-lg border border-border">
                  <summary className="cursor-pointer px-4 py-3 text-sm font-medium text-muted-foreground hover:text-foreground">
                    Advanced sampling, context &amp; cost
                    <span className="ml-2 font-mono text-[10px] uppercase tracking-wide text-primary border border-primary/40 rounded px-1.5 py-0.5">advanced</span>
                  </summary>
                  <div className="px-4 pb-4 pt-1 border-t border-border space-y-5">
                    <p className="text-sm text-muted-foreground pt-3">
                      These are overrides — clear a field (Reset) to fall back to the model default.
                    </p>
                    <div className="grid grid-cols-2 gap-4">
                      {capabilities.topP && (
                        <div>
                          <Label htmlFor="topP">Top-P</Label>
                          <div className="flex items-center gap-2 mt-2">
                            <Input
                              id="topP"
                              type="number"
                              step="0.05"
                              min="0"
                              max="1"
                              value={form.topP ?? ''}
                              placeholder="Auto"
                              onChange={(e) => {
                                const v = e.target.value;
                                setField('topP', v === '' ? undefined : parseFloat(v));
                              }}
                            />
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => setField('topP', undefined)}
                              className="text-muted-foreground flex-none"
                              title="Reset to model default"
                            >
                              <RotateCcw className="w-3.5 h-3.5" />
                            </Button>
                          </div>
                        </div>
                      )}
                      {capabilities.maxOutputTokens && (
                        <div>
                          <Label htmlFor="maxTokens">Max Output Tokens</Label>
                          <div className="flex items-center gap-2 mt-2">
                            <Input
                              id="maxTokens"
                              type="number"
                              value={form.maxOutputTokens || ''}
                              onChange={(e) => setField('maxOutputTokens', e.target.value ? parseInt(e.target.value) : undefined)}
                              placeholder="Auto"
                            />
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => setField('maxOutputTokens', undefined)}
                              className="text-muted-foreground flex-none"
                              title="Reset to model default"
                            >
                              <RotateCcw className="w-3.5 h-3.5" />
                            </Button>
                          </div>
                        </div>
                      )}
                    </div>

                    <div>
                      <Label htmlFor="contextWindow">Context Window</Label>
                      <div className="flex items-center gap-2 mt-2">
                        <Input
                          id="contextWindow"
                          type="number"
                          value={form.contextWindow ?? ''}
                          onChange={(e) => setField('contextWindow', e.target.value === '' ? undefined : parseInt(e.target.value))}
                          placeholder={detectedContext ? `Auto (${detectedContext.contextWindow.toLocaleString()})` : 'Auto-detect'}
                        />
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => setField('contextWindow', undefined)}
                          className="text-muted-foreground flex-none"
                          title="Reset to auto-detect"
                        >
                          <RotateCcw className="w-3.5 h-3.5" />
                        </Button>
                      </div>
                      {typeof form.contextWindow === 'number' &&
                       typeof detectedContext?.loadedContextLength === 'number' &&
                       form.contextWindow > detectedContext.loadedContextLength && (
                        <p className="mt-1 text-xs text-amber-500">
                          {form.provider === 'lmstudio' ? 'LM Studio' : 'The server'} loaded this model at{' '}
                          {detectedContext.loadedContextLength.toLocaleString()} tokens — requests past it will be
                          rejected. Reload it with a larger context, or lower this value.
                        </p>
                      )}
                    </div>

                    <div className="grid grid-cols-2 gap-4">
                      <div>
                        <Label htmlFor="promptCost">Prompt Cost ($/1M tokens)</Label>
                        <Input
                          id="promptCost"
                          type="number"
                          step="0.01"
                          min="0"
                          value={form.promptCostPer1M ?? ''}
                          onChange={(e) => setField('promptCostPer1M', e.target.value ? parseFloat(e.target.value) : undefined)}
                          placeholder="Auto-detect"
                          className="mt-2"
                        />
                      </div>
                      <div>
                        <Label htmlFor="completionCost">Completion Cost ($/1M tokens)</Label>
                        <Input
                          id="completionCost"
                          type="number"
                          step="0.01"
                          min="0"
                          value={form.completionCostPer1M ?? ''}
                          onChange={(e) => setField('completionCostPer1M', e.target.value ? parseFloat(e.target.value) : undefined)}
                          placeholder="Auto-detect"
                          className="mt-2"
                        />
                      </div>
                    </div>
                  </div>
                </details>
              </div>
            </section>

            {/* 04 Tools & context */}
            <section id="sec-tools" ref={registerSection('tools')} className="scroll-mt-4">
              {sectionHead('tools', 'Tools & context')}
              <div className="space-y-6">
                <div>
                  <Label htmlFor="toolSendMode">Tool schemas sent to model</Label>
                  <p className="text-sm text-muted-foreground mt-1 mb-2">
                    Tool definitions ride along every request and can cost thousands of tokens.
                  </p>
                  <select
                    id="toolSendMode"
                    value={form.toolSendMode}
                    onChange={(e) => setField('toolSendMode', e.target.value as AgentFormState['toolSendMode'])}
                    className="w-full max-w-md rounded-md border border-input bg-background px-3 py-2 text-sm"
                  >
                    <option value="auto">Auto — default for this provider</option>
                    <option value="all">All available tools (best for large-context cloud models)</option>
                    <option value="enabled">Only enabled tools (best for local / small-context models)</option>
                  </select>
                  <div className="mt-2 inline-block rounded-md border border-border bg-muted/40 px-3 py-2 text-sm text-muted-foreground max-w-md">
                    {toolSendResolved}
                  </div>
                </div>

                <div>
                  <Label htmlFor="compactionMode">History compaction</Label>
                  <p className="text-sm text-muted-foreground mt-1 mb-2">
                    What happens when a conversation outgrows its context budget.
                  </p>
                  <select
                    id="compactionMode"
                    value={form.compactionMode}
                    onChange={(e) => setField('compactionMode', e.target.value as AgentFormState['compactionMode'])}
                    className="w-full max-w-md rounded-md border border-input bg-background px-3 py-2 text-sm"
                  >
                    <option value="auto">Auto — summarize aged turns when over budget (default)</option>
                    <option value="off">Off — never compact; drop the oldest turns instead</option>
                    <option value="manual" disabled>Manual — compact only on explicit trigger (coming soon)</option>
                  </select>
                  <div className="mt-2 inline-block rounded-md border border-border bg-muted/40 px-3 py-2 text-sm text-muted-foreground max-w-md">
                    {compactionResolved}
                  </div>
                </div>

                <div className="pt-2 border-t border-border">
                  <div className="flex items-center justify-between mb-1">
                    <Label>Default tools</Label>
                    <span className="font-mono text-xs text-primary">{form.defaultTools.length} enabled</span>
                  </div>
                  <p className="text-sm text-muted-foreground mb-3">
                    Enabled from the start of each session. Discovery tools (list_tools, enable_tool, disable_tool,
                    get_tool_info) are always available and don't need selecting.
                  </p>
                  {form.defaultTools.length > 0 && selectionTokens > 0 && (
                    <div className="mb-3 inline-flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md border border-border bg-muted/40 px-3 py-1.5 text-sm text-muted-foreground">
                      <span className="font-mono text-primary">≈ ~{selectionTokens.toLocaleString()} tokens/turn</span>
                      <span>
                        ride along with these default tools
                        {unsizedSelected > 0 && ` · +${unsizedSelected} MCP tool${unsizedSelected > 1 ? 's' : ''} not counted`}
                      </span>
                    </div>
                  )}
                  <Input
                    value={toolSearch}
                    onChange={(e) => setToolSearch(e.target.value)}
                    placeholder="Search tools…"
                    className="mb-4 max-w-md"
                  />
                  <div className="space-y-5">
                    {Array.from(getToolsByCategory().entries()).map(([category, tools]) => {
                      const filtered = toolQuery
                        ? tools.filter(t =>
                            t.label.toLowerCase().includes(toolQuery) ||
                            t.name.toLowerCase().includes(toolQuery) ||
                            t.description.toLowerCase().includes(toolQuery))
                        : tools;
                      if (filtered.length === 0) return null;
                      const enabledInCat = form.defaultTools.filter(t => tools.some(tool => tool.name === t)).length;
                      return (
                        <div key={category}>
                          <h4 className="font-medium mb-2 flex items-center gap-2 text-sm">
                            {CATEGORY_LABELS[category]}
                            <Badge variant="secondary" className="text-xs">{enabledInCat} / {tools.length}</Badge>
                          </h4>
                          <div className="space-y-1.5 pl-1">
                            {filtered.map(tool => (
                              <div key={tool.name} className="flex items-start gap-3">
                                <input
                                  type="checkbox"
                                  id={`tool-${tool.name}`}
                                  checked={form.defaultTools.includes(tool.name)}
                                  onChange={(e) => {
                                    if (e.target.checked) {
                                      setField('defaultTools', [...form.defaultTools, tool.name]);
                                    } else {
                                      setField('defaultTools', form.defaultTools.filter(t => t !== tool.name));
                                    }
                                  }}
                                  className="w-4 h-4 mt-0.5"
                                />
                                <Label htmlFor={`tool-${tool.name}`} className="cursor-pointer flex-1">
                                  <span className="font-medium">{tool.label}</span>
                                  <span className="text-sm text-muted-foreground block">{tool.description}</span>
                                </Label>
                              </div>
                            ))}
                          </div>
                        </div>
                      );
                    })}

                    {pluginTools.length > 0 && (() => {
                      const filtered = toolQuery
                        ? pluginTools.filter(t =>
                            t.name.toLowerCase().includes(toolQuery) ||
                            t.description.toLowerCase().includes(toolQuery))
                        : pluginTools;
                      if (filtered.length === 0) return null;
                      const enabled = pluginTools.filter(t => form.defaultTools.includes(t.name)).length;
                      return (
                        <div>
                          <h4 className="font-medium mb-2 flex items-center gap-2 text-sm">
                            Plugin tools
                            <Badge variant="outline" className="text-xs">plugin</Badge>
                            <Badge variant="secondary" className="text-xs">{enabled} / {pluginTools.length}</Badge>
                          </h4>
                          <div className="space-y-1.5 pl-1">
                            {filtered.map(tool => (
                              <div key={tool.name} className="flex items-start gap-3">
                                <input
                                  type="checkbox"
                                  id={`tool-${tool.name}`}
                                  checked={form.defaultTools.includes(tool.name)}
                                  onChange={(e) => {
                                    if (e.target.checked) setField('defaultTools', [...form.defaultTools, tool.name]);
                                    else setField('defaultTools', form.defaultTools.filter(t => t !== tool.name));
                                  }}
                                  className="w-4 h-4 mt-0.5"
                                />
                                <Label htmlFor={`tool-${tool.name}`} className="cursor-pointer flex-1">
                                  <span className="font-medium font-mono text-xs">{tool.name}</span>
                                  <span className="text-sm text-muted-foreground block">{tool.description || 'Plugin-provided tool'}</span>
                                </Label>
                              </div>
                            ))}
                          </div>
                        </div>
                      );
                    })()}
                  </div>

                  <div className="flex items-center justify-between pt-4 mt-4 border-t border-border">
                    <div className="text-sm text-muted-foreground">{form.defaultTools.length} tools selected</div>
                    <div className="flex gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setField('defaultTools', [])}
                        disabled={form.defaultTools.length === 0}
                      >
                        Clear All
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setField('defaultTools', TOOL_CATALOG.map(t => t.name))}
                      >
                        Select All
                      </Button>
                    </div>
                  </div>
                </div>
              </div>
            </section>

            {/* 05 Local-model formatting (conditional) */}
            {capabilities.rawPrompt && (
              <section id="sec-local" ref={registerSection('local')} className="scroll-mt-4">
                {sectionHead('local', 'Local-model formatting')}
                <div className="flex gap-2 items-baseline rounded-md border border-primary/20 bg-primary/5 px-3 py-2 mb-5 text-sm text-muted-foreground">
                  Shown because <span className="font-medium text-foreground">{form.model}</span> is a raw-prompt / local instruct model. This zone hides for cloud models.
                </div>
                <div className="space-y-6">
                  <div className="flex items-center gap-3">
                    <input
                      type="checkbox"
                      id="useInstructTemplate"
                      checked={form.useInstructTemplate}
                      onChange={(e) => setField('useInstructTemplate', e.target.checked)}
                      className="w-4 h-4"
                    />
                    <Label htmlFor="useInstructTemplate" className="cursor-pointer">Use instruct template</Label>
                  </div>

                  {form.useInstructTemplate && (
                    <>
                      <div className="grid grid-cols-2 gap-4">
                        <div>
                          <Label htmlFor="templateName">Template Name</Label>
                          <Input
                            id="templateName"
                            value={form.instructTemplate.name}
                            onChange={(e) => setField('instructTemplate', { ...form.instructTemplate, name: e.target.value })}
                            placeholder="Llama-3-Instruct"
                            className="mt-2"
                          />
                        </div>
                        <div>
                          <Label htmlFor="activationRegex">Activation Regex</Label>
                          <Input
                            id="activationRegex"
                            value={form.instructTemplate.activationRegex || ''}
                            onChange={(e) => setField('instructTemplate', { ...form.instructTemplate, activationRegex: e.target.value })}
                            placeholder="/llama(-)?(3|3.1)/i"
                            className="mt-2 font-mono text-xs"
                          />
                        </div>
                      </div>

                      <div>
                        <Label>User Message Sequence</Label>
                        <div className="grid grid-cols-2 gap-3 mt-2">
                          <Input
                            value={form.instructTemplate.userMessageSequence?.prefix || ''}
                            onChange={(e) => setField('instructTemplate', { ...form.instructTemplate, userMessageSequence: { prefix: e.target.value, suffix: form.instructTemplate.userMessageSequence?.suffix || '' } })}
                            placeholder="Prefix: <|start_header_id|>{{name}}<|end_header_id|>"
                            className="font-mono text-xs"
                          />
                          <Input
                            value={form.instructTemplate.userMessageSequence?.suffix || ''}
                            onChange={(e) => setField('instructTemplate', { ...form.instructTemplate, userMessageSequence: { prefix: form.instructTemplate.userMessageSequence?.prefix || '', suffix: e.target.value } })}
                            placeholder="Suffix: <|eot_id|>"
                            className="font-mono text-xs"
                          />
                        </div>
                      </div>

                      <div>
                        <Label>Assistant Message Sequence</Label>
                        <div className="grid grid-cols-2 gap-3 mt-2">
                          <Input
                            value={form.instructTemplate.assistantMessageSequence?.prefix || ''}
                            onChange={(e) => setField('instructTemplate', { ...form.instructTemplate, assistantMessageSequence: { prefix: e.target.value, suffix: form.instructTemplate.assistantMessageSequence?.suffix || '' } })}
                            placeholder="Prefix"
                            className="font-mono text-xs"
                          />
                          <Input
                            value={form.instructTemplate.assistantMessageSequence?.suffix || ''}
                            onChange={(e) => setField('instructTemplate', { ...form.instructTemplate, assistantMessageSequence: { prefix: form.instructTemplate.assistantMessageSequence?.prefix || '', suffix: e.target.value } })}
                            placeholder="Suffix"
                            className="font-mono text-xs"
                          />
                        </div>
                      </div>

                      <div>
                        <Label>System Message Sequence</Label>
                        <div className="grid grid-cols-2 gap-3 mt-2">
                          <Input
                            value={form.instructTemplate.systemMessageSequence?.prefix || ''}
                            onChange={(e) => setField('instructTemplate', { ...form.instructTemplate, systemMessageSequence: { prefix: e.target.value, suffix: form.instructTemplate.systemMessageSequence?.suffix || '' } })}
                            placeholder="Prefix"
                            className="font-mono text-xs"
                          />
                          <Input
                            value={form.instructTemplate.systemMessageSequence?.suffix || ''}
                            onChange={(e) => setField('instructTemplate', { ...form.instructTemplate, systemMessageSequence: { prefix: form.instructTemplate.systemMessageSequence?.prefix || '', suffix: e.target.value } })}
                            placeholder="Suffix"
                            className="font-mono text-xs"
                          />
                        </div>
                      </div>

                      <div className="space-y-3">
                        <div className="flex items-center gap-3">
                          <input
                            type="checkbox"
                            id="wrapNewline"
                            checked={form.instructTemplate.wrapSequencesWithNewline || false}
                            onChange={(e) => setField('instructTemplate', { ...form.instructTemplate, wrapSequencesWithNewline: e.target.checked })}
                            className="w-4 h-4"
                          />
                          <Label htmlFor="wrapNewline" className="cursor-pointer">Wrap sequences with newline</Label>
                        </div>
                        <div className="flex items-center gap-3">
                          <input
                            type="checkbox"
                            id="replaceMacro"
                            checked={form.instructTemplate.replaceMacroInSequences || false}
                            onChange={(e) => setField('instructTemplate', { ...form.instructTemplate, replaceMacroInSequences: e.target.checked })}
                            className="w-4 h-4"
                          />
                          <Label htmlFor="replaceMacro" className="cursor-pointer">Replace macro in sequences</Label>
                        </div>
                      </div>

                      <div>
                        <Label htmlFor="includeNames">Include Names</Label>
                        <select
                          id="includeNames"
                          value={form.instructTemplate.includeNames || 'auto'}
                          onChange={(e) => setField('instructTemplate', { ...form.instructTemplate, includeNames: e.target.value as InstructTemplate['includeNames'] })}
                          className="mt-2 w-full max-w-xs px-3 py-2 border border-border rounded-md bg-background"
                        >
                          <option value="always">Always</option>
                          <option value="never">Never</option>
                          <option value="auto">Auto</option>
                        </select>
                      </div>
                    </>
                  )}

                  <div className="border-t border-border pt-5">
                    <Label>Context formatting</Label>
                    <div className="space-y-3 mt-3">
                      <div className="flex items-center gap-3">
                        <input
                          type="checkbox"
                          id="alwaysAddCharacterName"
                          checked={form.contextFormatting.alwaysAddCharacterName || false}
                          onChange={(e) => setField('contextFormatting', { ...form.contextFormatting, alwaysAddCharacterName: e.target.checked })}
                          className="w-4 h-4"
                        />
                        <Label htmlFor="alwaysAddCharacterName" className="cursor-pointer">Always add character's name to prompt</Label>
                      </div>
                      <div className="flex items-center gap-3">
                        <input
                          type="checkbox"
                          id="trimSpaces"
                          checked={form.contextFormatting.trimSpaces !== false}
                          onChange={(e) => setField('contextFormatting', { ...form.contextFormatting, trimSpaces: e.target.checked })}
                          className="w-4 h-4"
                        />
                        <Label htmlFor="trimSpaces" className="cursor-pointer">Trim spaces</Label>
                      </div>
                      <div className="flex items-center gap-3">
                        <input
                          type="checkbox"
                          id="trimIncompleteSentences"
                          checked={form.contextFormatting.trimIncompleteSentences || false}
                          onChange={(e) => setField('contextFormatting', { ...form.contextFormatting, trimIncompleteSentences: e.target.checked })}
                          className="w-4 h-4"
                        />
                        <Label htmlFor="trimIncompleteSentences" className="cursor-pointer">Trim incomplete sentences</Label>
                      </div>
                      <div className="flex items-center gap-3">
                        <input
                          type="checkbox"
                          id="collapseConsecutiveNewlines"
                          checked={form.contextFormatting.collapseConsecutiveNewlines || false}
                          onChange={(e) => setField('contextFormatting', { ...form.contextFormatting, collapseConsecutiveNewlines: e.target.checked })}
                          className="w-4 h-4"
                        />
                        <Label htmlFor="collapseConsecutiveNewlines" className="cursor-pointer">Collapse consecutive newlines</Label>
                      </div>
                      <div className="flex items-center gap-3">
                        <input
                          type="checkbox"
                          id="separatorsAsStopStrings"
                          checked={form.contextFormatting.separatorsAsStopStrings || false}
                          onChange={(e) => setField('contextFormatting', { ...form.contextFormatting, separatorsAsStopStrings: e.target.checked })}
                          className="w-4 h-4"
                        />
                        <Label htmlFor="separatorsAsStopStrings" className="cursor-pointer">Separators as stop strings</Label>
                      </div>
                    </div>
                  </div>

                  {capabilities.stopSequences && (
                    <div>
                      <Label htmlFor="stoppingStrings">Stopping Strings (JSON array)</Label>
                      <Textarea
                        id="stoppingStrings"
                        value={form.stoppingStringsJson}
                        onChange={(e) => setField('stoppingStringsJson', e.target.value)}
                        placeholder='["<|eot_id|>", "</s>", "Human:"]'
                        className="mt-2 min-h-[100px] font-mono text-xs"
                      />
                      <p className="text-sm text-muted-foreground mt-1">Strings that signal the model to stop generating.</p>
                    </div>
                  )}
                </div>
              </section>
            )}

            {/* Channel behavior */}
            <section id="sec-channel" ref={registerSection('channel')} className="scroll-mt-4">
              {sectionHead('channel', 'Channel behavior')}
              <p className="text-sm text-muted-foreground mb-4 max-w-xl">
                How this agent acts in multi-participant channels. The agent can also change these itself from within a conversation.
              </p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-6 max-w-xl">
                <div>
                  <Label className="mb-2 block">Respond to</Label>
                  <div className="inline-flex gap-1 rounded-lg border border-border bg-muted/40 p-1">
                    {([['mentions-only', 'Mentions only'], ['all', 'All messages']] as const).map(([val, label]) => (
                      <button
                        key={val}
                        type="button"
                        onClick={() => setField('channelBehavior', { ...form.channelBehavior, respondTo: val })}
                        className={segBtn(form.channelBehavior.respondTo === val)}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                  <p className="text-sm text-muted-foreground mt-2">
                    {form.channelBehavior.respondTo === 'all'
                      ? 'Replies to every message in channels it joins.'
                      : 'Only replies when explicitly @mentioned.'}
                  </p>
                </div>
                <div>
                  <Label className="mb-2 block">Verbosity</Label>
                  <div className="inline-flex gap-1 rounded-lg border border-border bg-muted/40 p-1">
                    {([['brief', 'Brief'], ['normal', 'Normal'], ['verbose', 'Verbose']] as const).map(([val, label]) => (
                      <button
                        key={val}
                        type="button"
                        onClick={() => setField('channelBehavior', { ...form.channelBehavior, verbosity: val })}
                        className={segBtn(form.channelBehavior.verbosity === val)}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                  <p className="text-sm text-muted-foreground mt-2">
                    {form.channelBehavior.verbosity === 'brief' ? 'Keeps channel replies to 1–3 sentences.' : 'Sets how much the agent says in channels.'}
                  </p>
                </div>
              </div>
            </section>

            {/* 06 Autonomy */}
            <section id="sec-autonomy" ref={registerSection('autonomy')} className="scroll-mt-4">
              {sectionHead('autonomy', 'Autonomy')}
              <div className="space-y-4">
                <div>
                  <Label htmlFor="archetype">Archetype</Label>
                  <p className="text-sm text-muted-foreground mt-1 mb-2">
                    The kind of agent. Most agents are Standard — the others are opt-in modules.
                  </p>
                  <select
                    id="archetype"
                    value={form.useArchetype ? form.archetype.type : 'task-oriented'}
                    onChange={(e) => selectArchetype(e.target.value)}
                    className="w-full max-w-md px-3 py-2 border border-border rounded-md bg-background"
                  >
                    {SELECTABLE_ARCHETYPES.map(a => (
                      <option key={a.type} value={a.type}>{a.label}</option>
                    ))}
                    {archetypeIsLegacy && (
                      <option value={form.archetype.type} disabled>
                        {form.archetype.type} (legacy — behaves as Standard)
                      </option>
                    )}
                  </select>
                  {activeArchetype?.description && !archetypeIsLegacy && (
                    <p className="text-sm text-muted-foreground mt-2 max-w-xl">{activeArchetype.description}</p>
                  )}
                </div>

                {form.useArchetype && !archetypeIsLegacy &&
                  activeArchetype?.fields?.map(renderArchetypeField)}
              </div>
            </section>

            {/* 07 Connections */}
            <section id="sec-connections" ref={registerSection('connections')} className="scroll-mt-4">
              {sectionHead('connections', 'Connections')}
              <p className="text-sm text-muted-foreground mb-4">
                MCP servers extend this agent with external tools. Changes here save immediately — independent of the Save button.
              </p>

              {form.mcpServers.length > 0 ? (
                <div className="space-y-2 mb-4">
                  {form.mcpServers.map((server) => (
                    <div key={server.id} className="flex items-center gap-3 p-3 rounded-lg border border-border bg-muted/40">
                      <input
                        type="checkbox"
                        checked={server.enabled}
                        onChange={(e) => handleToggleMcp(server.id, e.target.checked)}
                        className="h-4 w-4"
                        title={server.enabled ? 'Enabled — click to disable' : 'Disabled — click to enable'}
                      />
                      <div className="flex-1 min-w-0">
                        <div className="font-medium text-sm">{server.name}</div>
                        <div className="text-sm text-muted-foreground truncate font-mono">
                          {server.transport === 'stdio'
                            ? [server.config.command, ...(server.config.args ?? [])].filter(Boolean).join(' ')
                            : server.config.url}
                        </div>
                      </div>
                      <Badge variant={server.enabled ? 'secondary' : 'outline'}>{server.transport}</Badge>
                      <Button variant="ghost" size="sm" onClick={() => handleDeleteMcp(server.id)} className="text-muted-foreground">
                        Remove
                      </Button>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-sm text-muted-foreground p-4 text-center bg-muted rounded-lg mb-4">
                  No MCP servers configured yet.
                </p>
              )}

              {agentId ? (
                <div className="rounded-lg border border-border p-4 space-y-3">
                  <div className="text-sm font-medium">Add server</div>
                  <div className="grid grid-cols-2 gap-3">
                    <Input
                      value={newMcp.name}
                      onChange={(e) => setNewMcp({ ...newMcp, name: e.target.value })}
                      placeholder="Name (e.g. Filesystem)"
                    />
                    <select
                      value={newMcp.transport}
                      onChange={(e) => setNewMcp({ ...newMcp, transport: e.target.value as MCPServer['transport'] })}
                      className="px-3 py-2 border border-border rounded-md bg-background text-sm"
                    >
                      <option value="stdio">stdio (local process)</option>
                      <option value="sse">SSE</option>
                      <option value="http">HTTP</option>
                    </select>
                  </div>
                  {newMcp.transport === 'stdio' ? (
                    <div className="grid grid-cols-2 gap-3">
                      <Input value={newMcp.command} onChange={(e) => setNewMcp({ ...newMcp, command: e.target.value })} placeholder="Command (e.g. npx)" className="font-mono text-xs" />
                      <Input value={newMcp.args} onChange={(e) => setNewMcp({ ...newMcp, args: e.target.value })} placeholder="Args (space-separated)" className="font-mono text-xs" />
                    </div>
                  ) : (
                    <Input value={newMcp.url} onChange={(e) => setNewMcp({ ...newMcp, url: e.target.value })} placeholder="http://localhost:3000/mcp" className="font-mono text-xs" />
                  )}
                  <Button size="sm" onClick={handleAddMcp}>+ Add MCP server</Button>
                </div>
              ) : (
                <div className="rounded-lg border border-dashed border-border p-4 text-sm text-muted-foreground text-center">
                  Save the agent first to add MCP servers.
                </div>
              )}
            </section>

            {/* 08 Debug */}
            <section id="sec-debug" ref={registerSection('debug')} className="scroll-mt-4">
              {sectionHead('debug', 'Debug')}
              <label className="flex items-center gap-3 rounded-lg border border-border p-4 cursor-pointer">
                <input
                  type="checkbox"
                  checked={form.debugLogging}
                  onChange={(e) => setField('debugLogging', e.target.checked)}
                  className="h-4 w-4 rounded border-border"
                />
                <div>
                  <div className="font-medium text-sm">Debug logging</div>
                  <div className="text-sm text-muted-foreground">Store the full resolved system prompt with each message for inspection. Off for normal use.</div>
                </div>
              </label>
            </section>

          </div>
        </div>
      </div>
    </div>
  );
}
