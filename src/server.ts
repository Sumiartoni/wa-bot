import { ensureRuntimeDirs, config } from "./config.js";
import { createApp } from "./app.js";

ensureRuntimeDirs();

const { httpServer } = createApp();

httpServer.listen(config.PORT, () => {
  console.log(`JokiTugasKu WA backend listening on http://localhost:${config.PORT}`);
});
