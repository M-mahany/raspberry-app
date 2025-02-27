import cron from "node-cron"
import { SystemService } from "../services/systemService";
import logger from "../utils/winston/logger";

// Schedule a task to run every 7 days at 3 AM
cron.schedule("0 3 */7 * *", async() => {
  logger.info("Running scheduled task at 3 AM every 7 days...");
  try {
    await SystemService.checkForUpdates();
  } catch (error) {
    logger.error("Error running scheduled auto update:", error);
  }
});
