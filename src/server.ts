import express, { Request, Response } from "express";
import "./jobs/audioRecording";
import { SystemService } from "./services/systemService";
import logger from "./utils/winston/logger";
import fs from "fs";
import path from "path";

const app = express();
const port = 5001;

const logsDir = path.join(__dirname, "./logs/app.log");

app.get("/", (_req: Request, res: Response) => {
  res.send("Raspberry Pi App!");
});

app.get("/system-health", async (_req: Request, res: Response) => {
  try {
    const data = await SystemService.getSystemHealth();
    res.status(200).json(data);
  } catch (err) {
    res.status(500).json({ message: `Internal Server Error:${err}` });
  }
});

app.get("/logs", async (_req: Request, res: Response) => {
  try {
    if (!fs.existsSync(logsDir)) {
      res.status(404).json({ message: "Log file not found" });
      return;
    }

    const logs = await fs.promises.readFile(logsDir, "utf-8");

    // Convert log file into JSON format
    const logEntries = logs
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => {
        const match = line.match(
          /(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}.\d{3}Z) \[(\w+)\]: (.*)/,
        );
        if (match) {
          return { timestamp: match[1], level: match[2], message: match[3] };
        }
        return { raw: line };
      });

    res.status(200).json({ logs: logEntries });
  } catch (error: any) {
    res
      .status(500)
      .json({ message: `Error reading logs: ${error?.message || error}` });
  }
});

app.listen(port, () => {
  logger.info(`🚀 Raspberry app listening on port ${port}`);
});
