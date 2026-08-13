// react-big-calendar ships no bundled types and @types/react-big-calendar is
// not installed. Minimal ambient shim covering only the surface CalendarView
// uses. Kept as a standalone ambient (non-module) file so it suppresses TS7016.
declare module 'react-big-calendar' {
  import type { ComponentType, CSSProperties } from 'react';

  export interface Event {
    title?: string;
    start?: Date;
    end?: Date;
    allDay?: boolean;
    resource?: any;
  }

  export interface DateLocalizer {}

  export function dateFnsLocalizer(config: {
    format: (...args: any[]) => string;
    parse: (...args: any[]) => Date;
    startOfWeek: (...args: any[]) => Date;
    getDay: (date: Date) => number;
    locales: Record<string, unknown>;
  }): DateLocalizer;

  export interface CalendarProps {
    localizer: DateLocalizer;
    events?: Event[];
    startAccessor?: string | ((event: Event) => Date);
    endAccessor?: string | ((event: Event) => Date);
    style?: CSSProperties;
    eventPropGetter?: (event: Event) => { style?: CSSProperties };
    views?: string[];
    defaultView?: string;
    onSelectEvent?: (event: Event) => void;
  }

  export const Calendar: ComponentType<CalendarProps>;
}

declare module 'react-big-calendar/lib/css/react-big-calendar.css';
