import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import type { Plugin } from "vite";

// The bundled Pine scripts (pine/indicators) are read once, when a chart is built. A
// hot-swapped module would leave the live chart on the old script, so a change to one of
// them reloads the whole app instead.
function reloadOnPineChange(): Plugin {
  return {
    name: "reload-on-pine-change",
    handleHotUpdate({ file, server }) {
      if (!file.endsWith(".pine")) return;
      server.ws.send({ type: "full-reload" });
      return [];
    },
  };
}

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), reloadOnPineChange()],

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },

  build: {
    // Vela is a large, self-contained charting engine; a single chunk warning
    // for it is expected and not actionable.
    chunkSizeWarningLimit: 1500,
  },

  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "scripts/**/*.test.mjs"],
  },
});
