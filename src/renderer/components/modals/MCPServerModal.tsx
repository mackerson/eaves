import { useState } from 'react';
import type { Agent } from '@/types';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Checkbox } from '@/components/ui/checkbox';
import { Separator } from '@/components/ui/separator';
import { Badge } from '@/components/ui/badge';
import { AppIcon } from '@/components/ui/AppIcon';

interface MCPServerModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  agent: Agent | null;
  onAddServer: (serverData: {
    name: string;
    transport: 'stdio' | 'sse' | 'http';
    enabled: boolean;
    command: string;
    args: string;
    url: string;
  }) => void;
  onToggleServer: (serverId: string, enabled: boolean) => void;
  onDeleteServer: (serverId: string) => void;
}

export function MCPServerModal({
  open,
  onOpenChange,
  agent,
  onAddServer,
  onToggleServer,
  onDeleteServer,
}: MCPServerModalProps) {
  const [newServer, setNewServer] = useState({
    name: '',
    transport: 'stdio' as 'stdio' | 'sse' | 'http',
    enabled: true,
    command: '',
    args: '',
    url: '',
  });

  const handleAddServer = () => {
    if (newServer.name &&
        ((newServer.transport === 'stdio' && newServer.command) ||
         (newServer.transport !== 'stdio' && newServer.url))) {
      onAddServer(newServer);
      setNewServer({
        name: '',
        transport: 'stdio',
        enabled: true,
        command: '',
        args: '',
        url: '',
      });
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Manage MCP Servers - {agent?.name}</DialogTitle>
        </DialogHeader>

        <div className="space-y-6">
          {/* Existing Servers */}
          <div className="space-y-3">
            <h3 className="font-semibold">Connected Servers</h3>
            {agent?.mcpServers && agent.mcpServers.length > 0 ? (
              <div className="space-y-2">
                {agent.mcpServers.map((server) => (
                  <div
                    key={server.id}
                    className="flex items-center gap-3 p-3 rounded-lg bg-accent"
                  >
                    <Checkbox
                      checked={server.enabled}
                      onCheckedChange={(checked) => onToggleServer(server.id, !!checked)}
                    />
                    <div className="flex-1 min-w-0">
                      <div className="font-medium">{server.name}</div>
                      <div className="text-sm text-muted-foreground truncate">
                        {server.transport === 'stdio' ? server.config.command : server.config.url}
                      </div>
                    </div>
                    <Badge variant="secondary">{server.transport}</Badge>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => onDeleteServer(server.id)}
                      className="h-8 w-8 p-0"
                    >
                      <AppIcon name="close" size={16} />
                    </Button>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground p-4 text-center bg-accent rounded-lg">
                No MCP servers configured yet.
              </p>
            )}
          </div>

          <Separator />

          {/* Add New Server */}
          <div className="space-y-4">
            <h3 className="font-semibold">Add New Server</h3>

            <div className="space-y-2">
              <Label htmlFor="server-name">Name</Label>
              <Input
                id="server-name"
                value={newServer.name}
                onChange={(e) => setNewServer({ ...newServer, name: e.target.value })}
                placeholder="e.g., Filesystem, Obsidian, GitHub..."
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="transport">Transport</Label>
              <Select
                value={newServer.transport}
                onValueChange={(value: 'stdio' | 'sse' | 'http') =>
                  setNewServer({ ...newServer, transport: value })
                }
              >
                <SelectTrigger id="transport">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="stdio">stdio (Local Process)</SelectItem>
                  <SelectItem value="sse">SSE (Server-Sent Events)</SelectItem>
                  <SelectItem value="http">HTTP</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {newServer.transport === 'stdio' ? (
              <>
                <div className="space-y-2">
                  <Label htmlFor="command">Command</Label>
                  <Input
                    id="command"
                    value={newServer.command}
                    onChange={(e) => setNewServer({ ...newServer, command: e.target.value })}
                    placeholder="e.g., npx, node, python..."
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="args">Arguments (space-separated)</Label>
                  <Input
                    id="args"
                    value={newServer.args}
                    onChange={(e) => setNewServer({ ...newServer, args: e.target.value })}
                    placeholder="e.g., -y @modelcontextprotocol/server-filesystem /path"
                  />
                </div>
              </>
            ) : (
              <div className="space-y-2">
                <Label htmlFor="url">URL</Label>
                <Input
                  id="url"
                  value={newServer.url}
                  onChange={(e) => setNewServer({ ...newServer, url: e.target.value })}
                  placeholder="http://localhost:3000/mcp"
                />
              </div>
            )}

            <Button onClick={handleAddServer} className="w-full">
              Add Server
            </Button>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
