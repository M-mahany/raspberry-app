import fs from "fs-extra";
import mic from "mic";
import dotenv from "dotenv";
import path from "path";
import { RecordingService } from "../services/recordingsService";
import logger from "../utils/winston/logger";
import { getFileName } from "../utils/helpers";

dotenv.config();

const RECORDING_DIR = process.env.RECORDING_DIR || "./pending_upload";
fs.ensureDirSync(RECORDING_DIR);

const RECORDING_INTERVAL = 1 * 60 * 1000;
// 2 * 60 * 60 * 1000; // 2 hours in milliseconds
const CONVERSION_CHECK_INTERVAL = 2 * 60 * 1000;

const recordingFiles = new Set<string>(); // Stores active recordings

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
  const fileName = `${Date.now()}.raw`;
  recordingFiles.add(fileName);
  const rawFile = path.join(RECORDING_DIR, fileName);

  const outputFileStream = fs.createWriteStream(rawFile, {
    encoding: "binary",
  });

  micInputStream.pipe(outputFileStream);
  micInstance.start();
  logger.info(`🎙️ Recording started: ${getFileName(rawFile)}`);

  micInputStream.on("error", (err) => {
    logger.error("⚠️ Mic error:", err);
  });

  // Stop recording after the defined interval
  setTimeout(() => {
    micInstance.stop();
    outputFileStream.end(() => {
      logger.info(`✅ Finished recording: ${getFileName(rawFile)}`);
      recordingFiles.delete(fileName);
      // Restart recording immediately
      startRecording();
      RecordingService.convertAndUploadToServer(rawFile);
    });
  }, RECORDING_INTERVAL);
};

const convertInterruptedFiles = async () => {
  try {
    const files = await fs.readdir(RECORDING_DIR);
    logger.info("🔄 Cheking Interupted files...");

    const filteredFiles = files.filter(
      (file) => path.extname(file) === ".raw" && !recordingFiles.has(file),
    );
    const conversionPromises = filteredFiles.map(async (file) => {
      const rawFilePath = path.join(RECORDING_DIR, file);
      logger.info(`🔄 Converting interrupted recording: ${getFileName(rawFilePath)}`);
      await RecordingService.convertAndUploadToServer(rawFilePath);
    });
    if (filteredFiles?.length) {
      await Promise.all(conversionPromises);
    } else {
      logger.info("✅ Checking complete! No Interuppted files found");
    }
  } catch (err) {
    console.error(`❌ Error reading directory ${RECORDING_DIR}:`, err);
  }
};

setInterval(convertInterruptedFiles, CONVERSION_CHECK_INTERVAL);

startRecording();
