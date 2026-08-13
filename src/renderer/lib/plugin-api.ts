/**
 * Plugin API
 * Exposes app dependencies and utilities to dynamically loaded plugins
 */

import React from 'react';
import ReactDOM from 'react-dom';
import * as ReactDOMClient from 'react-dom/client';
import * as jsxRuntime from 'react/jsx-runtime';

// UI Components
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Select } from '@/components/ui/select';
import { Checkbox } from '@/components/ui/checkbox';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { Dialog } from '@/components/ui/dialog';
import { Tabs } from '@/components/ui/tabs';
import { AppIcon } from '@/components/ui/AppIcon';
import { Icon } from '@/components/ui/icon';

// Stores
import { useAgentStore } from '@/stores/useAgentStore';
import { useConversationsStore } from '@/stores';
import { useUIStore } from '@/stores/useUIStore';
import { useProjectStore } from '@/stores/useProjectStore';

// Utilities
import { cn } from '@/lib/utils';

/**
 * Plugin API Interface
 * Defines what plugins can access from the host application
 */
export interface PluginAPI {
  // React core
  React: typeof React & { jsxRuntime: typeof jsxRuntime };
  ReactDOM: typeof ReactDOM;
  ReactDOMClient: typeof ReactDOMClient;

  // UI Components
  UI: {
    Button: typeof Button;
    Input: typeof Input;
    Card: typeof Card;
    CardHeader: typeof CardHeader;
    CardTitle: typeof CardTitle;
    CardDescription: typeof CardDescription;
    CardContent: typeof CardContent;
    CardFooter: typeof CardFooter;
    Label: typeof Label;
    Textarea: typeof Textarea;
    Select: typeof Select;
    Checkbox: typeof Checkbox;
    Badge: typeof Badge;
    Separator: typeof Separator;
    Dialog: typeof Dialog;
    Tabs: typeof Tabs;
    AppIcon: typeof AppIcon;
    Icon: typeof Icon;
  };

  // Stores (Zustand hooks)
  stores: {
    useAgentStore: typeof useAgentStore;
    /** The unified conversations store — exposed under its historical
     *  plugin-facing name; the chat-surface field names are unchanged. */
    useChatsStore: typeof useConversationsStore;
    useUIStore: typeof useUIStore;
    useProjectStore: typeof useProjectStore;
  };

  // Utilities
  utils: {
    cn: typeof cn;
  };

  // Electron IPC (if available)
  electron?: {
    send?: (channel: string, data: any) => void;
    invoke?: (channel: string, data?: any) => Promise<any>;
    on?: (channel: string, callback: (...args: any[]) => void) => () => void;
  };
}

/**
 * Initialize the Plugin API
 * Call this in App.tsx before loading any plugins
 */
export function initializePluginAPI() {
  // Create the global API object
  const api: PluginAPI = {
    React: Object.assign(React, { jsxRuntime }),
    ReactDOM,
    ReactDOMClient,
    UI: {
      Button,
      Input,
      Card,
      CardHeader,
      CardTitle,
      CardDescription,
      CardContent,
      CardFooter,
      Label,
      Textarea,
      Select,
      Checkbox,
      Badge,
      Separator,
      Dialog,
      Tabs,
      AppIcon,
      Icon,
    },
    stores: {
      useAgentStore,
      useChatsStore: useConversationsStore,
      useUIStore,
      useProjectStore,
    },
    utils: {
      cn,
    },
    electron: (window as any).electron,
  };

  // Expose via window
  (window as any).EnclaveAPI = api;

}

// TypeScript declaration for global window
declare global {
  interface Window {
    EnclaveAPI: PluginAPI;
  }
}
