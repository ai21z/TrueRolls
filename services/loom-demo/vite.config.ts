import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const apiProxy = {
  '/api': {
    target: 'http://127.0.0.1:8080',
    changeOrigin: true,
    rewrite: (path: string) => path.replace(/^\/api/, ''),
  },
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  build: {
    manifest: true,
  },
  optimizeDeps: {
    // Serve the linked wasm package as-is so its wasm asset URL resolution is
    // not broken by dependency pre-bundling.
    exclude: ['kd-core-wasm'],
  },
  server: {
    proxy: apiProxy,
  },
  preview: {
    proxy: apiProxy,
  },
})
