import { create } from 'zustand';
import { Agent } from '@/types';
import { useToastStore } from './useToastStore';

interface AgentState {
  // State
  agents: Agent[];
  currentAgentId: string | null;

  // UI State
  editingAgentId: string | null; // For MCP management
  showMCPModal: boolean;

  // Actions
  setAgents: (agents: Agent[]) => void;
  setCurrentAgentId: (id: string | null) => void;

  // Agent CRUD
  createAgent: (agentData: Omit<Agent, 'id' | 'createdAt'>) => Promise<void>;
  updateAgent: (agentId: string, updates: Partial<Agent>) => Promise<void>;
  deleteAgent: (agentId: string) => Promise<void>;
  switchAgent: (agentId: string) => Promise<void>;

  // Modal Management
  openMCPModal: (agentId: string) => void;
  closeMCPModal: () => void;

  // Helpers
  getCurrentAgent: () => Agent | undefined;
}

export const useAgentStore = create<AgentState>((set, get) => ({
  // Initial state
  agents: [],
  currentAgentId: null,
  editingAgentId: null,
  showMCPModal: false,

  // State setters
  setAgents: (agents) => set({ agents }),
  setCurrentAgentId: (id) => set({ currentAgentId: id }),

  // Agent CRUD operations
  createAgent: async (agentData) => {
    const result = await window.electron.createAgent(agentData);
    // ipcResult wraps thrown errors as { success: false, error } — without
    // this guard, a validation failure landed in `agents` as a fake row,
    // the editor's catch never fired, and the user saw a misleading
    // "Agent created" toast while nothing persisted.
    if (result && typeof result === 'object' && (result as any).success === false) {
      throw new Error((result as any).error || 'Failed to create agent');
    }
    const newAgent = result as Agent;
    set((state) => ({
      agents: [...state.agents, newAgent],
      currentAgentId: newAgent.id,
    }));
  },

  updateAgent: async (agentId, updates) => {
    const result = await window.electron.updateAgent(agentId, updates);
    if (result && typeof result === 'object' && (result as any).success === false) {
      throw new Error((result as any).error || 'Failed to update agent');
    }
    const updatedAgent = result as Agent;
    set((state) => ({
      agents: state.agents.map((a) => (a.id === agentId ? updatedAgent : a)),
    }));
  },

  deleteAgent: async (agentId) => {
    try {
      await window.electron.deleteAgent(agentId);
      set((state) => ({
        agents: state.agents.filter((a) => a.id !== agentId),
        currentAgentId: state.currentAgentId === agentId ? null : state.currentAgentId,
      }));
    } catch (error) {
      console.error('Failed to delete agent:', error);
      useToastStore.getState().showToast('Failed to delete agent', 'error');
    }
  },

  switchAgent: async (agentId) => {
    try {
      await window.electron.switchAgent(agentId);
      set({ currentAgentId: agentId });
    } catch (error) {
      console.error('Failed to switch agent:', error);
      useToastStore.getState().showToast('Failed to switch agent', 'error');
    }
  },

  // Modal management
  openMCPModal: (agentId) => set({ showMCPModal: true, editingAgentId: agentId }),
  closeMCPModal: () => set({ showMCPModal: false, editingAgentId: null }),

  // Helpers
  getCurrentAgent: () => {
    const state = get();
    return state.agents.find((a) => a.id === state.currentAgentId);
  },
}));
