import { useCallback, useState, useMemo } from 'react';
import ReactFlow, {
  Node,
  Edge,
  Controls,
  Background,
  BackgroundVariant,
  addEdge,
  Connection,
  useNodesState,
  useEdgesState,
  NodeTypes,
} from 'reactflow';
import 'reactflow/dist/style.css';
import './WorkflowEditor.css';
import { NodeInspector } from './NodeInspector';
import { HttpNode } from './nodes/HttpNode';
import { ConditionalNode } from './nodes/ConditionalNode';
import { CodeNode } from './nodes/CodeNode';
import { LoopNode } from './nodes/LoopNode';
import { DelayNode } from './nodes/DelayNode';
import { BreakNode } from './nodes/BreakNode';
import { WebScraperNode } from './nodes/WebScraperNode';
import { NoteNode, TaskNode } from './nodes/SinkNodes';
import { AgentNode } from './nodes/AgentNode';
import { GenericNode } from './nodes/GenericNode';
import { useResize } from '@/hooks/useResize';
import {
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  ChevronDown,
  Globe,
  CircleQuestionMark,
  Zap,
  Repeat,
  Timer,
  Ban,
  Bot,
  Flag,
  StickyNote,
  CheckSquare,
  CloudSun,
  Import,
  Download,
  ChartColumn,
  Save,
  Hourglass,
  Play,
  X,
} from 'lucide-react';

interface WorkflowEditorProps {
  workflowId?: string;
  initialWorkflow?: {
    name: string;
    dagDefinition: { nodes: Node[]; edges: Edge[] };
  };
  onSave?: (name: string, nodes: Node[], edges: Edge[]) => void;
}

const initialNodes: Node[] = [
  {
    id: 'start',
    type: 'start',
    data: { label: 'Start' },
    position: { x: 250, y: 50 },
  },
];

const initialEdges: Edge[] = [];

/**
 * Spread nodes that share similar Y positions so they don't overlap horizontally.
 * Ensures a minimum gap between nodes placed at similar vertical levels.
 */
function autoSpaceNodes(nodes: Node[], minGap = 220): Node[] {
  if (nodes.length <= 1) return nodes;

  // Group nodes by approximate Y band (within 60px = same row)
  const bands = new Map<number, Node[]>();
  for (const node of nodes) {
    const bandKey = Math.round(node.position.y / 60) * 60;
    const band = bands.get(bandKey) || [];
    band.push(node);
    bands.set(bandKey, band);
  }

  let needsAdjustment = false;
  const adjusted = new Map<string, { x: number; y: number }>();

  for (const band of bands.values()) {
    if (band.length <= 1) continue;
    // Sort by X position
    band.sort((a, b) => a.position.x - b.position.x);
    for (let i = 1; i < band.length; i++) {
      const gap = band[i].position.x - band[i - 1].position.x;
      if (gap < minGap) {
        needsAdjustment = true;
        // Push this node (and all after it) right
        const shift = minGap - gap;
        for (let j = i; j < band.length; j++) {
          const prev = adjusted.get(band[j].id) || { ...band[j].position };
          adjusted.set(band[j].id, { x: prev.x + shift, y: prev.y });
        }
      }
    }
  }

  if (!needsAdjustment) return nodes;
  return nodes.map(n => adjusted.has(n.id) ? { ...n, position: adjusted.get(n.id)! } : n);
}

/**
 * The "Load Demo" workflow — exported (rather than kept inline in
 * loadDemoWorkflow) so a test can assert every node it emits is one the
 * executor can actually run. It previously emitted a 'transformNode' node
 * type that existed nowhere else in the codebase (no registry entry, no
 * React Flow component, no executor handler) and a 'script' data field the
 * real `code` node never reads — WorkflowExecutor's default case used to
 * report success for unhandled types, so the demo silently no-oped instead
 * of failing. Node types here are canonical WORKFLOW_NODE_TYPES values
 * (start/end, not React Flow's built-in input/output) to match the editor's
 * own `nodeTypes` registry, which renders start/end via GenericNode.
 */
export function buildDemoWorkflow(): { nodes: Node[]; edges: Edge[] } {
  const demoNodes: Node[] = [
    {
      id: 'start',
      type: 'start',
      data: { label: 'Start' },
      position: { x: 250, y: 50 },
    },
    {
      id: 'http-weather',
      type: 'http',
      data: {
        label: 'Get Weather API Schema',
        url: 'https://api.weather.gov/openapi.json',
        method: 'GET',
        headers: { 'User-Agent': 'EavesDemoWorkflow/1.0' },
      },
      position: { x: 250, y: 150 },
    },
    {
      id: 'conditional-check',
      type: 'conditional',
      data: {
        label: 'Check Status',
        condition: '${http-weather.status}',
        operator: 'equals',
        value: '200',
      },
      position: { x: 250, y: 300 },
    },
    {
      id: 'transform-success',
      type: 'code',
      data: {
        label: 'Extract Info',
        code: 'const response = data["http-weather"];\nreturn { title: response.data.info.title, version: response.data.info.version }',
        language: 'javascript',
      },
      position: { x: 100, y: 450 },
    },
    {
      id: 'end-success',
      type: 'end',
      data: { label: 'Success' },
      position: { x: 100, y: 600 },
    },
    {
      id: 'end-fail',
      type: 'end',
      data: { label: 'Failed' },
      position: { x: 400, y: 450 },
    },
  ];

  const demoEdges: Edge[] = [
    { id: 'e1', source: 'start', target: 'http-weather' },
    { id: 'e2', source: 'http-weather', target: 'conditional-check' },
    { id: 'e3', source: 'conditional-check', sourceHandle: 'true', target: 'transform-success' },
    { id: 'e4', source: 'conditional-check', sourceHandle: 'false', target: 'end-fail' },
    { id: 'e5', source: 'transform-success', target: 'end-success' },
  ];

  return { nodes: demoNodes, edges: demoEdges };
}

export function WorkflowEditor({ workflowId: _workflowId, initialWorkflow, onSave }: WorkflowEditorProps) {
  const [nodes, setNodes, onNodesChange] = useNodesState(
    autoSpaceNodes(initialWorkflow?.dagDefinition?.nodes || initialNodes)
  );
  const [edges, setEdges, onEdgesChange] = useEdgesState(
    initialWorkflow?.dagDefinition?.edges || initialEdges
  );
  const [workflowName, setWorkflowName] = useState(initialWorkflow?.name || 'Untitled Workflow');
  const [nodeName, setNodeName] = useState('');
  const [isRunning, setIsRunning] = useState(false);
  const [executionResults, setExecutionResults] = useState<Record<string, any>>({});
  const [executionError, setExecutionError] = useState<string | null>(null);
  const [showResults, setShowResults] = useState(false);
  const [resultsCollapsed, setResultsCollapsed] = useState(false);
  const [nodesPanelCollapsed, setNodesPanelCollapsed] = useState(false);
  const { size: nodesPanelSize, isResizing: isResizingNodesPanel, startResize: startResizeNodesPanel } = useResize({
    initialSize: 300,
    minSize: 250,
    maxSize: 600,
    storageKey: 'workflow-nodes-panel-width',
  });
  const { size: resultsHeight, isResizing: isResizingResults, startResize: startResizeResults } = useResize({
    initialSize: 300,
    minSize: 150,
    maxSize: 600,
    storageKey: 'workflow-results-height',
    direction: 'vertical',
    invertDelta: true, // Bottom panel: dragging up should increase size
  });

  const nodeTypes = useMemo<NodeTypes>(() => ({
    http: HttpNode,
    conditional: ConditionalNode,
    code: CodeNode,
    loop: LoopNode,
    delay: DelayNode,
    break: BreakNode,
    webscraper: WebScraperNode,
    agent: AgentNode,
    note: NoteNode,
    task: TaskNode,
    start: GenericNode,
    action: GenericNode,
    end: GenericNode,
  }), []);

  const onConnect = useCallback(
    (params: Connection) => setEdges((eds) => addEdge(params, eds)),
    [setEdges]
  );

  const addHttpNode = () => {
    const newNode: Node = {
      id: `http-${Date.now()}`,
      type: 'http',
      data: {
        label: nodeName || 'HTTP Request',
        url: '',
        method: 'GET',
      },
      position: {
        x: Math.random() * 400 + 100,
        y: Math.random() * 300 + 150,
      },
    };
    setNodes((nds) => [...nds, newNode]);
    setNodeName('');
  };

  const addConditionalNode = () => {
    const newNode: Node = {
      id: `conditional-${Date.now()}`,
      type: 'conditional',
      data: {
        label: nodeName || 'Conditional',
        condition: '',
        operator: 'equals',
        value: '',
      },
      position: {
        x: Math.random() * 400 + 100,
        y: Math.random() * 300 + 150,
      },
    };
    setNodes((nds) => [...nds, newNode]);
    setNodeName('');
  };

  const addCodeNode = () => {
    const newNode: Node = {
      id: `code-${Date.now()}`,
      type: 'code',
      data: {
        label: nodeName || 'Code',
        code: '',
        language: 'javascript',
      },
      position: {
        x: Math.random() * 400 + 100,
        y: Math.random() * 300 + 150,
      },
    };
    setNodes((nds) => [...nds, newNode]);
    setNodeName('');
  };

  const addLoopNode = () => {
    const newNode: Node = {
      id: `loop-${Date.now()}`,
      type: 'loop',
      data: {
        label: nodeName || 'Loop',
        collection: '',
        variable: 'item',
      },
      position: {
        x: Math.random() * 400 + 100,
        y: Math.random() * 300 + 150,
      },
    };
    setNodes((nds) => [...nds, newNode]);
    setNodeName('');
  };

  const addDelayNode = () => {
    const newNode: Node = {
      id: `delay-${Date.now()}`,
      type: 'delay',
      data: {
        label: nodeName || 'Delay',
        duration: 5,
        unit: 'seconds',
      },
      position: {
        x: Math.random() * 400 + 100,
        y: Math.random() * 300 + 150,
      },
    };
    setNodes((nds) => [...nds, newNode]);
    setNodeName('');
  };

  const addBreakNode = () => {
    const newNode: Node = {
      id: `break-${Date.now()}`,
      type: 'break',
      data: {
        label: nodeName || 'Break',
        condition: '',
      },
      position: {
        x: Math.random() * 400 + 100,
        y: Math.random() * 300 + 150,
      },
    };
    setNodes((nds) => [...nds, newNode]);
    setNodeName('');
  };

  /**
   * Sinks all take a `content` body, so one builder covers them. They are the
   * only node types that deliver anything out of the run — without one, a
   * workflow computes an answer into its own context and stops there.
   */
  const addSinkNode = (type: 'note' | 'task', defaultLabel: string) => {
    const newNode: Node = {
      id: `${type}-${Date.now()}`,
      type,
      data: { label: nodeName || defaultLabel, content: '' },
      position: {
        x: Math.random() * 400 + 100,
        y: Math.random() * 300 + 150,
      },
    };
    setNodes((nds) => [...nds, newNode]);
    setNodeName('');
  };

  const addWebScraperNode = () => {
    const newNode: Node = {
      id: `webScraper-${Date.now()}`,
      type: 'webscraper',
      data: {
        label: nodeName || 'Web Scraper',
        url: '',
        timeout: 10000,
      },
      position: {
        x: Math.random() * 400 + 100,
        y: Math.random() * 300 + 150,
      },
    };
    setNodes((nds) => [...nds, newNode]);
    setNodeName('');
  };

  const addAgentNode = () => {
    const newNode: Node = {
      id: `agent-${Date.now()}`,
      type: 'agent',
      data: {
        label: nodeName || 'Agent',
        agentId: '',
        prompt: '',
      },
      position: {
        x: Math.random() * 400 + 100,
        y: Math.random() * 300 + 150,
      },
    };
    setNodes((nds) => [...nds, newNode]);
    setNodeName('');
  };

  const addEndNode = () => {
    const newNode: Node = {
      id: `end-${Date.now()}`,
      type: 'end',
      data: { label: 'End' },
      position: {
        x: 250,
        y: 400,
      },
    };
    setNodes((nds) => [...nds, newNode]);
  };

  const handleSave = () => {
    if (onSave) {
      onSave(workflowName, nodes, edges);
    }
  };

  const exportWorkflow = () => {
    const workflow = {
      nodes,
      edges,
      version: '1.0',
      exportedAt: Date.now(),
    };
    const blob = new Blob([JSON.stringify(workflow, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `workflow-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const importWorkflow = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'application/json';
    input.onchange = (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = (event) => {
        try {
          const workflow = JSON.parse(event.target?.result as string);
          setNodes(workflow.nodes || []);
          setEdges(workflow.edges || []);
        } catch (error) {
          setExecutionError('Failed to import workflow: Invalid JSON');
          setExecutionResults({});
          setShowResults(true);
        }
      };
      reader.readAsText(file);
    };
    input.click();
  };

  const loadDemoWorkflow = () => {
    const { nodes: demoNodes, edges: demoEdges } = buildDemoWorkflow();
    setNodes(demoNodes);
    setEdges(demoEdges);
  };

  const runWorkflow = async () => {
    if (!_workflowId) {
      setExecutionError('Save the workflow before running it');
      setExecutionResults({});
      setShowResults(true);
      return;
    }

    setIsRunning(true);
    setExecutionResults({});
    setExecutionError(null);

    try {
      const result = await window.electron.executeWorkflow(_workflowId);

      setExecutionResults(result.outputs || {});
      setExecutionError(result.success ? null : (result.error || 'Unknown error'));
      setShowResults(true);
    } catch (error) {
      console.error('Workflow execution error:', error);
      setExecutionError(error instanceof Error ? error.message : 'Unknown error');
      setShowResults(true);
    } finally {
      setIsRunning(false);
    }
  };

  // Derived rather than tracked separately: ReactFlow owns selection, and a
  // second source of truth would drift the moment a node is deleted.
  const selectedNode = nodes.find((node) => node.selected) ?? null;

  return (
    <div className="workflow-editor">
      {/* Nodes Sidebar */}
      <div
        className={`workflow-nodes-sidebar ${nodesPanelCollapsed ? 'collapsed' : ''}`}
        style={{ width: nodesPanelCollapsed ? '0px' : `${nodesPanelSize}px` }}
      >
        <div className="nodes-sidebar-header">
          <button
            className="sidebar-collapse-btn"
            onClick={() => setNodesPanelCollapsed(!nodesPanelCollapsed)}
            title={nodesPanelCollapsed ? 'Expand panel' : 'Collapse panel'}
          >
            {nodesPanelCollapsed ? <ChevronLeft size={14} /> : <ChevronRight size={14} />}
          </button>
          <input
            type="text"
            value={workflowName}
            onChange={(e) => setWorkflowName(e.target.value)}
            className="workflow-name-input"
            placeholder="Workflow name..."
          />
        </div>
        <div className="nodes-sidebar-content">
          {selectedNode ? (
            <>
              <button
                className="add-node-btn"
                onClick={() => setNodes((ns) => ns.map((n) => ({ ...n, selected: false })))}
                style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--spacing-xs)' }}
              >
                <ChevronLeft size={14} /> Back to nodes
              </button>
              <NodeInspector node={selectedNode} />
            </>
          ) : (
          <>
          <input
            type="text"
            placeholder="Node name..."
            value={nodeName}
            onChange={(e) => setNodeName(e.target.value)}
            className="node-name-input"
          />
          <div className="nodes-section">
            <h4 className="nodes-section-title">Nodes</h4>
            <button onClick={addHttpNode} className="add-node-btn" style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--spacing-xs)' }}>
              <Globe size={14} /> HTTP Request
            </button>
            <button onClick={addConditionalNode} className="add-node-btn" style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--spacing-xs)' }}>
              <CircleQuestionMark size={14} /> Conditional
            </button>
            <button onClick={addCodeNode} className="add-node-btn" style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--spacing-xs)' }}>
              <Zap size={14} /> Code
            </button>
            <button onClick={addLoopNode} className="add-node-btn" style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--spacing-xs)' }}>
              <Repeat size={14} /> Loop
            </button>
            <button onClick={addDelayNode} className="add-node-btn" style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--spacing-xs)' }}>
              <Timer size={14} /> Delay
            </button>
            <button onClick={addBreakNode} className="add-node-btn" style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--spacing-xs)' }}>
              <Ban size={14} /> Break
            </button>
            <button onClick={addWebScraperNode} className="add-node-btn" style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--spacing-xs)' }}>
              <Globe size={14} /> Web Scraper
            </button>
            <button onClick={addAgentNode} className="add-node-btn" style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--spacing-xs)' }}>
              <Bot size={14} /> Agent
            </button>
            <button onClick={() => addSinkNode('note', 'Save note')} className="add-node-btn" style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--spacing-xs)' }}>
              <StickyNote size={14} /> Save Note
            </button>
            <button onClick={() => addSinkNode('task', 'Create task')} className="add-node-btn" style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--spacing-xs)' }}>
              <CheckSquare size={14} /> Create Task
            </button>
            <button onClick={addEndNode} className="add-node-btn" style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--spacing-xs)' }}>
              <Flag size={14} /> End Node
            </button>
          </div>
          <div className="nodes-section">
            <h4 className="nodes-section-title">Actions</h4>
            <button
              onClick={runWorkflow}
              className="add-node-btn"
              disabled={isRunning}
              style={{ opacity: isRunning ? 0.5 : 1, display: 'inline-flex', alignItems: 'center', gap: 'var(--spacing-xs)' }}
            >
              {isRunning ? <><Hourglass size={14} /> Running...</> : <><Play size={14} /> Run Workflow</>}
            </button>
            <button onClick={loadDemoWorkflow} className="add-node-btn" style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--spacing-xs)' }}>
              <CloudSun size={14} /> Load Demo (Weather API)
            </button>
            <button onClick={importWorkflow} className="add-node-btn" style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--spacing-xs)' }}>
              <Import size={14} /> Import Workflow
            </button>
            <button onClick={exportWorkflow} className="add-node-btn" style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--spacing-xs)' }}>
              <Download size={14} /> Export Workflow
            </button>
            {Object.keys(executionResults).length > 0 && (
              <button
                onClick={() => setShowResults(!showResults)}
                className="add-node-btn"
                style={{
                  borderColor: showResults ? 'var(--accent-primary)' : 'var(--border-secondary)',
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 'var(--spacing-xs)',
                }}
              >
                <ChartColumn size={14} /> {showResults ? 'Hide Results' : 'Show Results'}
              </button>
            )}
          </div>
          </>
          )}
        </div>
        <div className="nodes-sidebar-footer">
          <button onClick={handleSave} className="save-workflow-btn" style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 'var(--spacing-xs)' }}>
            <Save size={14} /> Save Workflow
          </button>
        </div>
        {!nodesPanelCollapsed && (
          <div
            className="sidebar-resize-handle sidebar-resize-handle-left"
            onMouseDown={startResizeNodesPanel}
            style={{ cursor: isResizingNodesPanel ? 'col-resize' : 'col-resize' }}
          />
        )}
      </div>

      {nodesPanelCollapsed && (
        <button
          className="workflow-sidebar-expand-btn"
          onClick={() => setNodesPanelCollapsed(false)}
          title="Expand nodes panel"
        >
          <ChevronRight size={14} />
        </button>
      )}

      <div className="workflow-canvas" style={{ marginRight: nodesPanelCollapsed ? '0' : `${nodesPanelSize}px` }}>
        <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        nodeTypes={nodeTypes}
        fitView
      >
        <Controls />
        <Background variant={BackgroundVariant.Dots} gap={12} size={1} />
        </ReactFlow>

        {/* Full-width Execution Results Panel */}
        {showResults && (executionError || Object.keys(executionResults).length > 0) && (
        <div
          className={`execution-results-overlay ${resultsCollapsed ? 'collapsed' : ''}`}
          style={{ height: resultsCollapsed ? '40px' : `${resultsHeight}px` }}
        >
          {!resultsCollapsed && (
            <div
              className="execution-results-resize-handle"
              onMouseDown={startResizeResults}
              style={{ cursor: isResizingResults ? 'row-resize' : 'row-resize' }}
            />
          )}
          <div className="execution-results-header">
            <h3 className="panel-title">
              {executionError ? 'Execution Failed' : 'Execution Results'}
            </h3>
            <div style={{ display: 'flex', gap: 'var(--spacing-sm)' }}>
              <button
                onClick={() => setResultsCollapsed(!resultsCollapsed)}
                className="add-node-btn"
                style={{ padding: '4px 8px', fontSize: '12px' }}
                title={resultsCollapsed ? 'Expand results' : 'Collapse results'}
              >
                {resultsCollapsed ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
              </button>
              <button
                onClick={() => { setExecutionResults({}); setExecutionError(null); }}
                className="add-node-btn"
                style={{ padding: '4px 8px', fontSize: '12px' }}
                title="Clear Results"
              >
                Clear
              </button>
              <button
                onClick={() => setShowResults(false)}
                className="add-node-btn"
                style={{ padding: '4px 8px', fontSize: '12px' }}
                title="Close Results"
              >
                <X size={14} />
              </button>
            </div>
          </div>
          <div className="execution-results-content">
            {executionError && (
              <div className="execution-error-banner">
                <span className="execution-error-label">Error</span>
                <pre className="execution-error-message">{executionError}</pre>
              </div>
            )}
            {Object.keys(executionResults).length > 0 && (
            <table className="execution-results-table">
              <thead>
                <tr>
                  <th style={{ width: '10px' }}></th>
                  <th style={{ width: '180px' }}>Node ID</th>
                  <th style={{ width: '100px' }}>Status</th>
                  <th>Result</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(executionResults).map(([nodeId, result]) => {
                  const status = result?.error ? 'error' : result?.skipped ? 'skipped' : 'success';
                  const statusColor = result?.error ? '#f56565' : result?.skipped ? '#ed8936' : '#48bb78';

                  return (
                    <tr key={nodeId}>
                      <td style={{
                        padding: 0,
                        borderLeft: `4px solid ${statusColor}`,
                      }}></td>
                      <td className="node-id-cell">{nodeId}</td>
                      <td>
                        <span
                          className="status-badge"
                          style={{
                            backgroundColor: `${statusColor}20`,
                            color: statusColor,
                            border: `1px solid ${statusColor}40`,
                          }}
                        >
                          {status}
                        </span>
                      </td>
                      <td className="result-cell">
                        <pre className="result-data">
                          {JSON.stringify(result, null, 2)}
                        </pre>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            )}
          </div>
        </div>
        )}
      </div>
    </div>
  );
}
