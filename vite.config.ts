import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  base: '/marbles/',
  plugins: [react()],
  css: {
    preprocessorOptions: {
      less: { javascriptEnabled: true },
    },
  },
});
