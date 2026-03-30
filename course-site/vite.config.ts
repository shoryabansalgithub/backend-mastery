import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import fs from 'fs'
import path from 'path'

function markdownRawPlugin() {
  return {
    name: 'markdown-raw',
    transform(_code: string, id: string) {
      if (!id.endsWith('.md')) return null
      const content = fs.readFileSync(id, 'utf-8')
      return {
        code: `export default ${JSON.stringify(content)}`,
        map: null,
      }
    },
  }
}

export default defineConfig({
  plugins: [react(), markdownRawPlugin()],
  resolve: {
    alias: {
      '@content': path.resolve(__dirname, '../backend-mastery'),
    },
  },
  server: {
    fs: {
      allow: [
        // Allow serving files from project root and backend-mastery
        path.resolve(__dirname),
        path.resolve(__dirname, '../backend-mastery'),
      ],
    },
  },
})
