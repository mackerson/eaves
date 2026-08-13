import { describe, it, expect } from 'vitest';
import {
  AgentNameSchema,
  AgentDescriptionSchema,
  AgentTemperatureSchema,
  AgentColorSchema,
  ProjectNameSchema,
  ProjectDescriptionSchema,
  CreateProjectSchema,
  ChannelNameSchema,
  MessageContentSchema,
  UserNameSchema,
  TaskContentSchema,
  NoteContentSchema,
  validateWithSchema,
  MessageMetricsObjectSchema,
  isValidationFailure,
  EntityIdSchema,
  CreateAgentIPCSchema,
  CreateWorkflowSchema,
  HttpRequestSchema,
  SendMessageSchema,
  CreateChatSchema,
  CreateTaskSchema,
  CreateNoteSchema,
  CreateRoutineSchema,
  LogErrorSchema,
  ReorderItemsSchema,
  DateRangeSchema,
} from './validation';

describe('Validation Schemas', () => {
  describe('AgentNameSchema', () => {
    it('should accept valid agent names', () => {
      expect(AgentNameSchema.parse('My Agent')).toBe('My Agent');
      expect(AgentNameSchema.parse('  Claude  ')).toBe('Claude');
    });

    it('should reject empty names', () => {
      expect(() => AgentNameSchema.parse('')).toThrow('Agent name is required');
      expect(() => AgentNameSchema.parse('   ')).toThrow('Agent name is required');
    });

    it('should reject names over 100 characters', () => {
      const longName = 'a'.repeat(101);
      expect(() => AgentNameSchema.parse(longName)).toThrow('Agent name must be less than 100 characters');
    });
  });

  describe('AgentDescriptionSchema', () => {
    it('should accept valid descriptions', () => {
      expect(AgentDescriptionSchema.parse('A helpful assistant')).toBe('A helpful assistant');
    });

    it('should reject empty descriptions', () => {
      expect(() => AgentDescriptionSchema.parse('')).toThrow('Agent description is required');
    });

    it('should reject descriptions over 500 characters', () => {
      const longDesc = 'a'.repeat(501);
      expect(() => AgentDescriptionSchema.parse(longDesc)).toThrow();
    });
  });

  describe('AgentTemperatureSchema', () => {
    it('should accept valid temperatures', () => {
      expect(AgentTemperatureSchema.parse(0)).toBe(0);
      expect(AgentTemperatureSchema.parse(0.7)).toBe(0.7);
      expect(AgentTemperatureSchema.parse(2)).toBe(2);
    });

    it('should reject temperatures below 0', () => {
      expect(() => AgentTemperatureSchema.parse(-0.1)).toThrow();
    });

    it('should reject temperatures above 2', () => {
      expect(() => AgentTemperatureSchema.parse(2.1)).toThrow();
    });
  });

  describe('AgentColorSchema', () => {
    it('should accept valid hex colors', () => {
      expect(AgentColorSchema.parse('#667eea')).toBe('#667eea');
      expect(AgentColorSchema.parse('#FFFFFF')).toBe('#FFFFFF');
      expect(AgentColorSchema.parse('#000000')).toBe('#000000');
    });

    it('should reject invalid hex colors', () => {
      expect(() => AgentColorSchema.parse('667eea')).toThrow();
      expect(() => AgentColorSchema.parse('#667')).toThrow();
      expect(() => AgentColorSchema.parse('#gggggg')).toThrow();
      expect(() => AgentColorSchema.parse('rgb(255,0,0)')).toThrow();
    });
  });

  describe('ProjectNameSchema', () => {
    it('should accept valid project names', () => {
      expect(ProjectNameSchema.parse('My Project')).toBe('My Project');
    });

    it('should reject empty names', () => {
      expect(() => ProjectNameSchema.parse('')).toThrow();
    });

    it('should reject names over 100 characters', () => {
      const longName = 'a'.repeat(101);
      expect(() => ProjectNameSchema.parse(longName)).toThrow();
    });
  });

  describe('ProjectDescriptionSchema', () => {
    it('should accept valid descriptions', () => {
      expect(ProjectDescriptionSchema.parse('A project')).toBe('A project');
    });

    it('should accept empty descriptions', () => {
      expect(ProjectDescriptionSchema.parse('')).toBe('');
    });

    it('should use empty string as default', () => {
      expect(ProjectDescriptionSchema.parse(undefined)).toBe('');
    });

    it('should reject descriptions over 500 characters', () => {
      const longDesc = 'a'.repeat(501);
      expect(() => ProjectDescriptionSchema.parse(longDesc)).toThrow();
    });
  });

  describe('CreateProjectSchema', () => {
    it('should accept valid project data', () => {
      const project = {
        name: 'Test Project',
        description: 'A test project',
      };

      const result = CreateProjectSchema.parse(project);
      expect(result).toEqual(project);
    });

    it('should use default empty description', () => {
      const project = { name: 'Test' };
      const result = CreateProjectSchema.parse(project);
      expect(result.description).toBe('');
    });
  });

  describe('ChannelNameSchema', () => {
    it('should accept valid channel names', () => {
      expect(ChannelNameSchema.parse('general')).toBe('general');
      expect(ChannelNameSchema.parse('team-chat')).toBe('team-chat');
    });

    it('should reject empty names', () => {
      expect(() => ChannelNameSchema.parse('')).toThrow();
    });
  });

  describe('MessageContentSchema', () => {
    it('should accept valid messages', () => {
      expect(MessageContentSchema.parse('Hello world')).toBe('Hello world');
    });

    it('should reject empty messages', () => {
      expect(() => MessageContentSchema.parse('')).toThrow();
      expect(() => MessageContentSchema.parse('   ')).toThrow();
    });

    it('should reject messages over 50000 characters', () => {
      const longMessage = 'a'.repeat(50001);
      expect(() => MessageContentSchema.parse(longMessage)).toThrow();
    });
  });

  describe('UserNameSchema', () => {
    it('should accept valid user names', () => {
      expect(UserNameSchema.parse('John Doe')).toBe('John Doe');
    });

    it('should reject empty names', () => {
      expect(() => UserNameSchema.parse('')).toThrow();
    });

    it('should reject names over 50 characters', () => {
      const longName = 'a'.repeat(51);
      expect(() => UserNameSchema.parse(longName)).toThrow();
    });
  });

  describe('TaskContentSchema', () => {
    it('should accept valid task content', () => {
      expect(TaskContentSchema.parse('Fix bug in login')).toBe('Fix bug in login');
    });

    it('should reject empty tasks', () => {
      expect(() => TaskContentSchema.parse('')).toThrow();
    });

    it('should reject tasks over 500 characters', () => {
      const longTask = 'a'.repeat(501);
      expect(() => TaskContentSchema.parse(longTask)).toThrow();
    });
  });

  describe('NoteContentSchema', () => {
    it('should accept valid note content', () => {
      expect(NoteContentSchema.parse('Meeting notes...')).toBe('Meeting notes...');
    });

    it('should reject empty notes', () => {
      expect(() => NoteContentSchema.parse('')).toThrow();
    });

    it('should reject notes over 10000 characters', () => {
      const longNote = 'a'.repeat(10001);
      expect(() => NoteContentSchema.parse(longNote)).toThrow();
    });
  });

  describe('validateWithSchema', () => {
    it('should return success for valid data', () => {
      const result = validateWithSchema(AgentNameSchema, 'Claude');
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toBe('Claude');
      }
    });

    it('should return error for invalid data', () => {
      const result = validateWithSchema(AgentNameSchema, '');
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toBe('Agent name is required');
      }
    });

    it('should return user-friendly error messages', () => {
      const result = validateWithSchema(AgentTemperatureSchema, 5);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('Temperature');
      }
    });

    it('should handle complex schemas', () => {
      const validAgent = {
        name: 'Test',
        description: 'Test agent',
        provider: 'anthropic' as const,
        model: 'claude-sonnet-4-20250514',
      };

      const result = validateWithSchema(CreateAgentIPCSchema, validAgent);
      expect(result.success).toBe(true);
    });

    it('prefixes the failing field path on a multi-field payload', () => {
      // Missing `name` in an object schema — the error should name the field,
      // not just say "Required".
      const result = validateWithSchema(CreateAgentIPCSchema, {
        provider: 'anthropic' as const,
        model: 'claude-sonnet-4-20250514',
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('name');
      }
    });
  });

  describe('isValidationFailure', () => {
    it('should return true for validation failures', () => {
      const result = validateWithSchema(EntityIdSchema, '');
      expect(isValidationFailure(result)).toBe(true);
    });

    it('should return false for validation successes', () => {
      const result = validateWithSchema(EntityIdSchema, 'valid-id');
      expect(isValidationFailure(result)).toBe(false);
    });

    it('should narrow types correctly', () => {
      const result = validateWithSchema(EntityIdSchema, 'test-id');
      if (isValidationFailure(result)) {
        // TypeScript should know result.error exists
        expect(result.error).toBeDefined();
      } else {
        // TypeScript should know result.data exists
        expect(result.data).toBe('test-id');
      }
    });
  });

  describe('EntityIdSchema', () => {
    it('should accept valid IDs', () => {
      expect(EntityIdSchema.parse('abc123')).toBe('abc123');
      expect(EntityIdSchema.parse('uuid-style-id')).toBe('uuid-style-id');
    });

    it('should reject empty IDs', () => {
      expect(() => EntityIdSchema.parse('')).toThrow('ID is required');
    });

    it('should reject IDs over 100 characters', () => {
      const longId = 'a'.repeat(101);
      expect(() => EntityIdSchema.parse(longId)).toThrow('ID is too long');
    });
  });

  describe('CreateAgentIPCSchema', () => {
    it('should accept valid agent IPC data', () => {
      const agent = {
        name: 'Claude',
        description: 'AI assistant',
        provider: 'anthropic' as const,
        model: 'claude-sonnet-4-20250514',
      };

      const result = CreateAgentIPCSchema.parse(agent);
      expect(result.name).toBe('Claude');
      expect(result.temperature).toBe(0.7); // default
      expect(result.color).toBe('#667eea'); // default
    });

    it('should accept system prompt', () => {
      const agent = {
        name: 'Claude',
        description: 'AI assistant',
        provider: 'anthropic' as const,
        model: 'claude-sonnet-4-20250514',
        systemPrompt: 'You are a helpful assistant',
      };

      const result = CreateAgentIPCSchema.parse(agent);
      expect(result.systemPrompt).toBe('You are a helpful assistant');
    });

    it('should reject system prompts over 50000 chars', () => {
      const agent = {
        name: 'Claude',
        description: 'AI assistant',
        provider: 'anthropic' as const,
        model: 'claude-sonnet-4-20250514',
        systemPrompt: 'a'.repeat(50001),
      };

      expect(() => CreateAgentIPCSchema.parse(agent)).toThrow();
    });
  });

  describe('HttpRequestSchema', () => {
    it('should accept valid HTTP requests', () => {
      const request = {
        url: 'https://api.example.com/data',
        method: 'GET' as const,
      };

      const result = HttpRequestSchema.parse(request);
      expect(result.url).toBe('https://api.example.com/data');
      expect(result.method).toBe('GET');
    });

    it('should reject invalid URLs', () => {
      const request = {
        url: 'not-a-valid-url',
        method: 'GET' as const,
      };

      expect(() => HttpRequestSchema.parse(request)).toThrow();
    });

    it('should accept headers and body', () => {
      const request = {
        url: 'https://api.example.com/data',
        method: 'POST' as const,
        headers: { 'Content-Type': 'application/json' },
        body: '{"key": "value"}',
      };

      const result = HttpRequestSchema.parse(request);
      expect(result.headers).toEqual({ 'Content-Type': 'application/json' });
      expect(result.body).toBe('{"key": "value"}');
    });
  });

  describe('SendMessageSchema', () => {
    it('should accept valid message data', () => {
      const message = {
        channelId: 'channel-123',
        content: 'Hello world',
      };

      const result = SendMessageSchema.parse(message);
      expect(result.channelId).toBe('channel-123');
      expect(result.content).toBe('Hello world');
    });

    it('should reject empty content', () => {
      const message = {
        channelId: 'channel-123',
        content: '',
      };

      expect(() => SendMessageSchema.parse(message)).toThrow('Message cannot be empty');
    });
  });

  describe('CreateChatSchema', () => {
    it('should accept valid chat data', () => {
      const chat = {
        agentId: 'agent-123',
        name: 'My Chat',
      };

      const result = CreateChatSchema.parse(chat);
      expect(result.agentId).toBe('agent-123');
      expect(result.name).toBe('My Chat');
    });

    it('should allow optional name', () => {
      const chat = {
        agentId: 'agent-123',
      };

      const result = CreateChatSchema.parse(chat);
      expect(result.agentId).toBe('agent-123');
      expect(result.name).toBeUndefined();
    });
  });

  describe('CreateTaskSchema', () => {
    it('should accept valid task data', () => {
      const task = {
        content: 'Fix the bug',
        priority: 'high' as const,
      };

      const result = CreateTaskSchema.parse(task);
      expect(result.content).toBe('Fix the bug');
      expect(result.priority).toBe('high');
    });

    it('should use default color and priority', () => {
      const task = {
        content: 'Do something',
      };

      const result = CreateTaskSchema.parse(task);
      expect(result.color).toBe('default');
      expect(result.priority).toBe('medium');
    });
  });

  describe('CreateNoteSchema', () => {
    it('should accept valid note data', () => {
      const note = {
        content: 'Meeting notes...',
        title: 'Team Meeting',
        pinned: true,
      };

      const result = CreateNoteSchema.parse(note);
      expect(result.content).toBe('Meeting notes...');
      expect(result.title).toBe('Team Meeting');
      expect(result.pinned).toBe(true);
    });

    it('should use default values', () => {
      const note = {
        content: 'Just a note',
      };

      const result = CreateNoteSchema.parse(note);
      expect(result.color).toBe('default');
      expect(result.pinned).toBe(false);
      expect(result.labels).toEqual([]);
    });
  });

  describe('CreateRoutineSchema', () => {
    it('should accept valid routine data', () => {
      const routine = {
        projectId: 'project-123',
        name: 'Daily Standup',
        cronSchedule: '0 9 * * 1-5',
      };

      const result = CreateRoutineSchema.parse(routine);
      expect(result.name).toBe('Daily Standup');
      expect(result.cronSchedule).toBe('0 9 * * 1-5');
      expect(result.enabled).toBe(true); // default
    });

    it('should accept routine with optional fields', () => {
      const routine = {
        projectId: 'project-123',
        name: 'Weekly Report',
        description: 'Generate weekly summary',
        cronSchedule: '0 10 * * 1',
        workflowId: 'workflow-456',
        enabled: false,
      };

      const result = CreateRoutineSchema.parse(routine);
      expect(result.description).toBe('Generate weekly summary');
      expect(result.workflowId).toBe('workflow-456');
      expect(result.enabled).toBe(false);
    });
  });

  describe('LogErrorSchema', () => {
    it('should accept valid error data', () => {
      const error = {
        message: 'Something went wrong',
        stack: 'Error: Something went wrong\n    at ...',
        timestamp: Date.now(),
      };

      const result = LogErrorSchema.parse(error);
      expect(result.message).toBe('Something went wrong');
    });

    it('should accept minimal error data', () => {
      const error = {
        message: 'Error occurred',
      };

      const result = LogErrorSchema.parse(error);
      expect(result.message).toBe('Error occurred');
    });
  });

  describe('ReorderItemsSchema', () => {
    it('should accept valid reorder data', () => {
      const orders = [
        { id: 'item-1', sortOrder: 0 },
        { id: 'item-2', sortOrder: 1 },
        { id: 'item-3', sortOrder: 2 },
      ];

      const result = ReorderItemsSchema.parse(orders);
      expect(result).toHaveLength(3);
      expect(result[0].id).toBe('item-1');
    });

    it('should reject invalid IDs', () => {
      const orders = [
        { id: '', sortOrder: 0 },
      ];

      expect(() => ReorderItemsSchema.parse(orders)).toThrow();
    });
  });

  describe('DateRangeSchema', () => {
    it('should accept valid date range', () => {
      const range = {
        startTime: 1704067200000,
        endTime: 1704153600000,
      };

      const result = DateRangeSchema.parse(range);
      expect(result.startTime).toBe(1704067200000);
      expect(result.endTime).toBe(1704153600000);
    });

    it('should accept optional projectId', () => {
      const range = {
        startTime: 1704067200000,
        endTime: 1704153600000,
        projectId: 'project-123',
      };

      const result = DateRangeSchema.parse(range);
      expect(result.projectId).toBe('project-123');
    });

    it('should reject negative timestamps', () => {
      const range = {
        startTime: -1,
        endTime: 1704153600000,
      };

      expect(() => DateRangeSchema.parse(range)).toThrow();
    });
  });

  describe('CreateWorkflowSchema', () => {
    it('should accept valid workflow data', () => {
      const workflow = {
        projectId: 'project-123',
        name: 'My Workflow',
        dagDefinition: {
          nodes: [
            { id: 'node-1', type: 'start', position: { x: 0, y: 0 }, data: {} },
          ],
          edges: [],
        },
      };

      const result = CreateWorkflowSchema.parse(workflow);
      expect(result.name).toBe('My Workflow');
      expect(result.enabled).toBe(true); // default
    });

    it('should validate node structure', () => {
      const workflow = {
        projectId: 'project-123',
        name: 'Test',
        dagDefinition: {
          nodes: [
            { id: 'node-1', type: 'action', position: { x: 100, y: 200 }, data: { action: 'test' } },
          ],
          edges: [
            { id: 'edge-1', source: 'node-1', target: 'node-2' },
          ],
        },
      };

      const result = CreateWorkflowSchema.parse(workflow);
      expect(result.dagDefinition.nodes).toHaveLength(1);
      expect(result.dagDefinition.edges).toHaveLength(1);
    });
  });
});

/**
 * Zod strips unknown keys, so a field missing from the schema is dropped
 * silently on any renderer-originated save (addAgentMessage /
 * addChatAgentMessage / updateMessageContentBlocks) while surviving on the
 * main-process turn path. That split is invisible until two rows are compared,
 * which is how `requestInfo` went missing and `cacheWriteTokens` was persisted
 * without ever being declared.
 *
 * The key-level agreement between the schema, MessageMetrics and StreamMetrics
 * is enforced at compile time in validation.ts. These tests cover what a type
 * cannot: that a real payload survives the parse intact.
 */
describe('MessageMetricsSchema round-trip', () => {
  const full = {
    inputTokens: 1200,
    outputTokens: 340,
    totalTokens: 1540,
    timeToComplete: 8123,
    finishReason: 'stop',
    model: 'claude-opus-5',
    cost: 0.0241,
    requestInfo: {
      contextWindow: 200000,
      sizeClass: 'large' as const,
      systemPromptTokens: 151,
      messageBudget: 150000,
      messagesTotal: 40,
      messagesSent: 12,
      toolsIncluded: true,
      toolCount: 35,
    },
    servedProvider: 'GMICloud',
    cachedTokens: 8002,
    cacheWriteTokens: 1024,
  };

  it('preserves every field it is handed', () => {
    const parsed = MessageMetricsObjectSchema.parse(full);
    expect(parsed).toEqual(full);
  });

  it('keeps requestInfo — the field a renderer save used to drop', () => {
    const parsed = MessageMetricsObjectSchema.parse(full);
    expect(parsed.requestInfo).toEqual(full.requestInfo);
    expect(parsed.requestInfo?.toolCount).toBe(35);
  });

  it('keeps cacheWriteTokens — persisted in practice, previously undeclared', () => {
    expect(MessageMetricsObjectSchema.parse(full).cacheWriteTokens).toBe(1024);
  });

  it('carries the optional debug system prompt through requestInfo', () => {
    const withPrompt = { ...full, requestInfo: { ...full.requestInfo, systemPrompt: 'you are helpful' } };
    expect(MessageMetricsObjectSchema.parse(withPrompt).requestInfo?.systemPrompt).toBe('you are helpful');
  });

  it('accepts a sparse payload — every field is optional', () => {
    expect(MessageMetricsObjectSchema.parse({})).toEqual({});
    expect(MessageMetricsObjectSchema.parse({ inputTokens: 5 })).toEqual({ inputTokens: 5 });
  });

  it('rejects a malformed requestInfo rather than dropping it', () => {
    // Failing loudly beats storing a half-populated telemetry block.
    expect(MessageMetricsObjectSchema.safeParse({
      requestInfo: { ...full.requestInfo, sizeClass: 'enormous' },
    }).success).toBe(false);
    expect(MessageMetricsObjectSchema.safeParse({
      requestInfo: { contextWindow: 200000 },
    }).success).toBe(false);
  });

  it('still strips genuinely unknown keys', () => {
    const parsed = MessageMetricsObjectSchema.parse({ inputTokens: 5, bogus: 'nope' } as never);
    expect(parsed).toEqual({ inputTokens: 5 });
  });
});
