import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useProjectStore } from './useProjectStore';
import { useToastStore } from './useToastStore';

function reset() {
  useProjectStore.setState({
    projects: [],
    currentProjectId: null,
    tasks: [],
    notes: [],
    events: [],
    routines: [],
    noteLabels: [],
    selectedLabelFilter: null,
    selectedColorFilter: null,
    showProjectModal: false,
    editingProject: null,
    showTaskModal: false,
    editingTask: null,
    showNoteModal: false,
    editingNote: null,
    showEventModal: false,
  });
  useToastStore.setState({ toasts: [] });
}

describe('useProjectStore', () => {
  beforeEach(reset);

  it('setters and getCurrentProject', () => {
    const projects = [{ id: 'p1', name: 'Alpha', tasks: [], notes: [] }] as any;
    useProjectStore.getState().setProjects(projects);
    useProjectStore.getState().setCurrentProjectId('p1');
    expect(useProjectStore.getState().getCurrentProject()?.name).toBe('Alpha');
  });

  it('createProject appends, selects, and creates a project channel', async () => {
    (window.electron as any).createProject = vi.fn().mockResolvedValue({
      id: 'p1',
      name: 'New',
      description: '',
    });
    (window.electron as any).createChannel = vi.fn().mockResolvedValue({});
    await useProjectStore.getState().createProject({ name: 'New', description: '' });
    expect((window.electron as any).createChannel).toHaveBeenCalledWith({
      name: 'New',
      type: 'project',
      projectId: 'p1',
    });
    expect(useProjectStore.getState().currentProjectId).toBe('p1');
    expect(useProjectStore.getState().projects).toHaveLength(1);
  });

  it('createProject toasts on failure', async () => {
    (window.electron as any).createProject = vi.fn().mockRejectedValue(new Error('boom'));
    await useProjectStore.getState().createProject({ name: 'X', description: '' });
    expect(useToastStore.getState().toasts.some((t) => t.type === 'error')).toBe(true);
  });

  it('update/delete/switch project', async () => {
    useProjectStore.setState({
      projects: [
        { id: 'p1', name: 'A', tasks: [{ id: 't1' }], notes: [{ id: 'n1' }], events: [] } as any,
        { id: 'p2', name: 'B', tasks: [], notes: [], events: [] } as any,
      ],
      currentProjectId: 'p1',
    });
    (window.electron as any).updateProject = vi.fn().mockResolvedValue({ id: 'p1', name: 'A2' });
    await useProjectStore.getState().updateProject('p1', { name: 'A2' });
    expect(useProjectStore.getState().projects[0].name).toBe('A2');

    (window.electron as any).deleteProject = vi.fn().mockResolvedValue(undefined);
    await useProjectStore.getState().deleteProject('p1');
    expect(useProjectStore.getState().projects.map((p) => p.id)).toEqual(['p2']);
    expect(useProjectStore.getState().currentProjectId).toBeNull();

    // switchProject now takes its rows from the handler, not from the
    // projects[] snapshot — see the project-scope suite below for why.
    (window.electron as any).switchProject = vi.fn().mockResolvedValue({
      success: true, tasks: [{ id: 't2' }], notes: [], events: [{ id: 'e1' }], labels: [],
    });
    (window.electron as any).getRoutines = vi.fn().mockResolvedValue([{ id: 'r1' }]);
    useProjectStore.setState({
      projects: [
        { id: 'p2', name: 'B', tasks: [], notes: [], events: [] } as any,
      ],
    });
    await useProjectStore.getState().switchProject('p2');
    expect(useProjectStore.getState().tasks).toEqual([{ id: 't2' }]);
    expect(useProjectStore.getState().events).toEqual([{ id: 'e1' }]);
    // loadRoutines is fire-and-forget; give it a tick
    await Promise.resolve();
    await Promise.resolve();
    expect(useProjectStore.getState().routines).toEqual([{ id: 'r1' }]);
  });

  it('loadRoutines clears when no project selected', async () => {
    useProjectStore.setState({ routines: [{ id: 'old' } as any], currentProjectId: null });
    await useProjectStore.getState().loadRoutines();
    expect(useProjectStore.getState().routines).toEqual([]);
  });

  it('task CRUD: add/update/toggle/delete/reorder', async () => {
    (window.electron as any).addTask = vi.fn().mockResolvedValue({ id: 't1', content: 'do' });
    await useProjectStore.getState().addTask({ content: 'do' });
    expect(useProjectStore.getState().tasks).toHaveLength(1);

    (window.electron as any).updateTask = vi.fn().mockResolvedValue({ id: 't1', content: 'done-ish' });
    await useProjectStore.getState().updateTask('t1', { content: 'done-ish' });
    expect(useProjectStore.getState().tasks[0].content).toBe('done-ish');

    (window.electron as any).toggleTask = vi.fn().mockResolvedValue({ id: 't1', completed: true });
    await useProjectStore.getState().toggleTask('t1');
    expect(useProjectStore.getState().tasks[0].completed).toBe(true);

    useProjectStore.setState({
      tasks: [
        { id: 't1', sortOrder: 1 } as any,
        { id: 't2', sortOrder: 2 } as any,
      ],
    });
    (window.electron as any).reorderTasks = vi.fn().mockResolvedValue(undefined);
    await useProjectStore.getState().reorderTasks(['t2', 't1']);
    expect(useProjectStore.getState().tasks.map((t) => t.id)).toEqual(['t2', 't1']);
    expect(useProjectStore.getState().tasks[0].sortOrder).toBe(2);

    (window.electron as any).deleteTask = vi.fn().mockResolvedValue(undefined);
    await useProjectStore.getState().deleteTask('t2');
    expect(useProjectStore.getState().tasks.map((t) => t.id)).toEqual(['t1']);
  });

  it('note CRUD + pin + AI metadata + filters', async () => {
    (window.electron as any).addNote = vi.fn().mockResolvedValue({ id: 'n1', content: 'note' });
    await useProjectStore.getState().addNote({ content: 'note' });
    expect(useProjectStore.getState().notes[0].id).toBe('n1');

    (window.electron as any).updateNote = vi.fn().mockResolvedValue({ id: 'n1', content: 'upd' });
    await useProjectStore.getState().updateNote('n1', { content: 'upd' });
    expect(useProjectStore.getState().notes[0].content).toBe('upd');

    (window.electron as any).toggleNotePin = vi.fn().mockResolvedValue({ id: 'n1', pinned: true });
    await useProjectStore.getState().toggleNotePin('n1');
    expect(useProjectStore.getState().notes[0].pinned).toBe(true);

    (window.electron as any).generateNoteMetadata = vi.fn().mockResolvedValue({
      success: true,
      note: { id: 'n1', title: 'AI title' },
    });
    await useProjectStore.getState().generateNoteAI('n1');
    expect(useProjectStore.getState().notes[0].title).toBe('AI title');

    (window.electron as any).deleteNote = vi.fn().mockResolvedValue(undefined);
    await useProjectStore.getState().deleteNote('n1');
    expect(useProjectStore.getState().notes).toHaveLength(0);

    useProjectStore.getState().setLabelFilter('work');
    useProjectStore.getState().setColorFilter('yellow' as any);
    expect(useProjectStore.getState().selectedLabelFilter).toBe('work');
  });

  it('note labels load/create/delete', async () => {
    (window.electron as any).getNoteLabels = vi.fn().mockResolvedValue([{ id: 'l1', name: 'work' }]);
    await useProjectStore.getState().loadNoteLabels();
    expect(useProjectStore.getState().noteLabels).toHaveLength(1);

    (window.electron as any).createNoteLabel = vi.fn().mockResolvedValue({ id: 'l2', name: 'ai' });
    await useProjectStore.getState().createNoteLabel('ai');
    expect(useProjectStore.getState().noteLabels).toHaveLength(2);

    (window.electron as any).deleteNoteLabel = vi.fn().mockResolvedValue(undefined);
    await useProjectStore.getState().deleteNoteLabel('l1');
    expect(useProjectStore.getState().noteLabels.map((l) => l.id)).toEqual(['l2']);
  });

  it('event CRUD and modal helpers', async () => {
    useProjectStore.setState({ currentProjectId: 'p1' });
    (window.electron as any).createEvent = vi.fn().mockResolvedValue({
      success: true,
      event: { id: 'e1', title: 'Meet', startTime: 1, endTime: 2 },
    });
    await useProjectStore.getState().addEvent({
      title: 'Meet',
      start: 1,
      end: 2,
    });
    expect(useProjectStore.getState().events).toHaveLength(1);
    expect((window.electron as any).createEvent).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: 'p1', title: 'Meet' }),
    );

    (window.electron as any).updateEvent = vi.fn().mockResolvedValue({
      success: true,
      event: { id: 'e1', title: 'Meet2', startTime: 3, endTime: 4 },
    });
    await useProjectStore.getState().updateEvent('e1', { title: 'Meet2', start: 3, end: 4 });
    expect((window.electron as any).updateEvent).toHaveBeenCalledWith(
      'e1',
      expect.objectContaining({ title: 'Meet2', startTime: 3, endTime: 4 }),
    );
    // The IPC surface speaks ScheduleEvent; the store must hold CalendarEvent.
    expect(useProjectStore.getState().events[0]).toMatchObject({
      title: 'Meet2',
      start: 3,
      end: 4,
      type: 'event',
    });

    (window.electron as any).deleteEvent = vi.fn().mockResolvedValue(undefined);
    await useProjectStore.getState().deleteEvent('e1');
    expect(useProjectStore.getState().events).toHaveLength(0);

    useProjectStore.getState().openProjectModal({ id: 'p1' } as any);
    expect(useProjectStore.getState()).toMatchObject({
      showProjectModal: true,
      editingProject: { id: 'p1' },
    });
    useProjectStore.getState().closeProjectModal();
    useProjectStore.getState().openTaskModal();
    useProjectStore.getState().closeTaskModal();
    useProjectStore.getState().openNoteModal();
    useProjectStore.getState().closeNoteModal();
    useProjectStore.getState().openEventModal();
    useProjectStore.getState().closeEventModal();
    expect(useProjectStore.getState().showEventModal).toBe(false);
  });
});

const projectA = {
  id: 'p-a', name: 'A', description: '', directory: '/tmp/a',
  tasks: [], notes: [], events: [], files: [], createdAt: 1,
} as any;
const projectB = {
  id: 'p-b', name: 'B', description: '', directory: '/tmp/b',
  tasks: [], notes: [], events: [], files: [], createdAt: 2,
} as any;

const task = (id: string) => ({ id, content: id, completed: false, projectId: 'p-a' }) as any;
const note = (id: string) => ({ id, content: id, labels: [], color: 'default' }) as any;

describe('useProjectStore project scope', () => {
  beforeEach(() => {
    useProjectStore.setState({
      projects: [structuredClone(projectA), structuredClone(projectB)],
      currentProjectId: 'p-a',
      tasks: [], notes: [], events: [], routines: [],
      noteLabels: [], selectedLabelFilter: null, selectedColorFilter: null,
    });
    (window.electron as any).switchProject = vi.fn();
    (window.electron as any).deleteProject = vi.fn().mockResolvedValue({ success: true });
    (window.electron as any).getRoutines = vi.fn().mockResolvedValue([]);
    (window.electron as any).addNote = vi.fn(async () => note('n1'));
    (window.electron as any).addTask = vi.fn(async () => task('t1'));
  });

  /**
   * The bug: switchProject rehydrated from `projects[i]`, the boot-time
   * getMemory snapshot, which no renderer-initiated write ever updated. Create
   * three notes in A, switch to B, switch back — gone. They were still in
   * SQLite; only a restart brought them back.
   */
  it('takes the switched-to project data from the handler, not the boot snapshot', async () => {
    (window.electron.switchProject as any).mockResolvedValue({
      success: true,
      tasks: [task('t-b')],
      notes: [note('n-b')],
      events: [],
      labels: [{ id: 'l-b', name: 'b-label' }],
    });

    await useProjectStore.getState().switchProject('p-b');

    const state = useProjectStore.getState();
    expect(state.currentProjectId).toBe('p-b');
    expect(state.notes.map(n => n.id)).toEqual(['n-b']);
    expect(state.tasks.map(t => t.id)).toEqual(['t-b']);
    expect(state.noteLabels.map(l => l.id)).toEqual(['l-b']);
  });

  // Filtering by a label from A leaves a filter whose id matches no note in B,
  // so B's notes view rendered empty with nothing on screen explaining why.
  it('clears note filters on switch', async () => {
    useProjectStore.setState({ selectedLabelFilter: 'label-from-a', selectedColorFilter: 'yellow' as any });
    (window.electron.switchProject as any).mockResolvedValue({ success: true, tasks: [], notes: [], events: [], labels: [] });

    await useProjectStore.getState().switchProject('p-b');

    expect(useProjectStore.getState().selectedLabelFilter).toBeNull();
    expect(useProjectStore.getState().selectedColorFilter).toBeNull();
  });

  it('leaves state alone when the switch is rejected', async () => {
    (window.electron.switchProject as any).mockResolvedValue({ success: false, error: 'Project not found' });
    useProjectStore.setState({ notes: [note('n-a')] });

    await useProjectStore.getState().switchProject('p-gone');

    expect(useProjectStore.getState().currentProjectId).toBe('p-a');
    expect(useProjectStore.getState().notes.map(n => n.id)).toEqual(['n-a']);
  });

  // ProjectCard reads project.tasks/project.notes for its badges, so a write
  // that only touched the flat array left the counts wrong until restart.
  it('mirrors writes into the project snapshot so badge counts stay honest', async () => {
    await useProjectStore.getState().addNote({ content: 'hello' });

    const snapshot = useProjectStore.getState().projects.find(p => p.id === 'p-a')!;
    expect(snapshot.notes.map(n => n.id)).toEqual(['n1']);
    expect(useProjectStore.getState().notes.map(n => n.id)).toEqual(['n1']);
    // Other projects are untouched.
    expect(useProjectStore.getState().projects.find(p => p.id === 'p-b')!.notes).toEqual([]);
  });

  it('survives a create-then-switch-away-and-back round trip', async () => {
    await useProjectStore.getState().addNote({ content: 'keep me' });
    (window.electron.switchProject as any).mockResolvedValue({ success: true, tasks: [], notes: [], events: [], labels: [] });
    await useProjectStore.getState().switchProject('p-b');

    // Coming back, the handler is the source of truth — and it reports the row
    // that was actually written.
    (window.electron.switchProject as any).mockResolvedValue({
      success: true, tasks: [], notes: [note('n1')], events: [], labels: [],
    });
    await useProjectStore.getState().switchProject('p-a');

    expect(useProjectStore.getState().notes.map(n => n.id)).toEqual(['n1']);
  });

  /**
   * deleteProject nulled currentProjectId but left tasks/notes/events/routines
   * populated. The dead project's content stayed listed and clickable, and
   * editing one hit update-note/update-task — which look the row up by id
   * globally, with no project guard.
   */
  it('clears the scope when the active project is deleted', async () => {
    useProjectStore.setState({
      tasks: [task('t1')], notes: [note('n1')],
      noteLabels: [{ id: 'l1', name: 'x' } as any], selectedLabelFilter: 'l1',
    });

    await useProjectStore.getState().deleteProject('p-a');

    const state = useProjectStore.getState();
    expect(state.currentProjectId).toBeNull();
    expect(state.tasks).toEqual([]);
    expect(state.notes).toEqual([]);
    expect(state.routines).toEqual([]);
    expect(state.noteLabels).toEqual([]);
    expect(state.selectedLabelFilter).toBeNull();
  });

  it('leaves the scope alone when a different project is deleted', async () => {
    useProjectStore.setState({ notes: [note('n1')] });

    await useProjectStore.getState().deleteProject('p-b');

    expect(useProjectStore.getState().currentProjectId).toBe('p-a');
    expect(useProjectStore.getState().notes.map(n => n.id)).toEqual(['n1']);
  });

  // Same trap as delete: a brand-new project owns nothing, so the outgoing
  // project's material must not stay on screen under the new name.
  it('clears the scope when a new project becomes active', async () => {
    useProjectStore.setState({ notes: [note('n1')], tasks: [task('t1')] });
    (window.electron as any).createProject = vi.fn(async () => structuredClone(projectB));
    (window.electron as any).createChannel = vi.fn(async () => ({ success: true }));

    await useProjectStore.getState().createProject({ name: 'B', description: '' });

    expect(useProjectStore.getState().currentProjectId).toBe('p-b');
    expect(useProjectStore.getState().notes).toEqual([]);
    expect(useProjectStore.getState().tasks).toEqual([]);
  });
});
