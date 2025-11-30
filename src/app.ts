import express, { Request, Response } from "express";
import "./jobs/audioRecording";
import { SystemService } from "./services/systemService";
import logger, { logsDir } from "./utils/winston/logger";
import "./jobs/autoUpdateCron";
import fs from "fs";
import { convertLogsToJson } from "./utils/helpers";
import "./utils/socket/socketClient";
import { exec } from "child_process";
// import { exec } from "child_process";

const app = express();
const port = 5001;

app.get("/", (_req: Request, res: Response) => {
  res.send("Raspberry Pi App!");
});

app.use(express.json());

app.get("/system-health", async (_req: Request, res: Response) => {
  try {
    const data = await SystemService.getSystemHealth();
    res.status(200).json({ data });
  } catch (err) {
    res.status(500).json({ message: `Internal Server Error:${err}` });
  }
});

app.get("/logs", async (req: Request, res: Response) => {
  const { page = 1, limit = 500 } = req.query;

  const pageNumber = Number(page);
  const perPage = Number(limit);

  try {
    const logFile = `${logsDir}/app.log`;
    if (!fs.existsSync(logFile)) {
      res.status(404).json({ message: "Log file not found" });
      return;
    }

    const logs = await fs.promises.readFile(logFile, "utf-8");

    // Convert log file into JSON format
    const logEntries = convertLogsToJson(logs, pageNumber, perPage);

    res.status(200).json({ data: logEntries });
  } catch (error: any) {
    res
      .status(500)
      .json({ message: `Error reading logs: ${error?.message || error}` });
  }
});

app.get("/update-app", async (_req: Request, res: Response) => {
  try {
    const { message, code } = await SystemService.checkForUpdates();
    res.status(code).json({ message });
  } catch (error: any) {
    res
      .status(500)
      .json({ message: `Error updating device: ${error?.message || error}` });
  }
});

app.get("/update-system", async (_req: Request, res: Response) => {
  try {
    const { message, code } = await SystemService.updateSystem();
    res.status(code).json({ message });
  } catch (error: any) {
    res
      .status(500)
      .json({ message: `Error updating device: ${error?.message || error}` });
  }
});

app.get("/reboot", async (_req: Request, res: Response) => {
  try {
    SystemService.rebootDevice();
    res
      .status(200)
      .json({ message: "Device will be rebooted in 3 seconds..." });
  } catch (error: any) {
    res
      .status(500)
      .json({ message: `Error rebooting device: ${error?.message || error}` });
  }
});

// app.get("/refresh_tailscale", async (_req: Request, res: Response) => {
//   try {
//     SystemService.refreshTailscale();

//     res.status(200).json({ message: "Tailscale successfully refreshed." });
//   } catch (error: any) {
//     res.status(500).json({
//       message: `Error refreshing Tailscale: ${error?.message || error}`,
//     });
//   }
// });

app.post("/reset_password", (req: Request, res: Response) => {
  const { user, password } = req.body;

  if (!user || !password) {
    res.status(400).json({ error: "Missing user or password" });
    return;
  }

  if (!/^[a-z_][a-z0-9_-]*[$]?$/.test(user)) {
    res.status(400).json({ error: "Invalid username format" });
    return;
  }

  if (
    typeof password !== "string" ||
    password.length < 6 ||
    password.includes("'")
  ) {
    res.status(400).json({ error: "Weak or unsafe password format" });
    return;
  }

  const command = `echo '${user}:${password}' | sudo /usr/sbin/chpasswd`;

  exec(command, (error, _stdout, stderr) => {
    if (error) {
      console.error("Password reset failed:", stderr);
      res.status(500).json({ error: stderr.trim() || "Command failed" });
      return;
    }

    res.json({ message: "Password reset successfully" });
    return;
  });
});

app.listen(port, () => {
  logger.info(`🚀 Raspberry app listening on port ${port}`);
});
