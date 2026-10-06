import { defineConfig } from 'vite'

// https://vitejs.dev/config
export default defineConfig({
  build: {
    rollupOptions: {
      // node:sqlite is a runtime builtin of Electron's Node; it must not be bundled.
      external: ['node:sqlite'],
    },
  },
})
