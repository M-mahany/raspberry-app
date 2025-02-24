import fs from "fs-extra";
import mic from "mic";
import dotenv from "dotenv";
import path from "path";
import { ffmpegService } from "../services/ffmpegService";

dotenv.config();

const RECORDING_DIR = process.env.RECORDING_DIR || "./pending_upload";
fs.ensureDirSync(RECORDING_DIR);

const RECORDING_INTERVAL = 10000;
// 2 * 60 * 60 * 1000; // 2 hours in milliseconds

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

  const outputFileStream = fs.createWriteStream(rawFile, {
    encoding: "binary",
  });

  micInputStream.pipe(outputFileStream);
  micInstance.start();
  console.log(`🎙️ Recording started: ${rawFile}`);

  micInputStream.on("error", (err) => {
    console.error("⚠️ Mic error:", err);
  });

  // Stop recording after the defined interval
  setTimeout(() => {
    micInstance.stop();
    outputFileStream.end(async () => {
      console.log(`✅ Finished recording: ${rawFile}`);
      let originalFile = rawFile;
      // Restart recording immediately
      startRecording();
      try {
        await ffmpegService.convertAudioToMp3(
          originalFile,
        );
      } catch (error) {
        console.error(`❌ Error processing file ${rawFile}:`, error);
      }
    });
  }, RECORDING_INTERVAL);
};

const convertInterruptedFiles = async () => {
  try {
    const files = await fs.readdir(RECORDING_DIR);

    for (const file of files) {
      if (path.extname(file) === ".raw") {
        const rawFilePath = path.join(RECORDING_DIR, file);

        console.log(
          `🔄 Found interrupted recording: ${rawFilePath}, converting...`,
        );
        await ffmpegService.convertAudioToMp3(rawFilePath);
      }
    }
  } catch (err) {
    console.error(`❌ Error reading directory ${RECORDING_DIR}:`, err);
  }
};

// Ensure any unfinished files are converted before starting
convertInterruptedFiles().then(startRecording);
