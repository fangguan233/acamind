import react from '@vitejs/plugin-react-swc';
import path from 'path';
import { defineConfig } from 'vite';
import { nodePolyfills } from 'vite-plugin-node-polyfills';
import svgr from 'vite-plugin-svgr';
import tsconfigPaths from 'vite-tsconfig-paths';

// https://vitejs.dev/config/
export default defineConfig({
  build: {
    sourcemap: true
  },
  plugins: [nodePolyfills(), react(), tsconfigPaths(), svgr()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      'vite-plugin-node-polyfills/shims/buffer': path.resolve(
        __dirname,
        './node_modules/vite-plugin-node-polyfills/shims/buffer/dist/index.js'
      ),
      'vite-plugin-node-polyfills/shims/process': path.resolve(
        __dirname,
        './node_modules/vite-plugin-node-polyfills/shims/process/dist/index.js'
      ),
      'vite-plugin-node-polyfills/shims/global': path.resolve(
        __dirname,
        './node_modules/vite-plugin-node-polyfills/shims/global/dist/index.js'
      ),
      // To prevent conflicts with packages in @chainlit/react-client, we need to specify the resolution paths for these dependencies.
      react: path.resolve(__dirname, './node_modules/react'),
      'usehooks-ts': path.resolve(__dirname, './node_modules/usehooks-ts'),
      sonner: path.resolve(__dirname, './node_modules/sonner'),
      lodash: path.resolve(__dirname, './node_modules/lodash'),
      recoil: path.resolve(__dirname, './node_modules/recoil')
    }
  }
});
