import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import path from 'node:path'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      lib: {
        entry: 'src/main/index.ts',
        formats: ['cjs'],
        fileName: () => '[name].js',
      },
      rollupOptions: {
        output: { inlineDynamicImports: true },
      },
    },
    resolve: {
      alias: {
        '@main': path.resolve(__dirname, 'src/main'),
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      lib: {
        entry: 'src/preload/index.ts',
        formats: ['cjs'],
        fileName: () => '[name].js',
      },
    },
  },
  renderer: {
    plugins: [react()],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, 'src/renderer'),
      },
    },
    build: {
      rollupOptions: {
        input: {
          index: path.resolve(__dirname, 'src/renderer/index.html'),
        },
      },
    },
  },
})
