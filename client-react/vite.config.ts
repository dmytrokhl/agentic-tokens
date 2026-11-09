import { defineConfig } from 'vite'
import { resolve } from 'path'
import react, { reactCompilerPreset } from '@vitejs/plugin-react'
import babel from '@rolldown/plugin-babel'
import tailwindcss from '@tailwindcss/vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    {
      name: 'print-public-app-url',
      configureServer(server) {
        // Docker users reach Vite through Caddy's public HTTPS endpoint.
        const publicUrl = process.env.PUBLIC_APP_URL
        if (publicUrl) {
          server.printUrls = () => {
            server.config.logger.info(`  ➜  App:     ${publicUrl}`)
          }
        }
      },
    },
    react(),
    babel({ presets: [reactCompilerPreset()] }),
    tailwindcss()
  ],
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        collect: resolve(__dirname, 'collect.html'),
        binding: resolve(__dirname, 'binding.html'),
        visaCallback: resolve(__dirname, 'visa-3ds-callback.html'),
      },
    },
  },
})
