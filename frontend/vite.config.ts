export default {
  root: "frontend",
  publicDir: false,
  server: {
    port: 5173,
    proxy: {
      "/api": "http://localhost:3000",
      "/socket.io": {
        target: "http://localhost:3000",
        ws: true
      }
    }
  },
  build: {
    outDir: "../public",
    emptyOutDir: true
  }
};
