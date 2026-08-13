import { protocol } from 'electron';

/**
 * Production React resolution for sandboxed plugin UI bundles.
 *
 * Plugin UI bundles externalize React and emit bare-absolute imports like
 *   import { jsx } from "/node_modules/react/jsx-runtime";
 * In dev, vite.config.ts intercepts `/node_modules/react*` and serves tiny ESM
 * shims that re-export from `window.EnclaveAPI.React`. There is no equivalent in
 * a packaged build (the renderer loads over file://), so those imports resolve
 * to file:///node_modules/react and 404 — every plugin UI fails to load (#6).
 *
 * This serves the same shims over a dedicated privileged scheme. The file://
 * requests for those three paths are redirected here in main.ts. The scheme is
 * registered as privileged (standard + secure + supportFetchAPI) in main.ts so
 * the renderer treats responses as real ES modules.
 *
 * The shim bodies are kept byte-for-byte equivalent to vite.config.ts so dev
 * and prod resolve React identically.
 */

const JS_HEADERS = { 'content-type': 'text/javascript; charset=utf-8' };

const SHIMS: Record<string, string> = {
  'react/jsx-runtime': `
    export const jsx = window.EnclaveAPI.React.jsxRuntime.jsx;
    export const jsxs = window.EnclaveAPI.React.jsxRuntime.jsxs;
    export const Fragment = window.EnclaveAPI.React.jsxRuntime.Fragment;
  `,
  react: `
    const React = window.EnclaveAPI.React;
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
  `,
  'react-dom': `
    const ReactDOM = window.EnclaveAPI.ReactDOM;
    export default ReactDOM;
    export const createRoot = window.EnclaveAPI.ReactDOMClient.createRoot;
    export const hydrateRoot = window.EnclaveAPI.ReactDOMClient.hydrateRoot;
  `,
};

/** The scheme registered (as privileged) in main.ts and targeted by the redirect. */
export const MODULE_SHIM_SCHEME = 'enclave-module';

/**
 * Map an `enclave-module://` URL to a shim key. The bare module name lands on
 * the URL host (`enclave-module://react`), with sub-paths on the pathname
 * (`enclave-module://react/jsx-runtime`).
 */
function shimKeyFromUrl(rawUrl: string): string | null {
  const url = new URL(rawUrl);
  const key = (url.host + url.pathname).replace(/\/$/, '');
  return key in SHIMS ? key : null;
}

export function registerModuleShimProtocol(): void {
  protocol.handle(MODULE_SHIM_SCHEME, (request) => {
    const key = shimKeyFromUrl(request.url);
    if (!key) {
      return new Response('Module shim not found', { status: 404 });
    }
    return new Response(SHIMS[key], { headers: JS_HEADERS });
  });
}

/**
 * Serve the React shim for a `/node_modules/react[-dom|/jsx-runtime]` request on
 * ANY scheme. Used by the plugin:// bundle handler, whose bundles resolve those
 * externalized imports against the plugin origin rather than file:// (so the
 * file:// redirect can't reach them). Returns null if the URL isn't one of the
 * three externalized React modules.
 */
export function reactShimResponse(rawUrl: string): Response | null {
  let pathname: string;
  try {
    pathname = new URL(rawUrl).pathname.replace(/\/$/, '');
  } catch {
    return null;
  }
  let key: string | null = null;
  if (pathname.endsWith('/node_modules/react/jsx-runtime')) key = 'react/jsx-runtime';
  else if (pathname.endsWith('/node_modules/react-dom')) key = 'react-dom';
  else if (pathname.endsWith('/node_modules/react')) key = 'react';
  if (!key) return null;
  return new Response(SHIMS[key], { headers: JS_HEADERS });
}

/**
 * Given an intercepted file:// request URL, return the `enclave-module://`
 * target if it points at one of the externalized React modules, else null.
 * Order matters: match the more specific paths before the `/react` suffix.
 */
export function moduleShimRedirectTarget(fileUrl: string): string | null {
  let pathname: string;
  try {
    pathname = new URL(fileUrl).pathname.replace(/\/$/, '');
  } catch {
    return null;
  }
  if (pathname.endsWith('/node_modules/react/jsx-runtime')) {
    return `${MODULE_SHIM_SCHEME}://react/jsx-runtime`;
  }
  if (pathname.endsWith('/node_modules/react-dom')) {
    return `${MODULE_SHIM_SCHEME}://react-dom`;
  }
  if (pathname.endsWith('/node_modules/react')) {
    return `${MODULE_SHIM_SCHEME}://react`;
  }
  return null;
}
