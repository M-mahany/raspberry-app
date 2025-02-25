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

const RECORDING_INTERVAL = 0.5 * 60 * 1000;
// 2 * 60 * 60 * 1000; // 2 hours in milliseconds
const CONVERSION_CHECK_INTERVAL = 0.5 * 30 * 1000;

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
      // Restart recording immediately
      startRecording();
      RecordingService.convertAndUploadToServer(rawFile, recordingFiles);
    });
  }, RECORDING_INTERVAL);
};

const handleInterruptedFiles = async () => {
  try {
    const files = await fs.readdir(RECORDING_DIR);
    logger.info("🔄 Cheking Interupted files...");

    // list of eligible .raw interrupted files
    const filteredRawFiles = files.filter(
      (file) => path.extname(file) === ".raw" && !recordingFiles.has(file),
    );
    // list of eligible .mp3 interrupted files
    const filteredMp3Files = files.filter((file) => {
      const fileNameWithoutExt = path.basename(file, ".mp3");
      const rawFileName = `${fileNameWithoutExt}.raw`;
      return path.extname(file) === ".mp3" && !recordingFiles.has(rawFileName);
    });

    const conversionPromises = filteredRawFiles.map(async (file) => {
      const rawFilePath = path.join(RECORDING_DIR, file);
      logger.info(
        `🔄 Converting interrupted recording: ${getFileName(rawFilePath)}`,
      );
      await RecordingService.convertAndUploadToServer(rawFilePath);
    });

    const uploadingPromises = filteredMp3Files.map(async (file) => {
      logger.info(
        `⬆️ Uploading interrupted file: ${getFileName(file)} to server...`,
      );
      const mp3FilePath = path.join(RECORDING_DIR, file);
      await RecordingService.uploadRecording(mp3FilePath);
    });

    if (filteredRawFiles?.length) {
      await Promise.all(conversionPromises);
    }
    if (filteredMp3Files?.length) {
      await Promise.all(uploadingPromises);
    }
    if (!filteredMp3Files?.length && !filteredRawFiles?.length) {
      logger.info("✅ Checking complete! No Interrupted files found");
    }
  } catch (err) {
    console.error(`❌ Error reading directory ${RECORDING_DIR}:`, err);
  }
};

startRecording(); // Start recording first
handleInterruptedFiles(); // Run it immediately once

// Then schedule periodic checks
setInterval(handleInterruptedFiles, CONVERSION_CHECK_INTERVAL);
