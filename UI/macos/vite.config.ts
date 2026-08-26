import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

/**
 * claude1 macOS 桌面端前端构建配置。
 * 不配置路径别名——全工程一律相对路径 import。
 * 刻意不读 process.env：devDependencies 里没有 @types/node，
 * 环境判断改用 Vite 传入的 command。
 */
export default defineConfig(({ command }) => {
  const isProduction = command === "build";

  return {
    plugins: [react()],

    // Tauri 会接管终端输出，清屏会吞掉 Rust 侧的编译错误
    clearScreen: false,

    // TAURI_ENV_* 由 Tauri v2 的 CLI 注入（平台、架构、调试标志）
    envPrefix: ["VITE_", "TAURI_ENV_"],

    server: {
      port: 1420,
      strictPort: true,
      // 只监听回环，不向局域网暴露开发服务器
      host: false,
      watch: {
        // Rust 侧由 cargo 自己监听，Vite 跟着重启纯属噪音
        ignored: ["**/src-tauri/**"],
      },
    },

    build: {
      // macOS 系统 WebView（WKWebView）对齐 Safari 15
      target: "safari15",
      // true 即 Vite 默认的 esbuild 压缩；开发构建不压缩以保留可读堆栈
      minify: isProduction,
      sourcemap: !isProduction,
    },
  };
});
