import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  root: 'admin-ui',
  base: '/admin/',
  build: {
    outDir: '../dist/admin-ui',
    emptyOutDir: true
  }
});
