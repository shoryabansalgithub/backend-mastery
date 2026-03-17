import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import fs from 'fs'

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
})
