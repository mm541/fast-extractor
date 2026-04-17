import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import basicSsl from '@vitejs/plugin-basic-ssl'
import wasm from 'vite-plugin-wasm'
import topLevelAwait from 'vite-plugin-top-level-await'

import { cloudflare } from "@cloudflare/vite-plugin";

// https://vite.dev/config/
export default defineConfig({
  base: '/',
  plugins: [react(), basicSsl(), wasm(), topLevelAwait(), cloudflare()],
  server: {
    host: true,
    https: {},
    cors: true,
    // These headers are NOT required by the library — no API used needs
    // cross-origin isolation. Set here only for demo site dev parity.
    // Consumers should NOT copy these; COOP breaks OAuth popups/iframes.
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'credentialless',
    },
  },
  preview: {
    host: true,
    https: {},
    cors: true,
    port: 4173,
    // Same note as server.headers above.
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'credentialless',
    },
  },
  worker: {
    format: 'es',
    plugins: () => [
      wasm(),
      topLevelAwait()
    ]
  },
  build: {
    target: 'esnext'
  }
})