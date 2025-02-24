import fs from "fs-extra";
import mic from "mic";
import dotenv from "dotenv";
import path from "path";
import { ffmpegService } from "../services/ffmpegService";

dotenv.config();

const RECORDING_DIR = process.env.RECORDING_DIR || "./pending_upload";
fs.ensureDirSync(RECORDING_DIR);

const startRecording = () => {
  const micInstance = mic({
    rate: "16000",
    channels: "1",
    bitwidth: "16",
    encoding: "signed-integer",
    fileType: "raw",
    debug: true,
  });

  const micInputStream = micInstance.getAudioStream();
  const rawFile = path.join(RECORDING_DIR, `${Date.now()}.raw`);
  const mp3File = rawFile.replace(".raw", ".mp3");

  const outputFileStream = fs.createWriteStream(rawFile, { encoding: "binary" });

  micInputStream.pipe(outputFileStream);
  micInstance.start();
  console.log(`🎙️ Recording started: ${rawFile}`);

  micInputStream.on("error", (err) => {
    console.error("⚠️ Mic error:", err);
  });

  // Stop recording after 8 seconds
  setTimeout(() => {
    micInstance.stop(); // Stop the microphone
    outputFileStream.end(() => {
      console.log(`✅ Finished recording: ${rawFile}`);

      // Convert after the file stream is fully closed
      ffmpegService.convertAudioToMp3(rawFile, mp3File);

      // Restart recording immediately
      startRecording();
    });
  }, 8000);
};

startRecording();
