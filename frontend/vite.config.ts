import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "./src"),
    },
  },
  server: {
    host: true,
    port: 5173,
    // Разрешаем любые поддомены lvh.me и nip.io (для dev через поддомены):
    //   shop1.lvh.me:5173 → магазин 1
    //   lvh.me:5173       → глобальный профиль
    //   shop1.nip.io:5173 → альтернатива
    // Точка перед доменом = «и сам домен, и все его поддомены».
    allowedHosts: [".lvh.me", ".nip.io", "localhost", "127.0.0.1"],
    proxy: {
      "/api": {
        target: "http://localhost:5000",
        changeOrigin: false,
      },
      // WebSocket для Socket.IO (путь по умолчанию — /socket.io/).
      // ws: true — Vite проксирует Upgrade-запросы, сохраняя Host.
      "/socket.io": {
        target: "http://localhost:5000",
        changeOrigin: false,
        ws: true,
      },
    },
  },
});
