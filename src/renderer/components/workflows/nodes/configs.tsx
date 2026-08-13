/**
 * Per-node-type config forms.
 *
 * Rendered in two places from one definition: inline inside the node on the
 * canvas, and full-height in the inspector panel. Keeping them here rather than
 * inside each node component is what lets the inspector exist without a second
 * copy of every field drifting out of sync.
 */

import { useAgentStore } from '@/stores';
import {
  NodeCheckboxField,
  NodeCodeField,
  NodeNumberField,
  NodeSelectField,
  NodeTextAreaField,
  NodeTextField,
  useNodeFieldWriter,
} from './fields';

export interface NodeConfigProps {
  id: string;
  data: Record<string, any>;
}

export function AgentNodeConfig({ id, data }: NodeConfigProps) {
  const agents = useAgentStore((s) => s.agents);
  const write = useNodeFieldWriter(id);

  return (
    <>
      <NodeSelectField
        label="Agent"
        value={data.agentId || ''}
        onChange={(value) => write('agentId', value)}
        options={[
          { value: '', label: 'System Default' },
          ...agents.map((agent) => ({ value: agent.id, label: agent.name })),
        ]}
      />
      <NodeTextAreaField
        label="Prompt"
        title="Prompt"
        value={data.prompt || ''}
        onChange={(value) => write('prompt', value)}
        placeholder={'Summarize the following data:\n${previous-node-id}'}
        rows={5}
      />
      <NodeTextAreaField
        label="System Prompt Override"
        title="System Prompt Override"
        value={data.systemPromptOverride || ''}
        onChange={(value) => write('systemPromptOverride', value)}
        placeholder="Leave empty to use agent's default"
        rows={3}
      />
    </>
  );
}

export function CodeNodeConfig({ id, data }: NodeConfigProps) {
  const write = useNodeFieldWriter(id);
  const language = data.language ?? 'javascript';
  // Saved graphs store the source under either `code` or `script`; read both.
  const code = data.code ?? data.script ?? '';

  return (
    <>
      <NodeSelectField
        label="Language"
        value={language}
        onChange={(value) => write('language', value)}
        options={[
          { value: 'javascript', label: 'JavaScript' },
          { value: 'python', label: 'Python' },
          { value: 'shell', label: 'Shell' },
        ]}
      />
      <NodeCodeField
        label="Code"
        title={`Code — ${language}`}
        value={code}
        onChange={(value) => write('code', value)}
        language={language === 'shell' ? 'bash' : language}
      />
      <NodeNumberField
        label="Timeout (ms)"
        value={data.timeout ?? 30000}
        onChange={(value) => write('timeout', value)}
        min={100}
      />
    </>
  );
}

export function ConditionalNodeConfig({ id, data }: NodeConfigProps) {
  const write = useNodeFieldWriter(id);

  return (
    <>
      <NodeTextField
        label="Field/Variable"
        value={data.condition || ''}
        onChange={(value) => write('condition', value)}
        placeholder="response.status"
      />
      <NodeSelectField
        label="Operator"
        value={data.operator || 'equals'}
        onChange={(value) => write('operator', value)}
        options={[
          { value: 'equals', label: 'Equals' },
          { value: 'notEquals', label: 'Not Equals' },
          { value: 'contains', label: 'Contains' },
          { value: 'greaterThan', label: 'Greater Than' },
          { value: 'lessThan', label: 'Less Than' },
        ]}
      />
      <NodeTextField
        label="Value"
        value={data.value || ''}
        onChange={(value) => write('value', value)}
        placeholder="200"
      />
    </>
  );
}

export function DelayNodeConfig({ id, data }: NodeConfigProps) {
  const write = useNodeFieldWriter(id);

  return (
    <>
      <NodeNumberField
        label="Duration"
        value={data.duration ?? 5}
        onChange={(value) => write('duration', value)}
        min={1}
      />
      <NodeSelectField
        label="Unit"
        value={data.unit || 'seconds'}
        onChange={(value) => write('unit', value)}
        options={[
          { value: 'seconds', label: 'Seconds' },
          { value: 'minutes', label: 'Minutes' },
          { value: 'hours', label: 'Hours' },
        ]}
      />
    </>
  );
}

export function HttpNodeConfig({ id, data }: NodeConfigProps) {
  const write = useNodeFieldWriter(id);

  return (
    <>
      <NodeSelectField
        label="Method"
        value={data.method || 'GET'}
        onChange={(value) => write('method', value)}
        options={['GET', 'POST', 'PUT', 'DELETE', 'PATCH'].map((m) => ({ value: m, label: m }))}
      />
      <NodeTextField
        label="URL"
        value={data.url || ''}
        onChange={(value) => write('url', value)}
        placeholder="https://api.example.com/..."
      />
      <NodeCodeField
        label="Headers"
        title="Headers"
        value={
          typeof data.headers === 'string'
            ? data.headers
            : JSON.stringify(data.headers || {}, null, 2)
        }
        onChange={(value) => write('headers', value)}
        language="json"
        rows={3}
      />
      <NodeTextAreaField
        label="Body"
        title="Body"
        value={data.body || ''}
        onChange={(value) => write('body', value)}
        placeholder={'{"key": "value"}'}
        rows={4}
      />
    </>
  );
}

export function LoopNodeConfig({ id, data }: NodeConfigProps) {
  const write = useNodeFieldWriter(id);

  return (
    <>
      <NodeTextField
        label="Collection/Array"
        value={data.collection || ''}
        onChange={(value) => write('collection', value)}
        placeholder="$searchResults"
      />
      <NodeTextField
        label="Item Variable"
        value={data.variable ?? 'item'}
        onChange={(value) => write('variable', value)}
        placeholder="item"
      />
      <NodeNumberField
        label="Max Iterations"
        value={data.maxIterations ?? 10}
        onChange={(value) => write('maxIterations', value)}
        min={1}
        max={100}
      />
      <NodeCheckboxField
        label="Collect Results"
        checked={data.collectResults !== false}
        onChange={(checked) => write('collectResults', checked)}
      />
    </>
  );
}

export function BreakNodeConfig({ id, data }: NodeConfigProps) {
  const write = useNodeFieldWriter(id);

  return (
    <NodeTextField
      label="Break Condition"
      value={data.condition || ''}
      onChange={(value) => write('condition', value)}
      placeholder="$score > 0.8"
      help="Exits the current loop when condition is truthy"
    />
  );
}

export function WebScraperNodeConfig({ id, data }: NodeConfigProps) {
  const write = useNodeFieldWriter(id);

  return (
    <>
      <NodeTextField
        label="URL"
        value={data.url || ''}
        onChange={(value) => write('url', value)}
        placeholder="$item.url"
      />
      <NodeTextField
        label="CSS Selector (optional)"
        value={data.selector || ''}
        onChange={(value) => write('selector', value)}
        placeholder=".article-content"
      />
      <NodeNumberField
        label="Timeout (ms)"
        value={data.timeout ?? 10000}
        onChange={(value) => write('timeout', value)}
        min={1000}
        max={60000}
      />
    </>
  );
}

/**
 * Fallback for node types without a bespoke form (including `action` and
 * anything a future plugin introduces): every data key gets a text field, so an
 * unknown node is still editable rather than read-only.
 */
export function GenericNodeConfig({ id, data }: NodeConfigProps) {
  const write = useNodeFieldWriter(id);
  const entries = Object.entries(data).filter(([key]) => key !== 'label');

  if (entries.length === 0) {
    return <div className="node-help-text">No configuration for this node type.</div>;
  }

  return (
    <>
      {entries.map(([key, value]) => (
        <NodeTextField
          key={key}
          label={key}
          value={typeof value === 'string' ? value : JSON.stringify(value)}
          onChange={(next) => write(key, next)}
        />
      ))}
    </>
  );
}

/** Registry used by the inspector to render config for any selected node. */
export const NODE_CONFIGS: Record<string, (props: NodeConfigProps) => JSX.Element> = {
  agent: AgentNodeConfig,
  code: CodeNodeConfig,
  conditional: ConditionalNodeConfig,
  delay: DelayNodeConfig,
  http: HttpNodeConfig,
  loop: LoopNodeConfig,
  break: BreakNodeConfig,
  webscraper: WebScraperNodeConfig,
};

export function configForNodeType(type?: string) {
  return (type && NODE_CONFIGS[type]) || GenericNodeConfig;
}
