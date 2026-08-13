import { useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { useProjectStore } from '@/stores';

interface EventModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function EventModal({ open, onOpenChange }: EventModalProps) {
  const { addEvent } = useProjectStore();
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [startDate, setStartDate] = useState('');
  const [startTime, setStartTime] = useState('09:00');
  const [endDate, setEndDate] = useState('');
  const [endTime, setEndTime] = useState('10:00');

  const handleSubmit = async () => {
    if (!title.trim() || !startDate) return;

    // Parse date/time strings to Unix timestamps
    const startDateTime = `${startDate}T${startTime}`;
    const startTimestamp = new Date(startDateTime).getTime();

    // Use end date/time or default to 1 hour after start
    const endDateTime = endDate ? `${endDate}T${endTime}` : '';
    const endTimestamp = endDateTime
      ? new Date(endDateTime).getTime()
      : startTimestamp + 3600000; // +1 hour

    await addEvent({
      title: title.trim(),
      description: description.trim() || undefined,
      start: startTimestamp,
      end: endTimestamp,
    });

    resetForm();
    onOpenChange(false);
  };

  const resetForm = () => {
    setTitle('');
    setDescription('');
    setStartDate('');
    setStartTime('09:00');
    setEndDate('');
    setEndTime('10:00');
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Add Event</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-4 max-h-[60vh] overflow-y-auto">
          <div className="space-y-2">
            <Label htmlFor="event-title">Title *</Label>
            <Input
              id="event-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Enter event title"
              autoFocus
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="event-description">Description</Label>
            <Textarea
              id="event-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Enter event description (optional)"
              rows={3}
            />
          </div>

          {/*
            No Type selector. It offered Event / Milestone / Deadline and
            passed the choice to addEvent, which dropped it —
            EventRepository.create hard-writes `type = 'event'` — so the
            calendar showed the chosen subtype until the next reload and then
            silently flipped it back.

            Milestones and deadlines are not a flag on this shape: they are
            separate subtypes of the events table with their own repositories
            and their own required fields (status). Creating them from here is
            a feature, not a fix, so stop advertising it. The calendar still
            renders both, because anything that does create them writes the
            real `type` and getEventsByProjectId returns it unfiltered.
          */}
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="event-start-date">Start Date *</Label>
              <Input
                id="event-start-date"
                type="date"
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="event-start-time">Start Time</Label>
              <Input
                id="event-start-time"
                type="time"
                value={startTime}
                onChange={(e) => setStartTime(e.target.value)}
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="event-end-date">End Date</Label>
              <Input
                id="event-end-date"
                type="date"
                value={endDate}
                onChange={(e) => setEndDate(e.target.value)}
                placeholder="Optional"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="event-end-time">End Time</Label>
              <Input
                id="event-end-time"
                type="time"
                value={endTime}
                onChange={(e) => setEndTime(e.target.value)}
              />
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => { resetForm(); onOpenChange(false); }}>Cancel</Button>
          <Button onClick={handleSubmit} disabled={!title.trim() || !startDate}>Add Event</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
