import express, { Request, Response } from "express";
import "./jobs/audioRecording";

const app = express();
const port = 5001;

app.get("/", (_req: Request, res: Response) => {
  res.send("Raspberry Pi App!");
});

app.listen(port, () => {
  console.log(`🚀 Raspberry app listening on port ${port}`);
});
