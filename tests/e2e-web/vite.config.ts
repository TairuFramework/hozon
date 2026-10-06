import react from '@vitejs/plugin-react'
import sqlocal from 'sqlocal/vite'
import { defineConfig } from 'vite'

const headers = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [sqlocal(), react()],
  define: {
    'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV),
  },
  server: { headers },
  preview: { headers },
})
