import { useState } from 'react';
import { ChevronUp, ChevronDown, Search, Wrench, Puzzle, Plug, type LucideIcon } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';

interface Tool {
  name: string;
  label: string;
  category: 'discovery' | 'builtin' | 'plugin' | 'mcp';
  enabled: boolean;
}

interface ToolPanelProps {
  tools: Tool[];
  onToggleTool: (toolName: string, enabled: boolean) => void;
}

export function ToolPanel({ tools, onToggleTool }: ToolPanelProps) {
  const [isExpanded, setIsExpanded] = useState(false);

  // Group tools by category
  const toolsByCategory = tools.reduce((acc, tool) => {
    if (!acc[tool.category]) {
      acc[tool.category] = [];
    }
    acc[tool.category].push(tool);
    return acc;
  }, {} as Record<string, Tool[]>);

  const enabledCount = tools.filter(t => t.enabled).length;
  const totalCount = tools.length;

  const categoryLabels: Record<string, string> = {
    discovery: 'Discovery',
    builtin: 'Built-in',
    plugin: 'Plugin',
    mcp: 'MCP',
  };

  const categoryIcons: Record<string, LucideIcon> = {
    discovery: Search,
    builtin: Wrench,
    plugin: Puzzle,
    mcp: Plug,
  };

  return (
    <div className="border-b border-border" style={{ backgroundColor: 'var(--bg-tertiary)' }}>
      {/* Collapsed Header */}
      <div
        className="px-5 py-2 flex items-center justify-between cursor-pointer hover:bg-accent/50 transition-colors"
        onClick={() => setIsExpanded(!isExpanded)}
      >
        <div className="flex items-center gap-3">
          <span className="text-sm font-medium">Tools</span>
          <Badge variant="secondary" className="text-xs">
            {enabledCount} / {totalCount}
          </Badge>
        </div>
        <button className="text-sm text-muted-foreground hover:text-foreground">
          {isExpanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
        </button>
      </div>

      {/* Expanded Panel */}
      {isExpanded && (
        <div className="px-5 pb-4 pt-2 space-y-4 max-h-64 overflow-y-auto">
          {Object.entries(toolsByCategory).map(([category, categoryTools]) => {
            const CategoryIcon = categoryIcons[category] || Wrench;
            return (
            <div key={category}>
              <div className="flex items-center gap-2 mb-2">
                <CategoryIcon size={14} />
                <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                  {categoryLabels[category] || category}
                </h4>
                <Badge variant="outline" className="text-xs h-5">
                  {categoryTools.filter(t => t.enabled).length} / {categoryTools.length}
                </Badge>
              </div>
              <div className="grid grid-cols-2 gap-2 pl-5">
                {categoryTools.map(tool => (
                  <div key={tool.name} className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      id={`tool-panel-${tool.name}`}
                      checked={tool.enabled}
                      onChange={(e) => onToggleTool(tool.name, e.target.checked)}
                      className="w-3.5 h-3.5"
                      disabled={category === 'discovery'} // Discovery tools always enabled
                    />
                    <label
                      htmlFor={`tool-panel-${tool.name}`}
                      className={`text-sm cursor-pointer ${
                        category === 'discovery' ? 'text-muted-foreground' : 'hover:text-foreground'
                      }`}
                    >
                      {tool.label}
                    </label>
                  </div>
                ))}
              </div>
            </div>
            );
          })}
          <div className="flex items-center justify-between pt-2 border-t border-border">
            <span className="text-xs text-muted-foreground">
              Discovery tools are always enabled
            </span>
            <div className="flex gap-2">
              <Button
                variant="ghost"
                size="sm"
                className="h-7 text-xs"
                onClick={(e) => {
                  e.stopPropagation();
                  tools.filter(t => t.category !== 'discovery').forEach(tool => {
                    if (tool.enabled) {
                      onToggleTool(tool.name, false);
                    }
                  });
                }}
              >
                Disable All
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 text-xs"
                onClick={(e) => {
                  e.stopPropagation();
                  tools.forEach(tool => {
                    if (!tool.enabled) {
                      onToggleTool(tool.name, true);
                    }
                  });
                }}
              >
                Enable All
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
