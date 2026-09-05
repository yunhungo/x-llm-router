/**
 * @created 2026-08-10
 * @description 配置前端构建、源码别名与开发代理。
 * @author yunhungo
 */
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  server: {
    proxy: {
      '/api': { target: 'http://localhost:4000', changeOrigin: true },
      '/v1': { target: 'http://localhost:4000', changeOrigin: true },
      '/healthz': { target: 'http://localhost:4000', changeOrigin: true },
    },
  },
});
