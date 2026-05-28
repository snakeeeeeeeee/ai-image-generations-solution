import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const adminBasePath = `${process.env.ADMIN_BASE_PATH || '/image-wrapper/admin'}/`.replace(/\/+$/, '/');

export default defineConfig({
  plugins: [react()],
  root: 'admin-ui',
  base: adminBasePath,
  build: {
    outDir: '../dist/admin-ui',
    emptyOutDir: true
  }
});
