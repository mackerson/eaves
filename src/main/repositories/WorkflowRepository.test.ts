import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { WorkflowRepository } from './WorkflowRepository';
import { runMigrations } from '../services/migrations';

// Mock the logger to avoid Electron app dependency
vi.mock('../services/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

// Mock the database service
vi.mock('../services/database', () => {
  let mockDb: Database.Database | null = null;

  return {
    getDatabase: vi.fn(() => {
      if (!mockDb) {
        mockDb = new Database(':memory:');
        // Run the production migrations instead of hand-rolled DDL, so this
        // fixture can't drift from migrations.ts.
        runMigrations(mockDb, 0);
      }
      return mockDb;
    }),
  };
});

describe('WorkflowRepository', () => {
  let db: Database.Database;
  let repo: WorkflowRepository;
  let testProjectId: string;

  beforeEach(async () => {
    // Get the mocked database
    const databaseModule = await import('../services/database');
    db = databaseModule.getDatabase();

    // Clear all tables
    db.exec('DELETE FROM workflows');
    db.exec('DELETE FROM projects');

    // Create a test project for workflows to reference
    testProjectId = 'test-project-1';
    db.prepare(`
      INSERT INTO projects (id, name, description, created_at)
      VALUES (?, ?, ?, ?)
    `).run(testProjectId, 'Test Project', 'A test project', Date.now());

    repo = new WorkflowRepository();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('create', () => {
    it('should create a new workflow with all required fields', () => {
      const workflow = repo.create({
        projectId: testProjectId,
        name: 'Test Workflow',
        description: 'A test workflow',
        dagDefinition: { nodes: [], edges: [] },
        enabled: true,
      });

      expect(workflow.id).toBeDefined();
      expect(workflow.id).toMatch(/^workflow-/);
      expect(workflow.projectId).toBe(testProjectId);
      expect(workflow.name).toBe('Test Workflow');
      expect(workflow.description).toBe('A test workflow');
      expect(workflow.dagDefinition).toEqual({ nodes: [], edges: [] });
      expect(workflow.enabled).toBe(true);
      // Fail closed: an unspecified reviewStatus defaults to 'pending' so an
      // unreviewed workflow can never auto-run via a routine.
      expect(workflow.reviewStatus).toBe('pending');
      expect(workflow.createdBy).toBe('user');
      expect(workflow.createdAt).toBeDefined();
      expect(workflow.updatedAt).toBeDefined();
      expect(workflow.createdAt).toBe(workflow.updatedAt);
    });

    it('should mark agent-authored workflows as pending when requested', () => {
      const workflow = repo.create({
        projectId: testProjectId,
        name: 'Agent Workflow',
        dagDefinition: { nodes: [], edges: [] },
        enabled: true,
        createdBy: 'agent',
        reviewStatus: 'pending',
      });

      expect(workflow.reviewStatus).toBe('pending');
      expect(workflow.createdBy).toBe('agent');
    });

    it('should flip reviewStatus via setReviewStatus', () => {
      const created = repo.create({
        projectId: testProjectId,
        name: 'Needs approval',
        dagDefinition: { nodes: [], edges: [] },
        enabled: true,
        createdBy: 'agent',
        reviewStatus: 'pending',
      });

      const approved = repo.setReviewStatus(created.id, 'approved');
      expect(approved).not.toBeNull();
      expect(approved!.reviewStatus).toBe('approved');
    });

    it('should count pending-review workflows', () => {
      repo.create({
        projectId: testProjectId,
        name: 'Approved',
        dagDefinition: { nodes: [], edges: [] },
        enabled: true,
        reviewStatus: 'approved',
      });
      repo.create({
        projectId: testProjectId,
        name: 'Pending 1',
        dagDefinition: { nodes: [], edges: [] },
        enabled: true,
        createdBy: 'agent',
        reviewStatus: 'pending',
      });
      repo.create({
        projectId: testProjectId,
        name: 'Pending 2',
        dagDefinition: { nodes: [], edges: [] },
        enabled: true,
        createdBy: 'agent',
        reviewStatus: 'pending',
      });

      expect(repo.countPendingReview()).toBe(2);
      expect(repo.countPendingReview(testProjectId)).toBe(2);
      expect(repo.countPendingReview('nonexistent-project')).toBe(0);
    });

    it('should create workflow without description', () => {
      const workflow = repo.create({
        projectId: testProjectId,
        name: 'Simple Workflow',
        dagDefinition: { nodes: [], edges: [] },
        enabled: true,
      });

      expect(workflow.id).toBeDefined();
      // Repository now converts null to undefined for optional fields
      expect(workflow.description).toBeUndefined();
    });

    it('should create workflow with disabled state', () => {
      const workflow = repo.create({
        projectId: testProjectId,
        name: 'Disabled Workflow',
        dagDefinition: { nodes: [], edges: [] },
        enabled: false,
      });

      expect(workflow.enabled).toBe(false);
    });

    it('should create workflow with complex DAG definition', () => {
      const complexDag = {
        nodes: [
          { id: 'node1', type: 'start', data: { label: 'Start' } },
          { id: 'node2', type: 'agent', data: { agentId: 'agent-1', label: 'Agent Node' } },
          { id: 'node3', type: 'end', data: { label: 'End' } },
        ],
        edges: [
          { id: 'edge1', source: 'node1', target: 'node2' },
          { id: 'edge2', source: 'node2', target: 'node3' },
        ],
      };

      const workflow = repo.create({
        projectId: testProjectId,
        name: 'Complex Workflow',
        dagDefinition: complexDag,
        enabled: true,
      });

      expect(workflow.dagDefinition).toEqual(complexDag);
    });

    it('should persist workflow to database', () => {
      const workflow = repo.create({
        projectId: testProjectId,
        name: 'Persistent Workflow',
        description: 'Test persistence',
        dagDefinition: { nodes: [], edges: [] },
        enabled: true,
      });

      const row = db.prepare('SELECT * FROM workflows WHERE id = ?').get(workflow.id);
      expect(row).toBeDefined();
      expect((row as any).name).toBe('Persistent Workflow');
      expect((row as any).project_id).toBe(testProjectId);
      expect((row as any).enabled).toBe(1);
    });

    it('should store DAG definition as JSON string in database', () => {
      const dagDef = { nodes: [{ id: '1' }], edges: [] };
      const workflow = repo.create({
        projectId: testProjectId,
        name: 'JSON Test',
        dagDefinition: dagDef,
        enabled: true,
      });

      const row = db.prepare('SELECT dag_definition FROM workflows WHERE id = ?').get(workflow.id) as any;
      expect(JSON.parse(row.dag_definition)).toEqual(dagDef);
    });

    it('should generate unique IDs for multiple workflows', () => {
      const workflow1 = repo.create({
        projectId: testProjectId,
        name: 'Workflow 1',
        dagDefinition: { nodes: [], edges: [] },
        enabled: true,
      });

      const workflow2 = repo.create({
        projectId: testProjectId,
        name: 'Workflow 2',
        dagDefinition: { nodes: [], edges: [] },
        enabled: true,
      });

      expect(workflow1.id).not.toBe(workflow2.id);
    });
  });

  describe('getById', () => {
    it('should return workflow by ID', () => {
      const created = repo.create({
        projectId: testProjectId,
        name: 'Test Workflow',
        description: 'For retrieval',
        dagDefinition: { nodes: [], edges: [] },
        enabled: true,
      });

      const workflow = repo.getById(created.id);
      expect(workflow).toBeDefined();
      expect(workflow!.id).toBe(created.id);
      expect(workflow!.name).toBe('Test Workflow');
      expect(workflow!.description).toBe('For retrieval');
      expect(workflow!.projectId).toBe(testProjectId);
    });

    it('should return null for non-existent workflow', () => {
      const workflow = repo.getById('non-existent-id');
      expect(workflow).toBeNull();
    });

    it('should parse DAG definition from JSON', () => {
      const dagDef = {
        nodes: [{ id: 'node1', type: 'agent' }],
        edges: [{ id: 'edge1', source: 'node1', target: 'node2' }],
      };

      const created = repo.create({
        projectId: testProjectId,
        name: 'Test',
        dagDefinition: dagDef,
        enabled: true,
      });

      const workflow = repo.getById(created.id);
      expect(workflow!.dagDefinition).toEqual(dagDef);
    });

    it('should convert enabled flag from integer to boolean', () => {
      const workflow1 = repo.create({
        projectId: testProjectId,
        name: 'Enabled',
        dagDefinition: { nodes: [], edges: [] },
        enabled: true,
      });

      const workflow2 = repo.create({
        projectId: testProjectId,
        name: 'Disabled',
        dagDefinition: { nodes: [], edges: [] },
        enabled: false,
      });

      expect(repo.getById(workflow1.id)!.enabled).toBe(true);
      expect(repo.getById(workflow2.id)!.enabled).toBe(false);
    });

    it('should handle workflow with null description', () => {
      const created = repo.create({
        projectId: testProjectId,
        name: 'No Description',
        dagDefinition: { nodes: [], edges: [] },
        enabled: true,
      });

      const workflow = repo.getById(created.id);
      // Repository now converts null to undefined for optional fields
      expect(workflow!.description).toBeUndefined();
    });

    it('should return workflow with all fields intact', () => {
      const created = repo.create({
        projectId: testProjectId,
        name: 'Full Workflow',
        description: 'Complete test',
        dagDefinition: { nodes: [{ id: '1' }], edges: [] },
        enabled: true,
      });

      const workflow = repo.getById(created.id);
      expect(workflow).toBeDefined();
      expect(workflow!.id).toBe(created.id);
      expect(workflow!.projectId).toBe(testProjectId);
      expect(workflow!.name).toBe('Full Workflow');
      expect(workflow!.description).toBe('Complete test');
      expect(workflow!.dagDefinition).toEqual({ nodes: [{ id: '1' }], edges: [] });
      expect(workflow!.enabled).toBe(true);
      expect(workflow!.createdAt).toBe(created.createdAt);
      expect(workflow!.updatedAt).toBe(created.updatedAt);
    });
  });

  describe('getByProjectId', () => {
    it('should return empty array when no workflows exist for project', () => {
      const workflows = repo.getByProjectId(testProjectId);
      expect(workflows).toEqual([]);
    });

    it('should return all workflows for a project', () => {
      const workflow1 = repo.create({
        projectId: testProjectId,
        name: 'Workflow 1',
        dagDefinition: { nodes: [], edges: [] },
        enabled: true,
      });

      const workflow2 = repo.create({
        projectId: testProjectId,
        name: 'Workflow 2',
        dagDefinition: { nodes: [], edges: [] },
        enabled: true,
      });

      const workflows = repo.getByProjectId(testProjectId);
      expect(workflows).toHaveLength(2);
      expect(workflows.map(w => w.id)).toContain(workflow1.id);
      expect(workflows.map(w => w.id)).toContain(workflow2.id);
    });

    it('should return workflows ordered by created_at DESC', () => {
      // Create first workflow
      const workflow1 = repo.create({
        projectId: testProjectId,
        name: 'First',
        dagDefinition: { nodes: [], edges: [] },
        enabled: true,
      });

      // Small delay to ensure different timestamps
      const now = Date.now();
      while (Date.now() === now) {
        // Wait for timestamp to change
      }

      // Create second workflow
      const workflow2 = repo.create({
        projectId: testProjectId,
        name: 'Second',
        dagDefinition: { nodes: [], edges: [] },
        enabled: true,
      });

      const workflows = repo.getByProjectId(testProjectId);
      expect(workflows).toHaveLength(2);
      // Most recent should be first
      expect(workflows[0].id).toBe(workflow2.id);
      expect(workflows[1].id).toBe(workflow1.id);
    });

    it('should only return workflows for specified project', () => {
      // Create second project
      const project2Id = 'test-project-2';
      db.prepare(`
        INSERT INTO projects (id, name, description, created_at)
        VALUES (?, ?, ?, ?)
      `).run(project2Id, 'Project 2', 'Second project', Date.now());

      // Create workflows for different projects
      const workflow1 = repo.create({
        projectId: testProjectId,
        name: 'Project 1 Workflow',
        dagDefinition: { nodes: [], edges: [] },
        enabled: true,
      });

      const workflow2 = repo.create({
        projectId: project2Id,
        name: 'Project 2 Workflow',
        dagDefinition: { nodes: [], edges: [] },
        enabled: true,
      });

      const project1Workflows = repo.getByProjectId(testProjectId);
      expect(project1Workflows).toHaveLength(1);
      expect(project1Workflows[0].id).toBe(workflow1.id);

      const project2Workflows = repo.getByProjectId(project2Id);
      expect(project2Workflows).toHaveLength(1);
      expect(project2Workflows[0].id).toBe(workflow2.id);
    });

    it('should return workflows with all fields properly formatted', () => {
      const dagDef = { nodes: [{ id: 'test' }], edges: [] };
      repo.create({
        projectId: testProjectId,
        name: 'Test Workflow',
        description: 'Test description',
        dagDefinition: dagDef,
        enabled: false,
      });

      const workflows = repo.getByProjectId(testProjectId);
      expect(workflows).toHaveLength(1);
      expect(workflows[0].name).toBe('Test Workflow');
      expect(workflows[0].description).toBe('Test description');
      expect(workflows[0].dagDefinition).toEqual(dagDef);
      expect(workflows[0].enabled).toBe(false);
    });

    it('should handle malformed JSON in dag_definition gracefully', () => {
      // Directly insert a workflow with invalid JSON
      const id = 'workflow-test-invalid';
      db.prepare(`
        INSERT INTO workflows (id, project_id, name, dag_definition, enabled, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(id, testProjectId, 'Invalid JSON', 'not-valid-json', 1, Date.now(), Date.now());

      const workflows = repo.getByProjectId(testProjectId);
      expect(workflows).toHaveLength(1);
      // Should fallback to default empty DAG
      expect(workflows[0].dagDefinition).toEqual({ nodes: [], edges: [] });
    });
  });

  describe('update', () => {
    it('should update workflow name', () => {
      const created = repo.create({
        projectId: testProjectId,
        name: 'Original Name',
        dagDefinition: { nodes: [], edges: [] },
        enabled: true,
      });

      const updated = repo.update(created.id, { name: 'Updated Name' });
      expect(updated).toBeDefined();
      expect(updated!.name).toBe('Updated Name');

      const retrieved = repo.getById(created.id);
      expect(retrieved!.name).toBe('Updated Name');
    });

    it('should update workflow description', () => {
      const created = repo.create({
        projectId: testProjectId,
        name: 'Workflow',
        description: 'Original description',
        dagDefinition: { nodes: [], edges: [] },
        enabled: true,
      });

      const updated = repo.update(created.id, { description: 'New description' });
      expect(updated!.description).toBe('New description');
    });

    it('should update workflow DAG definition', () => {
      const created = repo.create({
        projectId: testProjectId,
        name: 'Workflow',
        dagDefinition: { nodes: [], edges: [] },
        enabled: true,
      });

      const newDag = {
        nodes: [{ id: 'node1', type: 'agent' }],
        edges: [{ id: 'edge1', source: 'node1', target: 'node2' }],
      };

      const updated = repo.update(created.id, { dagDefinition: newDag });
      expect(updated!.dagDefinition).toEqual(newDag);
    });

    it('should update workflow enabled status', () => {
      const created = repo.create({
        projectId: testProjectId,
        name: 'Workflow',
        dagDefinition: { nodes: [], edges: [] },
        enabled: true,
      });

      const updated = repo.update(created.id, { enabled: false });
      expect(updated!.enabled).toBe(false);

      const toggled = repo.update(created.id, { enabled: true });
      expect(toggled!.enabled).toBe(true);
    });

    it('should update multiple fields at once', () => {
      const created = repo.create({
        projectId: testProjectId,
        name: 'Original',
        description: 'Original description',
        dagDefinition: { nodes: [], edges: [] },
        enabled: true,
      });

      const newDag = { nodes: [{ id: 'new' }], edges: [] };
      const updated = repo.update(created.id, {
        name: 'Updated Name',
        description: 'Updated description',
        dagDefinition: newDag,
        enabled: false,
      });

      expect(updated!.name).toBe('Updated Name');
      expect(updated!.description).toBe('Updated description');
      expect(updated!.dagDefinition).toEqual(newDag);
      expect(updated!.enabled).toBe(false);
    });

    it('should update updatedAt timestamp', () => {
      const created = repo.create({
        projectId: testProjectId,
        name: 'Workflow',
        dagDefinition: { nodes: [], edges: [] },
        enabled: true,
      });

      const originalUpdatedAt = created.updatedAt;

      // Ensure time has passed
      const now = Date.now();
      while (Date.now() === now) {
        // Wait for timestamp to change
      }

      const updated = repo.update(created.id, { name: 'Updated' });
      expect(updated!.updatedAt).toBeGreaterThan(originalUpdatedAt);
    });

    it('should preserve createdAt timestamp', () => {
      const created = repo.create({
        projectId: testProjectId,
        name: 'Workflow',
        dagDefinition: { nodes: [], edges: [] },
        enabled: true,
      });

      const updated = repo.update(created.id, { name: 'Updated' });
      expect(updated!.createdAt).toBe(created.createdAt);
    });

    it('should not update projectId', () => {
      const created = repo.create({
        projectId: testProjectId,
        name: 'Workflow',
        dagDefinition: { nodes: [], edges: [] },
        enabled: true,
      });

      // Update doesn't allow projectId changes (it's excluded from the type)
      const updated = repo.update(created.id, { name: 'Updated' });
      expect(updated!.projectId).toBe(testProjectId);
    });

    it('should return null when updating non-existent workflow', () => {
      const updated = repo.update('non-existent', { name: 'New Name' });
      expect(updated).toBeNull();
    });

    it('should handle empty updates object', () => {
      const created = repo.create({
        projectId: testProjectId,
        name: 'Workflow',
        dagDefinition: { nodes: [], edges: [] },
        enabled: true,
      });

      const updated = repo.update(created.id, {});
      expect(updated).toBeDefined();
      expect(updated!.id).toBe(created.id);
      expect(updated!.name).toBe('Workflow');
    });

    it('should update only specified fields', () => {
      const created = repo.create({
        projectId: testProjectId,
        name: 'Original Name',
        description: 'Original description',
        dagDefinition: { nodes: [], edges: [] },
        enabled: true,
      });

      const updated = repo.update(created.id, { name: 'Updated Name' });
      expect(updated!.name).toBe('Updated Name');
      expect(updated!.description).toBe('Original description');
      expect(updated!.enabled).toBe(true);
    });

    it('should persist updates to database', () => {
      const created = repo.create({
        projectId: testProjectId,
        name: 'Original',
        dagDefinition: { nodes: [], edges: [] },
        enabled: true,
      });

      repo.update(created.id, { name: 'Updated', enabled: false });

      const row = db.prepare('SELECT * FROM workflows WHERE id = ?').get(created.id) as any;
      expect(row.name).toBe('Updated');
      expect(row.enabled).toBe(0);
    });

    it('should not update field when undefined is passed', () => {
      const created = repo.create({
        projectId: testProjectId,
        name: 'Workflow',
        description: 'Has description',
        dagDefinition: { nodes: [], edges: [] },
        enabled: true,
      });

      // The update() method checks if description !== undefined, so passing undefined
      // means the field will NOT be updated (it will be skipped)
      const updated = repo.update(created.id, { description: undefined });
      expect(updated).toBeDefined();

      // Description should remain unchanged
      expect(updated!.description).toBe('Has description');

      const row = db.prepare('SELECT description FROM workflows WHERE id = ?').get(created.id) as any;
      expect(row.description).toBe('Has description');
    });

    it('should clear description when explicitly set to null', () => {
      const created = repo.create({
        projectId: testProjectId,
        name: 'Workflow',
        description: 'Has description',
        dagDefinition: { nodes: [], edges: [] },
        enabled: true,
      });

      // To clear a field, pass null (not undefined)
      const updated = repo.update(created.id, { description: null as any });
      expect(updated).toBeDefined();

      // Description should now be undefined (null converted to undefined)
      expect(updated!.description).toBeUndefined();

      const row = db.prepare('SELECT description FROM workflows WHERE id = ?').get(created.id) as any;
      expect(row.description).toBeNull();
    });
  });

  // Regression: `pinned` was written correctly but left out of the shared
  // SELECT column list, so every read reported false. The row cast makes a
  // missing column `undefined` — Boolean(undefined) is false — so the write
  // looked like a no-op from the UI and pinning appeared not to persist.
  describe('pinning', () => {
    it('reads back a pin through both read paths', () => {
      const created = repo.create({
        projectId: testProjectId,
        name: 'Pinnable',
        dagDefinition: { nodes: [], edges: [] },
        enabled: true,
      } as never);
      expect(created.pinned).toBe(false);

      const updated = repo.update(created.id, { pinned: true });
      expect(updated?.pinned).toBe(true);
      expect(repo.getById(created.id)?.pinned).toBe(true);
      expect(repo.getByProjectId(testProjectId)[0].pinned).toBe(true);

      expect(repo.update(created.id, { pinned: false })?.pinned).toBe(false);
      expect(repo.getById(created.id)?.pinned).toBe(false);
    });

    it('leaves the pin alone when an unrelated field is updated', () => {
      const created = repo.create({
        projectId: testProjectId,
        name: 'Pinnable',
        dagDefinition: { nodes: [], edges: [] },
        enabled: true,
      } as never);
      repo.update(created.id, { pinned: true });

      expect(repo.update(created.id, { name: 'Renamed' })?.pinned).toBe(true);
    });
  });

  describe('delete', () => {
    it('should delete workflow by ID', () => {
      const created = repo.create({
        projectId: testProjectId,
        name: 'Workflow to Delete',
        dagDefinition: { nodes: [], edges: [] },
        enabled: true,
      });

      const deleted = repo.delete(created.id);
      expect(deleted).toBe(true);

      const retrieved = repo.getById(created.id);
      expect(retrieved).toBeNull();
    });

    it('should return false when deleting non-existent workflow', () => {
      const deleted = repo.delete('non-existent-id');
      expect(deleted).toBe(false);
    });

    it('should remove workflow from database', () => {
      const created = repo.create({
        projectId: testProjectId,
        name: 'Workflow',
        dagDefinition: { nodes: [], edges: [] },
        enabled: true,
      });

      repo.delete(created.id);

      const row = db.prepare('SELECT * FROM workflows WHERE id = ?').get(created.id);
      expect(row).toBeUndefined();
    });

    it('should handle multiple deletions', () => {
      const workflow1 = repo.create({
        projectId: testProjectId,
        name: 'Workflow 1',
        dagDefinition: { nodes: [], edges: [] },
        enabled: true,
      });

      const workflow2 = repo.create({
        projectId: testProjectId,
        name: 'Workflow 2',
        dagDefinition: { nodes: [], edges: [] },
        enabled: true,
      });

      expect(repo.delete(workflow1.id)).toBe(true);
      expect(repo.delete(workflow2.id)).toBe(true);

      const workflows = repo.getByProjectId(testProjectId);
      expect(workflows).toEqual([]);
    });

    it('should not affect other workflows when deleting one', () => {
      const workflow1 = repo.create({
        projectId: testProjectId,
        name: 'Workflow 1',
        dagDefinition: { nodes: [], edges: [] },
        enabled: true,
      });

      const workflow2 = repo.create({
        projectId: testProjectId,
        name: 'Workflow 2',
        dagDefinition: { nodes: [], edges: [] },
        enabled: true,
      });

      repo.delete(workflow1.id);

      const remaining = repo.getByProjectId(testProjectId);
      expect(remaining).toHaveLength(1);
      expect(remaining[0].id).toBe(workflow2.id);
    });

    it('should return false when deleting already deleted workflow', () => {
      const created = repo.create({
        projectId: testProjectId,
        name: 'Workflow',
        dagDefinition: { nodes: [], edges: [] },
        enabled: true,
      });

      expect(repo.delete(created.id)).toBe(true);
      expect(repo.delete(created.id)).toBe(false);
    });
  });

  describe('Edge cases and error handling', () => {
    it('should handle workflow names with special characters', () => {
      const workflow = repo.create({
        projectId: testProjectId,
        name: "Workflow's \"Special\" Name (Test) & More",
        dagDefinition: { nodes: [], edges: [] },
        enabled: true,
      });

      expect(workflow.name).toBe("Workflow's \"Special\" Name (Test) & More");

      const retrieved = repo.getById(workflow.id);
      expect(retrieved!.name).toBe("Workflow's \"Special\" Name (Test) & More");
    });

    it('should handle long descriptions', () => {
      const longDescription = 'A'.repeat(5000);
      const workflow = repo.create({
        projectId: testProjectId,
        name: 'Workflow',
        description: longDescription,
        dagDefinition: { nodes: [], edges: [] },
        enabled: true,
      });

      const retrieved = repo.getById(workflow.id);
      expect(retrieved!.description).toBe(longDescription);
    });

    it('should handle empty DAG definition', () => {
      const workflow = repo.create({
        projectId: testProjectId,
        name: 'Empty DAG',
        dagDefinition: {},
        enabled: true,
      });

      expect(workflow.dagDefinition).toEqual({});

      const retrieved = repo.getById(workflow.id);
      expect(retrieved!.dagDefinition).toEqual({});
    });

    it('should handle complex nested DAG definition', () => {
      const complexDag = {
        nodes: [
          {
            id: 'node1',
            type: 'agent',
            data: {
              label: 'Agent 1',
              config: {
                model: 'claude-3-sonnet',
                temperature: 0.7,
                maxOutputTokens: 4096,
              },
            },
            position: { x: 100, y: 100 },
          },
          {
            id: 'node2',
            type: 'loop',
            data: {
              label: 'Loop Node',
              collection: '$items',
              variable: 'item',
              maxIterations: 10,
            },
            position: { x: 300, y: 100 },
          },
        ],
        edges: [
          {
            id: 'edge1',
            source: 'node1',
            target: 'node2',
            type: 'default',
          },
        ],
        metadata: {
          version: '1.0',
          author: 'test',
        },
      };

      const workflow = repo.create({
        projectId: testProjectId,
        name: 'Complex DAG',
        dagDefinition: complexDag,
        enabled: true,
      });

      const retrieved = repo.getById(workflow.id);
      expect(retrieved!.dagDefinition).toEqual(complexDag);
    });

    it('should handle DAG definition with arrays', () => {
      const dagWithArrays = {
        nodes: [
          { id: '1', tags: ['tag1', 'tag2', 'tag3'] },
          { id: '2', tags: [] },
        ],
        edges: [],
      };

      const workflow = repo.create({
        projectId: testProjectId,
        name: 'DAG with Arrays',
        dagDefinition: dagWithArrays,
        enabled: true,
      });

      const retrieved = repo.getById(workflow.id);
      expect(retrieved!.dagDefinition).toEqual(dagWithArrays);
    });

    it('should handle workflows with undefined optional fields', () => {
      const workflow = repo.create({
        projectId: testProjectId,
        name: 'Minimal Workflow',
        dagDefinition: { nodes: [], edges: [] },
        enabled: true,
      });

      // Repository now converts null to undefined for optional fields
      expect(workflow.description).toBeUndefined();

      const retrieved = repo.getById(workflow.id);
      expect(retrieved!.description).toBeUndefined();
    });

    it('should maintain data integrity with rapid consecutive operations', () => {
      const workflows = [];

      // Create multiple workflows rapidly
      for (let i = 0; i < 10; i++) {
        workflows.push(
          repo.create({
            projectId: testProjectId,
            name: `Workflow ${i}`,
            dagDefinition: { nodes: [], edges: [] },
            enabled: i % 2 === 0,
          })
        );
      }

      const all = repo.getByProjectId(testProjectId);
      expect(all).toHaveLength(10);

      // Update half of them
      workflows.slice(0, 5).forEach((workflow, index) => {
        repo.update(workflow.id, { name: `Updated Workflow ${index}` });
      });

      const updated = repo.getByProjectId(testProjectId);
      expect(updated).toHaveLength(10);

      const updatedCount = updated.filter(w => w.name.startsWith('Updated')).length;
      expect(updatedCount).toBe(5);

      // Delete some
      workflows.slice(0, 3).forEach(workflow => {
        repo.delete(workflow.id);
      });

      const final = repo.getByProjectId(testProjectId);
      expect(final).toHaveLength(7);
    });

    it('should handle boolean enabled field correctly in all operations', () => {
      // Create with true
      const enabled = repo.create({
        projectId: testProjectId,
        name: 'Enabled',
        dagDefinition: { nodes: [], edges: [] },
        enabled: true,
      });

      // Create with false
      const disabled = repo.create({
        projectId: testProjectId,
        name: 'Disabled',
        dagDefinition: { nodes: [], edges: [] },
        enabled: false,
      });

      // Verify retrieval
      expect(repo.getById(enabled.id)!.enabled).toBe(true);
      expect(repo.getById(disabled.id)!.enabled).toBe(false);

      // Verify in list
      const all = repo.getByProjectId(testProjectId);
      const foundEnabled = all.find(w => w.id === enabled.id);
      const foundDisabled = all.find(w => w.id === disabled.id);
      expect(foundEnabled!.enabled).toBe(true);
      expect(foundDisabled!.enabled).toBe(false);

      // Toggle
      repo.update(enabled.id, { enabled: false });
      repo.update(disabled.id, { enabled: true });

      expect(repo.getById(enabled.id)!.enabled).toBe(false);
      expect(repo.getById(disabled.id)!.enabled).toBe(true);
    });

    it('should handle null vs undefined for optional fields', () => {
      const workflow = repo.create({
        projectId: testProjectId,
        name: 'Test',
        description: undefined,
        dagDefinition: { nodes: [], edges: [] },
        enabled: true,
      });

      // Repository now converts null to undefined for optional fields
      expect(workflow.description).toBeUndefined();

      const retrieved = repo.getById(workflow.id);
      expect(retrieved!.description).toBeUndefined();
    });

    it('should handle workflows from different projects independently', () => {
      // Create multiple projects
      const project2Id = 'test-project-2';
      const project3Id = 'test-project-3';

      db.prepare(`
        INSERT INTO projects (id, name, description, created_at)
        VALUES (?, ?, ?, ?)
      `).run(project2Id, 'Project 2', 'Second project', Date.now());

      db.prepare(`
        INSERT INTO projects (id, name, description, created_at)
        VALUES (?, ?, ?, ?)
      `).run(project3Id, 'Project 3', 'Third project', Date.now());

      // Create workflows for each project
      const w1 = repo.create({
        projectId: testProjectId,
        name: 'Project 1 Workflow',
        dagDefinition: { nodes: [], edges: [] },
        enabled: true,
      });

      const w2a = repo.create({
        projectId: project2Id,
        name: 'Project 2 Workflow A',
        dagDefinition: { nodes: [], edges: [] },
        enabled: true,
      });

      const w2b = repo.create({
        projectId: project2Id,
        name: 'Project 2 Workflow B',
        dagDefinition: { nodes: [], edges: [] },
        enabled: true,
      });

      const w3 = repo.create({
        projectId: project3Id,
        name: 'Project 3 Workflow',
        dagDefinition: { nodes: [], edges: [] },
        enabled: true,
      });

      // Verify each project has correct workflows
      expect(repo.getByProjectId(testProjectId)).toHaveLength(1);
      expect(repo.getByProjectId(project2Id)).toHaveLength(2);
      expect(repo.getByProjectId(project3Id)).toHaveLength(1);

      // Delete from project 2
      repo.delete(w2a.id);

      expect(repo.getByProjectId(testProjectId)).toHaveLength(1);
      expect(repo.getByProjectId(project2Id)).toHaveLength(1);
      expect(repo.getByProjectId(project3Id)).toHaveLength(1);
    });
  });
});
