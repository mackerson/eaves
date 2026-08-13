// Minimal ambient types for the (untyped, transitive) `tar` package — only the
// extract surface the marketplace install flow uses. Avoids pulling @types/tar.
declare module 'tar' {
  interface ExtractOptions {
    file?: string;
    cwd?: string;
    strip?: number;
    sync?: boolean;
    filter?: (path: string, entry: unknown) => boolean;
    onentry?: (entry: unknown) => void;
  }
  export function extract(opts: ExtractOptions): Promise<void>;
  export function x(opts: ExtractOptions): Promise<void>;
}
