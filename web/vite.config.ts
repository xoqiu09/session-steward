import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5178,
    host: '127.0.0.1',
    proxy: { '/api': 'http://127.0.0.1:7788', '/login': 'http://127.0.0.1:7788' },
  },
  build: { outDir: 'dist', emptyOutDir: true },
})
