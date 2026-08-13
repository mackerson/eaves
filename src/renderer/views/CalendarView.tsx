import { useMemo, useEffect } from 'react';
import { Calendar, dateFnsLocalizer, Event as BigCalendarEvent } from 'react-big-calendar';
import { format, parse, startOfWeek, getDay } from 'date-fns';
import { enUS } from 'date-fns/locale/en-US';
import { useProjectStore } from '@/stores';
import { EventModal } from '@/components/modals/EventModal';
import 'react-big-calendar/lib/css/react-big-calendar.css';
import './CalendarView.css';

const locales = { 'en-US': enUS };
const localizer = dateFnsLocalizer({ format, parse, startOfWeek, getDay, locales });

export function CalendarView() {
  const { events, tasks, routines, loadRoutines, showEventModal, openEventModal, closeEventModal } = useProjectStore();

  // Load routines when component mounts
  useEffect(() => {
    loadRoutines();
  }, [loadRoutines]);

  // Convert our events, tasks, and routines to BigCalendar format
  const calendarEvents = useMemo(() => {
    // Regular events
    const regularEvents = events.map((event) => ({
      title: event.title,
      start: new Date(event.start),
      end: new Date(event.end),
      resource: { id: event.id, type: event.type, description: event.description },
    }));

    // Tasks with due dates
    const taskEvents = tasks
      .filter((task) => task.dueDate)
      .map((task) => {
        const dueDate = new Date(task.dueDate!);
        // If task has a start date, show as a range; otherwise show as a point event
        const startDate = task.startDate ? new Date(task.startDate) : dueDate;
        // estimatedDuration is MINUTES — see shared/types.ts, the form label,
        // and TasksView's formatDuration. This block treated it as
        // milliseconds (the `60 * 60 * 1000` fallback is the tell), so a
        // 30-minute task rendered as a 30-millisecond sliver.
        const durationMs = (task.estimatedDuration ?? 60) * 60 * 1000;
        const endDate = task.startDate ? dueDate : new Date(dueDate.getTime() + durationMs);

        return {
          title: `${task.completed ? '✓ ' : '☐ '}${task.content}`,
          start: startDate,
          end: endDate,
          resource: {
            id: task.id,
            type: 'task',
            completed: task.completed,
            priority: task.priority,
          },
        };
      });

    // Routine events (show next run for enabled routines)
    const routineEvents = routines
      .filter((routine) => routine.enabled && routine.nextRun)
      .map((routine) => {
        const nextRun = new Date(routine.nextRun!);
        // Create a 30-minute block for routine display
        const endTime = new Date(nextRun.getTime() + 30 * 60 * 1000);
        return {
          title: `⟳ ${routine.name}`,
          start: nextRun,
          end: endTime,
          resource: {
            id: routine.id,
            type: 'routine',
            description: routine.description || `Scheduled: ${routine.cronSchedule}`,
            isRoutine: true,
          },
        };
      });

    return [...regularEvents, ...taskEvents, ...routineEvents];
  }, [events, tasks, routines]);

  const eventStyleGetter = (event: BigCalendarEvent) => {
    const type = event.resource?.type || 'event';
    const isCompleted = event.resource?.completed;

    const colorMap: Record<string, string> = {
      event: 'var(--accent-primary)',
      milestone: '#8b5cf6',
      deadline: '#f59e0b',
      routine: '#10b981', // Green for routines
      task: '#06b6d4', // Cyan for tasks
    };

    const style: React.CSSProperties = {
      backgroundColor: colorMap[type] || colorMap.event,
      borderRadius: '4px',
      opacity: isCompleted ? 0.5 : 0.8,
      color: 'white',
      border: '0px',
      display: 'block',
      textDecoration: isCompleted ? 'line-through' : 'none',
    };

    return { style };
  };

  return (
    <div className="calendar-view">
      <div className="calendar-header">
        <h1 className="text-3xl font-bold">Calendar</h1>
        <button className="add-event-btn" onClick={openEventModal}>
          + Add Event
        </button>
      </div>

      <div className="calendar-container">
        <Calendar
          localizer={localizer}
          events={calendarEvents}
          startAccessor="start"
          endAccessor="end"
          style={{ height: '100%' }}
          eventPropGetter={eventStyleGetter}
          views={['month', 'week', 'day', 'agenda']}
          defaultView="month"
        />
      </div>

      <div className="calendar-legend">
        <div className="legend-item">
          <div className="legend-dot" style={{ backgroundColor: 'var(--accent-primary)' }} />
          <span>Events</span>
        </div>
        <div className="legend-item">
          <div className="legend-dot" style={{ backgroundColor: '#06b6d4' }} />
          <span>Tasks</span>
        </div>
        <div className="legend-item">
          <div className="legend-dot" style={{ backgroundColor: '#8b5cf6' }} />
          <span>Milestones</span>
        </div>
        <div className="legend-item">
          <div className="legend-dot" style={{ backgroundColor: '#f59e0b' }} />
          <span>Deadlines</span>
        </div>
        <div className="legend-item">
          <div className="legend-dot" style={{ backgroundColor: '#10b981' }} />
          <span>Routines</span>
        </div>
      </div>

      <EventModal open={showEventModal} onOpenChange={closeEventModal} />
    </div>
  );
}
