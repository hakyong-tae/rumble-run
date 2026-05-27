import { defineConfig } from 'vite'

export default defineConfig({
  server: { port: 3005 },
  preview: { port: 3005 },
  build: { outDir: 'dist' },
})
