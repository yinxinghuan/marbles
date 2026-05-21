import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  base: '/marbles/',
  plugins: [react()],
  resolve: {
    alias: { '@shared': path.resolve(__dirname, 'src/shared') },
  },
  css: {
    preprocessorOptions: {
      less: { javascriptEnabled: true },
    },
  },
});
