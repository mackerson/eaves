import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import fs from 'fs';

export default defineConfig({
  plugins: [
    react(),
    // Custom plugin to serve plugin bundles and virtual React modules
    {
      name: 'serve-plugins',
      configureServer(server) {
        server.middlewares.use((req, res, next) => {
          // Serve virtual React modules for plugins
          if (req.url === '/node_modules/react/jsx-runtime') {
            res.setHeader('Content-Type', 'application/javascript');
            res.end(`
              export const jsx = window.EavesAPI.React.jsxRuntime.jsx;
              export const jsxs = window.EavesAPI.React.jsxRuntime.jsxs;
              export const Fragment = window.EavesAPI.React.jsxRuntime.Fragment;
            `);
            return;
          }

          if (req.url === '/node_modules/react') {
            res.setHeader('Content-Type', 'application/javascript');
            res.end(`
              const React = window.EavesAPI.React;
              export default React;
              export const useState = React.useState;
              export const useEffect = React.useEffect;
              export const useRef = React.useRef;
              export const useCallback = React.useCallback;
              export const useMemo = React.useMemo;
              export const useContext = React.useContext;
              export const createContext = React.createContext;
              export const forwardRef = React.forwardRef;
              export const memo = React.memo;
              export const Fragment = React.Fragment;
            `);
            return;
          }

          if (req.url === '/node_modules/react-dom') {
            res.setHeader('Content-Type', 'application/javascript');
            res.end(`
              const ReactDOM = window.EavesAPI.ReactDOM;
              export default ReactDOM;
              export const createRoot = window.EavesAPI.ReactDOMClient.createRoot;
              export const hydrateRoot = window.EavesAPI.ReactDOMClient.hydrateRoot;
            `);
            return;
          }

          // Serve plugin bundles from /plugins directory
          if (req.url?.startsWith('/plugins/')) {
            const pluginPath = path.resolve(__dirname, '.' + req.url.split('?')[0]);

            if (fs.existsSync(pluginPath) && fs.statSync(pluginPath).isFile()) {
              if (pluginPath.endsWith('.js')) {
                res.setHeader('Content-Type', 'application/javascript');
              }
              const content = fs.readFileSync(pluginPath);
              res.end(content);
              return;
            }
          }
          next();
        });
      },
    },
  ],
  root: './src/renderer',
  base: './',
  build: {
    outDir: '../../dist/renderer',
    emptyOutDir: true,
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src/renderer'),
      '@shared': path.resolve(__dirname, './src/shared'),
      '@assets': path.resolve(__dirname, './assets'),
    },
  },
  server: {
    port: 5173,
    fs: {
      // Allow serving files from plugins directory
      allow: ['..', '../..'],
    },
    hmr: {
      // Increase timeout to handle system sleep/wake cycles better
      timeout: 60000, // 60 seconds (default is 30s)
      // Overlay shows errors visually instead of white screen
      overlay: true,
    },
    // Keep connection alive longer during idle periods
    watch: {
      // Use polling with longer interval to reduce resource usage during idle
      usePolling: false,
    },
  },
  // Serve plugins directory as static files
  publicDir: false, // Disable default public dir
  // Configure static asset serving for plugin bundles
  assetsInclude: ['**/*.js.map']
});
