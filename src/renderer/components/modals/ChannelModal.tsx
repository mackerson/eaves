import { useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ChannelNameSchema, validateWithSchema } from '@shared/validation';
import { useToastStore } from '@/stores';

interface ChannelModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreateChannel: (name: string) => void;
}

export function ChannelModal({ open, onOpenChange, onCreateChannel }: ChannelModalProps) {
  const showToast = useToastStore((state) => state.showToast);
  const [channelName, setChannelName] = useState('');

  const handleSubmit = () => {
    const validation = validateWithSchema(ChannelNameSchema, channelName);

    if (!validation.success) {
      showToast(validation.error, 'warning');
      return;
    }

    onCreateChannel(validation.data);
    setChannelName('');
    onOpenChange(false);
  };

  const handleKeyPress = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      handleSubmit();
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Create Channel</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-4">
          <div className="space-y-2">
            <Label htmlFor="channel-name">Channel Name</Label>
            <Input
              id="channel-name"
              value={channelName}
              onChange={(e) => setChannelName(e.target.value)}
              onKeyPress={handleKeyPress}
              placeholder="e.g. team-chat"
              autoFocus
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={handleSubmit} disabled={!channelName.trim()}>
            Create Channel
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
