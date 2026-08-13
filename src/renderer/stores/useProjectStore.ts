import { create } from 'zustand';
import { Project, Task, TaskPriority, Note, NoteColor, NoteLabel, CalendarEvent, ScheduleEvent, Routine } from '@/types';
import { useToastStore } from './useToastStore';

interface CreateTaskData {
  content: string;
  color?: NoteColor;
  priority?: TaskPriority;
  labels?: string[];
  dueDate?: number;
  startDate?: number;
  estimatedDuration?: number;
  eventId?: string;
}

interface UpdateTaskData {
  content?: string;
  completed?: boolean;
  color?: NoteColor;
  priority?: TaskPriority;
  labels?: string[];
  dueDate?: number | null;
  startDate?: number | null;
  estimatedDuration?: number | null;
  eventId?: string | null;
}

interface CreateNoteData {
  content: string;
  title?: string;
  color?: NoteColor;
  pinned?: boolean;
  labels?: string[];
}

interface UpdateNoteData {
  content?: string;
  title?: string;
  color?: NoteColor;
  pinned?: boolean;
  labels?: string[];
}

interface ProjectState {
  // State
  projects: Project[];
  currentProjectId: string | null;
  tasks: Task[];
  notes: Note[];
  events: CalendarEvent[];
  routines: Routine[];

  // Note-specific state
  noteLabels: NoteLabel[];
  selectedLabelFilter: string | null;
  selectedColorFilter: NoteColor | null;

  // UI State
  showProjectModal: boolean;
  editingProject: Project | null;
  showTaskModal: boolean;
  editingTask: Task | null;
  showNoteModal: boolean;
  editingNote: Note | null;
  showEventModal: boolean;

  // Actions
  setProjects: (projects: Project[]) => void;
  setCurrentProjectId: (id: string | null) => void;
  setTasks: (tasks: Task[]) => void;
  setNotes: (notes: Note[]) => void;
  setEvents: (events: CalendarEvent[]) => void;
  setRoutines: (routines: Routine[]) => void;
  loadRoutines: () => Promise<void>;

  // Project CRUD
  createProject: (projectData: { name: string; description: string }) => Promise<void>;
  updateProject: (projectId: string, updates: { name?: string; description?: string }) => Promise<void>;
  deleteProject: (projectId: string) => Promise<void>;
  switchProject: (projectId: string) => Promise<void>;

  // Task CRUD
  addTask: (taskData: CreateTaskData) => Promise<void>;
  updateTask: (taskId: string, updates: UpdateTaskData) => Promise<void>;
  toggleTask: (taskId: string) => Promise<void>;
  deleteTask: (taskId: string) => Promise<void>;
  reorderTasks: (taskIds: string[]) => Promise<void>;

  // Note CRUD
  addNote: (noteData: CreateNoteData) => Promise<void>;
  updateNote: (noteId: string, updates: UpdateNoteData) => Promise<void>;
  toggleNotePin: (noteId: string) => Promise<void>;
  deleteNote: (noteId: string) => Promise<void>;
  generateNoteAI: (noteId: string) => Promise<void>;
  reorderNotes: (noteIds: string[]) => Promise<void>;

  // Note Labels
  loadNoteLabels: () => Promise<void>;
  createNoteLabel: (name: string, color?: string) => Promise<void>;
  deleteNoteLabel: (labelId: string) => Promise<void>;

  // Note Filters
  setLabelFilter: (label: string | null) => void;
  setColorFilter: (color: NoteColor | null) => void;

  // Event CRUD
  addEvent: (eventData: { title: string; description?: string; start: number; end: number }) => Promise<void>;
  updateEvent: (eventId: string, updates: Partial<CalendarEvent>) => Promise<void>;
  deleteEvent: (eventId: string) => Promise<void>;

  // Modal Management
  openProjectModal: (project?: Project) => void;
  closeProjectModal: () => void;
  openTaskModal: (task?: Task) => void;
  closeTaskModal: () => void;
  openNoteModal: (note?: Note) => void;
  closeNoteModal: () => void;
  openEventModal: () => void;
  closeEventModal: () => void;

  // Helpers
  getCurrentProject: () => Project | undefined;
}

// The events IPC surface speaks ScheduleEvent (startTime/endTime); the store and
// CalendarView speak CalendarEvent (start/end/type). Mirrors the projection in
// ProjectRepository.getEventsByProjectId, which is what the boot path returns.
function toCalendarEvent(
  event: ScheduleEvent,
  type: CalendarEvent['type'] = 'event'
): CalendarEvent {
  return {
    id: event.id,
    projectId: event.projectId,
    title: event.title,
    description: event.description,
    start: event.startTime,
    end: event.endTime ?? 0,
    type,
    createdAt: event.createdAt,
  };
}

type ScopedKey = 'tasks' | 'notes' | 'events';

/**
 * Mirror the live arrays back into `projects[i]`.
 *
 * `projects` doubles as a per-project cache — ProjectCard reads
 * `project.tasks` / `project.notes` for its badge counts — but every CRUD
 * action touched only the flat arrays, so the two drifted apart the moment the
 * user added anything, and `switchProject` then rehydrated from the stale
 * half. Keeping them in step is what makes the snapshot safe to read: it was
 * the divergence, not the duplication, that lost data.
 */
function mergeProjectSnapshot(
  projects: Project[],
  projectId: string | null,
  patch: Partial<Pick<Project, ScopedKey>>,
): Project[] {
  if (!projectId) return projects;
  return projects.map((p) => (p.id === projectId ? { ...p, ...patch } : p));
}

/**
 * Everything that belongs to the active project, blanked. Used wherever the
 * active project goes away — deleted, or replaced by a brand-new one — so no
 * surface keeps rendering material the current scope does not own.
 */
function emptyProjectScope() {
  return {
    tasks: [] as Task[],
    notes: [] as Note[],
    events: [] as CalendarEvent[],
    routines: [] as Routine[],
    noteLabels: [] as NoteLabel[],
    selectedLabelFilter: null,
    selectedColorFilter: null,
  };
}

/** Write one scoped collection to both the live array and the snapshot. */
function applyScoped<K extends ScopedKey>(
  state: ProjectState,
  key: K,
  value: ProjectState[K],
): Pick<ProjectState, K | 'projects'> {
  return {
    [key]: value,
    projects: mergeProjectSnapshot(state.projects, state.currentProjectId, { [key]: value }),
  } as Pick<ProjectState, K | 'projects'>;
}

export const useProjectStore = create<ProjectState>((set, get) => ({
  // Initial state
  projects: [],
  currentProjectId: null,
  tasks: [],
  notes: [],
  events: [],
  routines: [],

  // Note-specific state
  noteLabels: [],
  selectedLabelFilter: null,
  selectedColorFilter: null,

  // UI State
  showProjectModal: false,
  editingProject: null,
  showTaskModal: false,
  editingTask: null,
  showNoteModal: false,
  editingNote: null,
  showEventModal: false,

  // State setters
  setProjects: (projects) => set({ projects }),
  setCurrentProjectId: (id) => set({ currentProjectId: id }),
  setTasks: (tasks) => set({ tasks }),
  setNotes: (notes) => set({ notes }),
  setEvents: (events) => set({ events }),
  setRoutines: (routines) => set({ routines }),

  loadRoutines: async () => {
    const { currentProjectId } = get();
    if (!currentProjectId) {
      set({ routines: [] });
      return;
    }
    try {
      const routines = await window.electron.getRoutines(currentProjectId);
      set({ routines: routines || [] });
    } catch (error) {
      console.error('Failed to load routines:', error);
      set({ routines: [] });
    }
  },

  // Project CRUD operations
  createProject: async (projectData) => {
    try {
      const project = await window.electron.createProject(projectData);

      // Automatically create a project channel
      await window.electron.createChannel({
        name: project.name,
        type: 'project',
        projectId: project.id,
      });

      // A brand-new project owns nothing, so clear the outgoing project's
      // material rather than leaving it on screen under the new name — the
      // same trap deleteProject fell into.
      set((state) => ({
        projects: [...state.projects, project],
        currentProjectId: project.id,
        ...emptyProjectScope(),
      }));
    } catch (error) {
      console.error('Failed to create project:', error);
      useToastStore.getState().showToast('Failed to create project', 'error');
    }
  },

  updateProject: async (projectId, updates) => {
    try {
      const updatedProject = await window.electron.updateProject(projectId, updates);
      set((state) => ({
        projects: state.projects.map((p) => (p.id === projectId ? updatedProject : p)),
      }));
    } catch (error) {
      console.error('Failed to update project:', error);
      useToastStore.getState().showToast('Failed to update project', 'error');
    }
  },

  deleteProject: async (projectId) => {
    try {
      await window.electron.deleteProject(projectId);
      set((state) => {
        const wasActive = state.currentProjectId === projectId;
        return {
          projects: state.projects.filter((p) => p.id !== projectId),
          currentProjectId: wasActive ? null : state.currentProjectId,
          // Nulling currentProjectId alone left the dead project's tasks,
          // notes, events and routines listed and clickable. Editing one hit
          // update-note / update-task, which look the row up by id globally
          // with no project guard — so the write went through against a
          // project that no longer exists.
          ...(wasActive ? emptyProjectScope() : {}),
        };
      });
    } catch (error) {
      console.error('Failed to delete project:', error);
      useToastStore.getState().showToast('Failed to delete project', 'error');
    }
  },

  switchProject: async (projectId) => {
    try {
      // Take the rows the handler returns rather than re-reading
      // `projects[i]`. That array is the boot-time getMemory snapshot and no
      // renderer-initiated write ever updates it, so rehydrating from it threw
      // away everything created this session and resurrected everything
      // deleted. (`project-data-changed` doesn't save it either — only agent
      // tools and plugins emit it, never ipc/notes.ts or ipc/tasks.ts, so a
      // human-driven session never triggers a reload.)
      const result = await window.electron.switchProject(projectId);
      if (!result?.success) {
        useToastStore.getState().showToast(result?.error || 'Failed to switch project', 'error');
        return;
      }

      const tasks = result.tasks ?? [];
      const notes = result.notes ?? [];
      const events = result.events ?? [];

      set((state) => ({
        currentProjectId: projectId,
        tasks,
        notes,
        events,
        // Labels are project-scoped in storage but the renderer keeps one
        // global bucket that nothing reloaded on switch. The stale filters are
        // worse than the stale chips: a label id from A matches no note in B,
        // so B's notes view rendered empty with nothing explaining why.
        noteLabels: result.labels ?? [],
        selectedLabelFilter: null,
        selectedColorFilter: null,
        projects: mergeProjectSnapshot(state.projects, projectId, { tasks, notes, events }),
      }));
      // Load routines for the new project
      get().loadRoutines();
    } catch (error) {
      console.error('Failed to switch project:', error);
      useToastStore.getState().showToast('Failed to switch project', 'error');
    }
  },

  // Task CRUD operations
  addTask: async (taskData) => {
    try {
      const task = await window.electron.addTask(taskData);
      set((state) => applyScoped(state, 'tasks', [...state.tasks, task]));
    } catch (error) {
      console.error('Failed to add task:', error);
      useToastStore.getState().showToast('Failed to add task', 'error');
    }
  },

  updateTask: async (taskId, updates) => {
    try {
      const updatedTask = await window.electron.updateTask(taskId, updates);
      set((state) => applyScoped(state, 'tasks', state.tasks.map((t) => (t.id === taskId ? updatedTask : t))));
    } catch (error) {
      console.error('Failed to update task:', error);
      useToastStore.getState().showToast('Failed to update task', 'error');
    }
  },

  toggleTask: async (taskId) => {
    try {
      const updatedTask = await window.electron.toggleTask(taskId);
      set((state) => applyScoped(state, 'tasks', state.tasks.map((t) => (t.id === taskId ? updatedTask : t))));
    } catch (error) {
      console.error('Failed to toggle task:', error);
      useToastStore.getState().showToast('Failed to update task', 'error');
    }
  },

  deleteTask: async (taskId) => {
    try {
      await window.electron.deleteTask(taskId);
      set((state) => applyScoped(state, 'tasks', state.tasks.filter((t) => t.id !== taskId)));
    } catch (error) {
      console.error('Failed to delete task:', error);
      useToastStore.getState().showToast('Failed to delete task', 'error');
    }
  },

  reorderTasks: async (taskIds) => {
    try {
      // Build orders array with new sortOrder values (higher = more recent / first)
      const orders = taskIds.map((id, index) => ({
        id,
        sortOrder: taskIds.length - index, // Reverse so first in array = highest sortOrder
      }));

      await window.electron.reorderTasks(orders);

      // Optimistically update local state
      set((state) => {
        const taskMap = new Map(state.tasks.map((t) => [t.id, t]));
        const reorderedTasks = taskIds.map((id, index) => {
          const task = taskMap.get(id);
          return task ? { ...task, sortOrder: taskIds.length - index } : null;
        }).filter(Boolean) as typeof state.tasks;

        // Keep any tasks not in the reorder list (shouldn't happen, but safety)
        const remainingTasks = state.tasks.filter((t) => !taskIds.includes(t.id));

        return applyScoped(state, 'tasks', [...reorderedTasks, ...remainingTasks]);
      });
    } catch (error) {
      console.error('Failed to reorder tasks:', error);
      useToastStore.getState().showToast('Failed to reorder tasks', 'error');
    }
  },

  // Note CRUD operations
  addNote: async (noteData) => {
    try {
      const note = await window.electron.addNote(noteData);
      // Newest first.
      set((state) => applyScoped(state, 'notes', [note, ...state.notes]));
    } catch (error) {
      console.error('Failed to add note:', error);
      useToastStore.getState().showToast('Failed to add note', 'error');
    }
  },

  updateNote: async (noteId, updates) => {
    try {
      const updatedNote = await window.electron.updateNote(noteId, updates);
      set((state) => applyScoped(state, 'notes', state.notes.map((n) => (n.id === noteId ? updatedNote : n))));
    } catch (error) {
      console.error('Failed to update note:', error);
      useToastStore.getState().showToast('Failed to update note', 'error');
    }
  },

  toggleNotePin: async (noteId) => {
    try {
      const updatedNote = await window.electron.toggleNotePin(noteId);
      set((state) => applyScoped(state, 'notes', state.notes.map((n) => (n.id === noteId ? updatedNote : n))));
    } catch (error) {
      console.error('Failed to toggle note pin:', error);
      useToastStore.getState().showToast('Failed to update note', 'error');
    }
  },

  deleteNote: async (noteId) => {
    try {
      await window.electron.deleteNote(noteId);
      set((state) => applyScoped(state, 'notes', state.notes.filter((n) => n.id !== noteId)));
    } catch (error) {
      console.error('Failed to delete note:', error);
      useToastStore.getState().showToast('Failed to delete note', 'error');
    }
  },

  generateNoteAI: async (noteId) => {
    try {
      const result = await window.electron.generateNoteMetadata(noteId);
      if (result.success && result.note) {
        const updatedNote = result.note;
        set((state) => applyScoped(state, 'notes', state.notes.map((n) => (n.id === noteId ? updatedNote : n))));
      }
    } catch (error) {
      console.error('Failed to generate note metadata:', error);
      useToastStore.getState().showToast('Failed to generate note metadata', 'error');
    }
  },

  reorderNotes: async (noteIds) => {
    try {
      // Build orders array with new sortOrder values (higher = more recent / first)
      const orders = noteIds.map((id, index) => ({
        id,
        sortOrder: noteIds.length - index, // Reverse so first in array = highest sortOrder
      }));

      await window.electron.reorderNotes(orders);

      // Optimistically update local state
      set((state) => {
        const noteMap = new Map(state.notes.map((n) => [n.id, n]));
        const reorderedNotes = noteIds.map((id, index) => {
          const note = noteMap.get(id);
          return note ? { ...note, sortOrder: noteIds.length - index } : null;
        }).filter(Boolean) as typeof state.notes;

        // Keep any notes not in the reorder list (shouldn't happen, but safety)
        const remainingNotes = state.notes.filter((n) => !noteIds.includes(n.id));

        return applyScoped(state, 'notes', [...reorderedNotes, ...remainingNotes]);
      });
    } catch (error) {
      console.error('Failed to reorder notes:', error);
      useToastStore.getState().showToast('Failed to reorder notes', 'error');
    }
  },

  // Note Labels
  loadNoteLabels: async () => {
    try {
      const labels = await window.electron.getNoteLabels();
      set({ noteLabels: labels });
    } catch (error) {
      console.error('Failed to load note labels:', error);
    }
  },

  createNoteLabel: async (name, color) => {
    try {
      const label = await window.electron.createNoteLabel({ name, color });
      set((state) => ({
        noteLabels: [...state.noteLabels, label],
      }));
    } catch (error) {
      console.error('Failed to create note label:', error);
      useToastStore.getState().showToast('Failed to create label', 'error');
    }
  },

  deleteNoteLabel: async (labelId) => {
    try {
      await window.electron.deleteNoteLabel(labelId);
      set((state) => ({
        noteLabels: state.noteLabels.filter((l) => l.id !== labelId),
      }));
    } catch (error) {
      console.error('Failed to delete note label:', error);
      useToastStore.getState().showToast('Failed to delete label', 'error');
    }
  },

  // Note Filters
  setLabelFilter: (label) => set({ selectedLabelFilter: label }),
  setColorFilter: (color) => set({ selectedColorFilter: color }),

  // There is no loadFilteredNotes. It had zero call sites — NotesView filters
  // `notes` client-side — and it replaced the store's note list with a
  // *filtered subset* that every other reader would then treat as the whole
  // set. Left in place it was a loaded gun; the server-side filter it wrapped
  // is still reachable via window.electron.listNotes, which global search uses.

  // Event CRUD operations
  addEvent: async (eventData) => {
    try {
      const { currentProjectId } = get();
      const result = await window.electron.createEvent({
        projectId: currentProjectId || '',
        title: eventData.title,
        description: eventData.description,
        startTime: eventData.start,
        endTime: eventData.end,
        isAllDay: false,
      });
      if (!result.success || !result.event) {
        useToastStore.getState().showToast(result.error || 'Failed to create event', 'error');
        return;
      }
      // Always 'event': EventRepository.create hard-writes that column, and
      // milestones/deadlines are created through their own repositories. The
      // store used to carry the modal's chosen subtype here, so the calendar
      // showed it until a reload replaced it with the truth.
      const event = toCalendarEvent(result.event, 'event');
      set((state) => applyScoped(state, 'events', [...state.events, event]));
    } catch (error) {
      console.error('Failed to create event:', error);
      useToastStore.getState().showToast('Failed to create event', 'error');
    }
  },

  updateEvent: async (eventId, updates) => {
    try {
      const result = await window.electron.updateEvent(eventId, {
        ...(updates.title !== undefined && { title: updates.title }),
        ...(updates.description !== undefined && { description: updates.description }),
        ...(updates.start !== undefined && { startTime: updates.start }),
        ...(updates.end !== undefined && { endTime: updates.end }),
      });
      if (!result.success || !result.event) {
        useToastStore.getState().showToast(result.error || 'Failed to update event', 'error');
        return;
      }
      const event = result.event;
      // `type` is not part of the events IPC surface — the repository hard-writes
      // 'event' — so carry the store's existing value rather than resetting it.
      set((state) => applyScoped(state, 'events', state.events.map((e) =>
        e.id === eventId ? toCalendarEvent(event, e.type) : e
      )));
    } catch (error) {
      console.error('Failed to update event:', error);
      useToastStore.getState().showToast('Failed to update event', 'error');
    }
  },

  deleteEvent: async (eventId) => {
    try {
      await window.electron.deleteEvent(eventId);
      set((state) => applyScoped(state, 'events', state.events.filter((e) => e.id !== eventId)));
    } catch (error) {
      console.error('Failed to delete event:', error);
      useToastStore.getState().showToast('Failed to delete event', 'error');
    }
  },

  // Modal management
  openProjectModal: (project) => set({ showProjectModal: true, editingProject: project || null }),
  closeProjectModal: () => set({ showProjectModal: false, editingProject: null }),
  openTaskModal: (task) => set({ showTaskModal: true, editingTask: task || null }),
  closeTaskModal: () => set({ showTaskModal: false, editingTask: null }),
  openNoteModal: (note) => set({ showNoteModal: true, editingNote: note || null }),
  closeNoteModal: () => set({ showNoteModal: false, editingNote: null }),
  openEventModal: () => set({ showEventModal: true }),
  closeEventModal: () => set({ showEventModal: false }),

  // Helpers
  getCurrentProject: () => {
    const state = get();
    return state.projects.find((p) => p.id === state.currentProjectId);
  },
}));
