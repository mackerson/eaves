import Database from 'better-sqlite3';
import { randomUUID, createHash } from 'crypto';
import { Project, Task, TaskPriority, Note, NoteColor, NoteAIMetadata, NoteLabel, CalendarEvent } from '../types';
import { getDatabase } from '../services/database';
import { safeJsonParse, safeJsonParseOptional } from '../utils/safeJson';
import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';
import { ProjectRow, TaskRow, NoteRow, NoteLabelRow, EventRow } from './row-types';
import { buildUpdateFields } from '../utils/buildUpdateFields';
import { logger } from '../services/logger';

const MAX_PROJECT_NAME_LENGTH = 100;
const MAX_PROJECT_DESCRIPTION_LENGTH = 2000;
const MAX_TASK_LENGTH = 500;
const MAX_NOTE_LENGTH = 10000;

export class ProjectRepository {
  private db: Database.Database;

  /**
   * @param db Injected for tests and the seed loader; production callers use
   * the singletons in ./index.ts and get the app database.
   */
  constructor(db?: Database.Database) {
    this.db = db ?? getDatabase();
    this.migrateProjectDirectories();
  }

  /**
   * One-time migration: ensure all projects have a directory.
   * Called at construction so getAll/getById stay side-effect-free.
   */
  private migrateProjectDirectories(): void {
    const rows = this.db.prepare('SELECT id, name FROM projects WHERE directory IS NULL').all() as Pick<ProjectRow, 'id' | 'name'>[];
    for (const row of rows) {
      const directory = this.createProjectDirectory(row.name, row.id);
      this.db.prepare('UPDATE projects SET directory = ? WHERE id = ?').run(directory, row.id);
    }
  }

  private mapRowToProject(row: ProjectRow): Project {
    return {
      id: row.id,
      name: row.name,
      description: row.description ?? '',
      directory: row.directory!,
      tasks: this.getTasksByProjectId(row.id),
      notes: this.getNotesByProjectId(row.id),
      events: this.getEventsByProjectId(row.id),
      files: safeJsonParse(row.files, [], `project:${row.id}:files`),
      createdAt: row.created_at,
    };
  }

  getAll(): Project[] {
    const rows = this.db.prepare('SELECT * FROM projects ORDER BY created_at DESC').all() as ProjectRow[];
    return rows.map(row => this.mapRowToProject(row));
  }

  getById(id: string): Project | null {
    const row = this.db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as ProjectRow | undefined;
    if (!row) return null;
    return this.mapRowToProject(row);
  }

  create(project: { name: string; description: string }): Project {
    const name = project.name.trim();
    const description = project.description?.trim() ?? '';

    if (!name) {
      throw new Error('Project name cannot be empty');
    }

    const sanitizedName = name.slice(0, MAX_PROJECT_NAME_LENGTH);
    const sanitizedDescription = description.slice(0, MAX_PROJECT_DESCRIPTION_LENGTH);

    const id = randomUUID();
    const createdAt = Date.now();

    // Create project directory
    const directory = this.createProjectDirectory(sanitizedName, id);

    this.db.prepare(`
      INSERT INTO projects (id, name, description, directory, files, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, sanitizedName, sanitizedDescription, directory, JSON.stringify([]), createdAt);

    return {
      id,
      name: sanitizedName,
      description: sanitizedDescription,
      directory,
      tasks: [],
      notes: [],
      events: [],
      files: [],
      createdAt,
    };
  }

  /**
   * Create a filesystem directory for a project
   * Returns the absolute path to the created directory
   */
  private createProjectDirectory(projectName: string, projectId: string): string {
    // Get base projects directory from userData
    const baseDir = path.join(app.getPath('userData'), 'projects');

    // Ensure base projects directory exists
    if (!fs.existsSync(baseDir)) {
      fs.mkdirSync(baseDir, { recursive: true });
    }

    // Sanitize project name for filesystem (remove special chars, limit length)
    const safeName = projectName
      .toLowerCase()
      .replace(/[^a-z0-9-_\s]/g, '') // Remove special chars
      .replace(/\s+/g, '-')           // Replace spaces with hyphens
      .slice(0, 50);                  // Limit length

    // Short digest of the id, not a prefix of it, for the uniqueness suffix.
    // Ids are `randomUUID()` today but older rows use `project-<timestamp>`,
    // whose first 8 characters are the constant "project-" — so every legacy
    // project of a given name resolved to the same directory, and mkdirSync's
    // `recursive` flag made the collision silent. Hashing is scheme-agnostic.
    const suffix = createHash('sha256').update(projectId).digest('hex').slice(0, 8);
    const dirName = `${safeName}-${suffix}`;
    const projectDir = path.join(baseDir, dirName);

    // Create project directory
    fs.mkdirSync(projectDir, { recursive: true });

    // Create .claude subdirectory for context files
    const claudeDir = path.join(projectDir, '.claude');
    fs.mkdirSync(claudeDir, { recursive: true });

    return projectDir;
  }

  update(id: string, updates: { name?: string; description?: string }): Project | null {
    // Preprocess with validation and sanitization
    const processed: Record<string, unknown> = {};
    if (updates.name !== undefined) {
      const trimmedName = updates.name.trim();
      if (!trimmedName) {
        throw new Error('Project name cannot be empty');
      }
      processed.name = trimmedName.slice(0, MAX_PROJECT_NAME_LENGTH);
    }
    if (updates.description !== undefined) {
      processed.description = updates.description.trim().slice(0, MAX_PROJECT_DESCRIPTION_LENGTH);
    }

    const { clauses, params } = buildUpdateFields(processed, {
      name: 'name',
      description: 'description',
    });

    if (clauses.length === 0) {
      return this.getById(id);
    }

    params.push(id);
    this.db.prepare(`UPDATE projects SET ${clauses.join(', ')} WHERE id = ?`).run(...params);

    return this.getById(id);
  }

  /**
   * Delete a project by ID
   * Returns true if deleted, false if not found
   */
  delete(id: string): boolean {
    const result = this.db.prepare('DELETE FROM projects WHERE id = ?').run(id);
    return result.changes > 0;
  }

  // Task operations for projects

  /**
   * Map a database row to a Task object
   */
  private mapRowToTask(row: TaskRow): Task {
    return {
      id: row.id,
      projectId: row.project_id,
      content: row.content,
      completed: row.completed === 1,
      color: (row.color as NoteColor) || 'default',
      priority: (row.priority as TaskPriority) || 'medium',
      labels: safeJsonParse(row.labels, [], `task:${row.id}:labels`),
      sortOrder: row.sort_order || 0,
      dueDate: row.due_date || undefined,
      startDate: row.start_date || undefined,
      estimatedDuration: row.estimated_duration || undefined,
      eventId: row.event_id || undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at || row.created_at,
    };
  }

  /**
   * Get all tasks for a specific project
   * Sorted by completed (incomplete first), then priority, then sortOrder
   */
  private getTasksByProjectId(projectId: string): Task[] {
    const rows = this.db.prepare(`
      SELECT * FROM tasks
      WHERE project_id = ?
      ORDER BY completed ASC,
        CASE priority
          WHEN 'high' THEN 1
          WHEN 'medium' THEN 2
          WHEN 'low' THEN 3
          ELSE 2
        END,
        sort_order DESC
    `).all(projectId) as TaskRow[];

    return rows.map(row => this.mapRowToTask(row));
  }

  /**
   * Get a single task by ID
   */
  getTaskById(taskId: string): Task | null {
    const row = this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as TaskRow | undefined;
    if (!row) return null;
    return this.mapRowToTask(row);
  }

  createTask(projectId: string, taskData: {
    content: string;
    color?: NoteColor;
    priority?: TaskPriority;
    labels?: string[];
    dueDate?: number;
    startDate?: number;
    estimatedDuration?: number;
    eventId?: string;
  }): Task {
    const data = taskData;

    const trimmedContent = data.content.trim();
    if (!trimmedContent) {
      throw new Error('Task content cannot be empty');
    }
    const sanitizedContent = trimmedContent.slice(0, MAX_TASK_LENGTH);

    const id = randomUUID();
    const now = Date.now();

    // Get max sortOrder for this project and add 1
    const maxOrder = this.db.prepare(`
      SELECT COALESCE(MAX(sort_order), 0) as max_order FROM tasks WHERE project_id = ?
    `).get(projectId) as { max_order: number };
    const sortOrder = maxOrder.max_order + 1;

    this.db.prepare(`
      INSERT INTO tasks (id, project_id, content, completed, color, priority, labels, sort_order, due_date, start_date, estimated_duration, event_id, created_at, updated_at)
      VALUES (?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      projectId,
      sanitizedContent,
      data.color || 'default',
      data.priority || 'medium',
      data.labels ? JSON.stringify(data.labels) : null,
      sortOrder,
      data.dueDate || null,
      data.startDate || null,
      data.estimatedDuration || null,
      data.eventId || null,
      now,
      now
    );

    return {
      id,
      content: sanitizedContent,
      completed: false,
      color: data.color || 'default',
      priority: data.priority || 'medium',
      labels: data.labels || [],
      sortOrder,
      dueDate: data.dueDate,
      startDate: data.startDate,
      estimatedDuration: data.estimatedDuration,
      eventId: data.eventId,
      createdAt: now,
      updatedAt: now,
    };
  }

  updateTask(taskId: string, updates: {
    content?: string;
    completed?: boolean;
    color?: NoteColor;
    priority?: TaskPriority;
    labels?: string[];
    dueDate?: number | null;
    startDate?: number | null;
    estimatedDuration?: number | null;
    eventId?: string | null;
  }): Task | null {
    const existing = this.getTaskById(taskId);
    if (!existing) return null;

    // Preprocess content with validation
    let processedContent: string | undefined;
    if (updates.content !== undefined) {
      const trimmedContent = updates.content.trim();
      if (!trimmedContent) {
        throw new Error('Task content cannot be empty');
      }
      processedContent = trimmedContent.slice(0, MAX_TASK_LENGTH);
    }

    const { clauses, params } = buildUpdateFields(
      { ...updates, content: processedContent },
      {
        content: 'content',
        completed: { column: 'completed', transform: 'boolInt' },
        color: 'color',
        priority: 'priority',
        labels: { column: 'labels', transform: 'json' },
        dueDate: 'due_date',
        startDate: 'start_date',
        estimatedDuration: 'estimated_duration',
        eventId: 'event_id',
      }
    );

    if (clauses.length === 0) {
      return this.getTaskById(taskId);
    }

    clauses.push('updated_at = ?');
    params.push(Date.now());

    params.push(taskId);
    this.db.prepare(`UPDATE tasks SET ${clauses.join(', ')} WHERE id = ?`).run(...params);

    return this.getTaskById(taskId);
  }

  toggleTask(taskId: string): Task | null {
    const task = this.getTaskById(taskId);
    if (!task) return null;

    const newCompleted = !task.completed;
    const now = Date.now();

    this.db.prepare('UPDATE tasks SET completed = ?, updated_at = ? WHERE id = ?')
      .run(newCompleted ? 1 : 0, now, taskId);

    return this.getTaskById(taskId);
  }

  /**
   * Delete a task
   * Returns true if deleted, false if not found
   */
  deleteTask(taskId: string): boolean {
    const result = this.db.prepare('DELETE FROM tasks WHERE id = ?').run(taskId);
    return result.changes > 0;
  }

  /**
   * Reorder tasks by updating their sortOrder values
   * Takes an array of {id, sortOrder} pairs
   */
  reorderTasks(orders: { id: string; sortOrder: number }[]): boolean {
    const updateStmt = this.db.prepare('UPDATE tasks SET sort_order = ? WHERE id = ?');

    const transaction = this.db.transaction(() => {
      for (const { id, sortOrder } of orders) {
        updateStmt.run(sortOrder, id);
      }
    });

    try {
      transaction();
      return true;
    } catch (error) {
      logger.error('[ProjectRepository] Failed to reorder tasks:', error);
      return false;
    }
  }

  // Note operations for projects

  /**
   * Map a database row to a Note object
   */
  private mapRowToNote(row: NoteRow): Note {
    return {
      id: row.id,
      content: row.content,
      title: row.title || undefined,
      color: (row.color as NoteColor) || 'default',
      pinned: row.pinned === 1,
      labels: safeJsonParse(row.labels, [], `note:${row.id}:labels`),
      sortOrder: row.sort_order || 0,
      eventId: row.event_id || undefined,
      aiMetadata: safeJsonParseOptional(row.ai_metadata, `note:${row.id}:aiMetadata`),
      createdAt: row.created_at,
      updatedAt: row.updated_at || row.created_at,
    };
  }

  /**
   * Get all notes for a specific project
   * Sorted by pinned (descending), then by sort_order (descending)
   */
  private getNotesByProjectId(projectId: string): Note[] {
    const rows = this.db.prepare(`
      SELECT * FROM notes
      WHERE project_id = ?
      ORDER BY pinned DESC, sort_order DESC
    `).all(projectId) as NoteRow[];

    return rows.map(row => this.mapRowToNote(row));
  }

  /**
   * Get a single note by ID
   */
  getNoteById(noteId: string): Note | null {
    const row = this.db.prepare('SELECT * FROM notes WHERE id = ?').get(noteId) as NoteRow | undefined;
    if (!row) return null;
    return this.mapRowToNote(row);
  }

  createNote(projectId: string, noteData: {
    content: string;
    title?: string;
    color?: NoteColor;
    pinned?: boolean;
    labels?: string[];
  }): Note {
    const data = noteData;

    const trimmedContent = data.content.trim();
    if (!trimmedContent) {
      throw new Error('Note content cannot be empty');
    }
    const sanitizedContent = trimmedContent.slice(0, MAX_NOTE_LENGTH);
    const title = data.title?.trim().slice(0, 200) || null;

    const id = randomUUID();
    const now = Date.now();

    // Get max sortOrder for this project and add 1
    const maxOrder = this.db.prepare(`
      SELECT COALESCE(MAX(sort_order), 0) as max_order FROM notes WHERE project_id = ?
    `).get(projectId) as { max_order: number };
    const sortOrder = maxOrder.max_order + 1;

    this.db.prepare(`
      INSERT INTO notes (id, project_id, content, title, color, pinned, labels, sort_order, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      projectId,
      sanitizedContent,
      title,
      data.color || 'default',
      data.pinned ? 1 : 0,
      data.labels ? JSON.stringify(data.labels) : null,
      sortOrder,
      now,
      now
    );

    return {
      id,
      content: sanitizedContent,
      title: title || undefined,
      color: data.color || 'default',
      pinned: data.pinned || false,
      labels: data.labels || [],
      sortOrder,
      createdAt: now,
      updatedAt: now,
    };
  }

  updateNote(noteId: string, updates: {
    content?: string;
    title?: string;
    color?: NoteColor;
    pinned?: boolean;
    labels?: string[];
    aiMetadata?: NoteAIMetadata;
  }): Note | null {
    const existing = this.getNoteById(noteId);
    if (!existing) return null;

    // Preprocess content/title with validation
    let processedContent: string | undefined;
    if (updates.content !== undefined) {
      const trimmedContent = updates.content.trim();
      if (!trimmedContent) {
        throw new Error('Note content cannot be empty');
      }
      processedContent = trimmedContent.slice(0, MAX_NOTE_LENGTH);
    }
    const processedTitle = updates.title !== undefined
      ? (updates.title?.trim().slice(0, 200) || null)
      : undefined;

    const { clauses, params } = buildUpdateFields(
      { ...updates, content: processedContent, title: processedTitle },
      {
        content: 'content',
        title: 'title',
        color: 'color',
        pinned: { column: 'pinned', transform: 'boolInt' },
        labels: { column: 'labels', transform: 'json' },
        aiMetadata: { column: 'ai_metadata', transform: 'json' },
      }
    );

    if (clauses.length === 0) {
      return this.getNoteById(noteId);
    }

    clauses.push('updated_at = ?');
    params.push(Date.now());

    params.push(noteId);
    this.db.prepare(`UPDATE notes SET ${clauses.join(', ')} WHERE id = ?`).run(...params);

    return this.getNoteById(noteId);
  }

  toggleNotePin(noteId: string): Note | null {
    const row = this.db.prepare('SELECT pinned FROM notes WHERE id = ?').get(noteId) as Pick<NoteRow, 'pinned'> | undefined;
    if (!row) return null;

    const newPinned = row.pinned === 1 ? 0 : 1;
    this.db.prepare('UPDATE notes SET pinned = ?, updated_at = ? WHERE id = ?')
      .run(newPinned, Date.now(), noteId);

    return this.getNoteById(noteId);
  }

  /**
   * Delete a note
   * Returns true if deleted, false if not found
   */
  deleteNote(noteId: string): boolean {
    const result = this.db.prepare('DELETE FROM notes WHERE id = ?').run(noteId);
    return result.changes > 0;
  }

  /**
   * Reorder notes by updating their sortOrder values
   * Takes an array of {id, sortOrder} pairs
   */
  reorderNotes(orders: { id: string; sortOrder: number }[]): boolean {
    const updateStmt = this.db.prepare('UPDATE notes SET sort_order = ? WHERE id = ?');

    const transaction = this.db.transaction(() => {
      for (const { id, sortOrder } of orders) {
        updateStmt.run(sortOrder, id);
      }
    });

    try {
      transaction();
      return true;
    } catch (error) {
      logger.error('[ProjectRepository] Failed to reorder notes:', error);
      return false;
    }
  }

  // Note Label operations

  /**
   * Get all labels for a project
   */
  getLabelsByProjectId(projectId: string): NoteLabel[] {
    const rows = this.db.prepare(`
      SELECT * FROM note_labels
      WHERE project_id = ?
      ORDER BY name ASC
    `).all(projectId) as NoteLabelRow[];

    return rows.map(row => ({
      id: row.id,
      name: row.name,
      color: row.color || 'default',
    }));
  }

  createLabel(projectId: string, name: string, color?: string): NoteLabel {
    const id = randomUUID();
    const now = Date.now();
    const trimmedName = name.trim().slice(0, 50);

    this.db.prepare(`
      INSERT OR IGNORE INTO note_labels (id, project_id, name, color, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(id, projectId, trimmedName, color || 'default', now);

    return { id, name: trimmedName, color: color || 'default' };
  }

  /**
   * Delete a label
   */
  deleteLabel(labelId: string): boolean {
    const result = this.db.prepare('DELETE FROM note_labels WHERE id = ?').run(labelId);
    return result.changes > 0;
  }

  // Event operations for projects

  /**
   * Get all events for a specific project
   */
  private getEventsByProjectId(projectId: string): CalendarEvent[] {
    const rows = this.db.prepare('SELECT * FROM events WHERE project_id = ? ORDER BY start_time ASC').all(projectId) as EventRow[];

    return rows.map(row => ({
      id: row.id,
      title: row.title,
      description: row.description || undefined,
      start: row.start_time,
      end: row.end_time ?? 0,
      type: (row.type || 'event') as CalendarEvent['type'],
      projectId: row.project_id,
      createdAt: row.created_at,
    }));
  }

}
