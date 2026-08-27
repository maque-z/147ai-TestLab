/// <reference types="vite/client" />

/** Injected at build time by vite.config.ts `define`: short commit + UTC time.
 *  "dev" during `vite dev` outside a build. */
declare const __BUILD_INFO__: string
