import React from 'react';
import ReactDOM from 'react-dom/client';
import AppWrapper from './AppWrapper';
import './index.css';

// Helper to safely show error in loading div
function showLoadingError(message: string) {
  const loadingEl = document.getElementById('app-loading');
  if (!loadingEl) return;

  // Clear existing content
  loadingEl.textContent = '';

  // Create error UI using safe DOM methods
  const container = document.createElement('div');
  container.style.cssText = 'text-align: center; padding: 20px;';

  const heading = document.createElement('h2');
  heading.style.cssText = 'color: #f56565; margin-bottom: 12px;';
  heading.textContent = 'Failed to load application';

  const errorText = document.createElement('p');
  errorText.style.cssText = 'color: hsl(240 5% 64.9%); margin-bottom: 16px;';
  errorText.textContent = message;

  const reloadBtn = document.createElement('button');
  reloadBtn.style.cssText = `
    padding: 8px 16px;
    background: hsl(240 3.7% 15.9%);
    border: 1px solid hsl(240 3.7% 25%);
    color: white;
    border-radius: 6px;
    cursor: pointer;
  `;
  reloadBtn.textContent = 'Reload';
  reloadBtn.onclick = () => location.reload();

  container.appendChild(heading);
  container.appendChild(errorText);
  container.appendChild(reloadBtn);
  loadingEl.appendChild(container);
}

// Global error handlers to catch silent failures
window.onerror = (message, source, lineno, colno, error) => {
  console.error('[Global Error]', { message, source, lineno, colno, error });
  showLoadingError(String(message));
  return false;
};

window.onunhandledrejection = (event) => {
  console.error('[Unhandled Promise Rejection]', event.reason);
};

// Handle Vite HMR connection issues
if (import.meta.hot) {
  import.meta.hot.on('vite:error', (payload) => {
    console.error('[Vite Error]', payload);
  });

  import.meta.hot.on('vite:beforeFullReload', () => {
  });
}

// Marks the frame as app-owned so TopMenuBar can take over the caption row.
// Set before first paint — flipping it later would reflow the whole top bar.
if (window.electron?.platform === 'win32') {
  document.documentElement.setAttribute('data-titlebar-overlay', 'true');
}

// Linux runs frameless (no Window Controls Overlay exists there), so the bar
// is both the menu and the title bar: draggable, and carrying its own caption
// buttons. Same reasoning as above — set before first paint.
if (window.electron?.platform === 'linux') {
  document.documentElement.setAttribute('data-custom-frame', 'true');
}

try {
  const root = document.getElementById('root');
  if (!root) {
    throw new Error('Root element not found');
  }

  ReactDOM.createRoot(root).render(
    <React.StrictMode>
      <AppWrapper />
    </React.StrictMode>
  );
} catch (error) {
  console.error('[React Mount Error]', error);
  showLoadingError(error instanceof Error ? error.message : 'Unknown error');
}
