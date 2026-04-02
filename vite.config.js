import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      // En dev local : redirige /api vers ton backend local port 3001
      '/api': 'http://localhost:3001'
    }
  }
})
