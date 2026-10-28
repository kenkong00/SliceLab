import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tsconfigPaths from "vite-tsconfig-paths";

// https://vite.dev/config/
export default defineConfig({
  server: {
    host: true,
    port: 5180,
    strictPort: true,
    // Vite 6.0.9+ 会校验请求的 Host 头。开了 host:true 后，从局域网 IP 或
    // 自定义主机名访问会被拦成 "Blocked request. This host is not allowed."，
    // 连带 HMR 的 WebSocket 也连不上。这里放行（仅开发服务器，不进生产构建）。
    allowedHosts: true,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:5181',
        changeOrigin: true,
        // 后端还没起来时，默认会直接报一个看不懂的 500。
        // 这里改成 503 + 明确文案，前端能原样提示用户。
        configure: (proxy: any) => {
          proxy.on('error', (_err: Error, _req: any, res: any) => {
            if (res && typeof res.writeHead === 'function' && !res.headersSent) {
              res.writeHead(503, { 'Content-Type': 'application/json; charset=utf-8' });
              res.end(
                JSON.stringify({
                  error: '后端服务未就绪（127.0.0.1:5181）。请确认 SliceLab 后端已启动，或重新执行 start.bat',
                })
              );
            }
          });
        },
      },
    },
  },
  build: {
    sourcemap: 'hidden',
  },
  plugins: [
    react({
      babel: {
        plugins: [
          'react-dev-locator',
        ],
      },
    }),
    tsconfigPaths()
  ],
})
