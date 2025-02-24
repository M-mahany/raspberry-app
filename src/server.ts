import express, { Request, Response } from "express";
import "./jobs/audioRecording";
import { SystemService } from "./services/systemService";

const app = express();
const port = 5001;

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

app.listen(port, () => {
  console.log(`🚀 Raspberry app listening on port ${port}`);
});
