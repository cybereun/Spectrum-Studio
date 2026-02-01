import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  // GitHub Pages repository name is 'Spectrum-Studio'
  // This ensures assets are loaded from /Spectrum-Studio/ instead of root /
  base: '/Spectrum-Studio/',
})