import { useEffect, useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { useConversationsStore } from '@/stores';

interface ChatPersonaModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  chatId: string;
  /** Current persona — used to seed the textarea when the modal opens. */
  initialPersona: string;
}

/**
 * Lets the user describe the character they're playing in this chat. Only
 * surfaced for chats whose agent has the roleplay archetype. Saves to
 * `Chat.userPersona` via the chats store; `buildRoleplayNote` injects it
 * into the system prompt at request time.
 */
export function ChatPersonaModal({ open, onOpenChange, chatId, initialPersona }: ChatPersonaModalProps) {
  const [value, setValue] = useState(initialPersona);
  const [saving, setSaving] = useState(false);

  // Reseed when the modal opens (or chat changes) so we don't show stale
  // text if the user closes/reopens after editing elsewhere.
  useEffect(() => {
    if (open) setValue(initialPersona);
  }, [open, initialPersona]);

  const handleSave = async () => {
    setSaving(true);
    try {
      await useConversationsStore.getState().updateChat(chatId, { userPersona: value.trim() }, { silent: true });
      onOpenChange(false);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Your character</DialogTitle>
          <DialogDescription>
            Describe who you're playing in this scene. The agent will see this as part of its system prompt and address you as that character.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-2">
          <Label htmlFor="userPersona">Persona</Label>
          <Textarea
            id="userPersona"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="e.g. Kael, a wandering scribe with a mysterious past"
            rows={5}
            maxLength={2000}
            autoFocus
          />
          <p className="text-xs text-muted-foreground">
            Leave blank to clear. Visible only to this chat.
          </p>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>Cancel</Button>
          <Button onClick={handleSave} disabled={saving}>{saving ? 'Saving…' : 'Save'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
