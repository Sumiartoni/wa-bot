import { runBackup } from "../src/backup.js";
import { ensureRuntimeDirs } from "../src/config.js";
import { closePrisma } from "../src/db.js";

ensureRuntimeDirs();

runBackup(null)
  .then((backup) => {
    console.log(`Backup created: ${backup.filePath} (${backup.sizeBytes} bytes)`);
  })
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closePrisma();
  });
