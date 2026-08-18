// Minimal ambient declaration for Bun's built-in SQLite, used by the OpenCode
// plugin (which runs under Bun). Kept external at bundle time (tsup `external`),
// so this only satisfies the typechecker — the real module is Bun's.
declare module 'bun:sqlite' {
  export class Database {
    constructor(filename: string, options?: { readonly?: boolean })
    run(sql: string): void
    query(sql: string): { get(...params: unknown[]): unknown; all(...params: unknown[]): unknown[] }
    close(): void
  }
}
