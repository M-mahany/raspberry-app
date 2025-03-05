import express, { Request, Response } from "express";
import "./jobs/audioRecording";
import { SystemService } from "./services/systemService";
import logger from "./utils/winston/logger";
import "./jobs/autoUpdateCron";
import fs from "fs";
import path from "path";
import { convertLogsToJson } from "./utils/helpers";
import "./utils/socket/socketClient";

const app = express();
const port = 5001;

const logsDir = path.join(__dirname, "./logs/app.log");

app.get("/", (_req: Request, res: Response) => {
  res.send("Raspberry Pi App!");
});

app.get("/system-health", async (_req: Request, res: Response) => {
  try {
    const data = await SystemService.getSystemHealth();
    res.status(200).json({ data });
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
    const logEntries = convertLogsToJson(logs);

    res.status(200).json({ data: logEntries });
  } catch (error: any) {
    res
      .status(500)
      .json({ message: `Error reading logs: ${error?.message || error}` });
  }
});

app.get("/update", async (_req: Request, res: Response) => {
  let message1;
  try {
    // update and upgrade system using `Sudo apt etc...`
    try {
      const { message, code } = await SystemService.updateSystem();
      if (code === 200) {
        message1 = message;
      } else {
        res.status(code).json({ message });
        return;
      }
    } catch (error: any) {
      res
        .status(500)
        .json({ message: `Error updating system: ${error?.message || error}` });
      return;
    }
    const { message: message2, code: code2 } =
      await SystemService.checkForUpdates();
    res
      .status(code2)
      .json({ message: `${code2 === 200 ? message1 + "&" : ""} ${message2}` });
  } catch (error: any) {
    res
      .status(500)
      .json({ message: `Error updating device: ${error?.message || error}` });
  }
});

app.listen(port, () => {
  logger.info(`🚀 Raspberry app listening on port ${port}`);
});
