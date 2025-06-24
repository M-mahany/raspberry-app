import fs from "fs-extra";
import mic, { MicInputStream, MicInstance, MicOptions } from "mic";
import dotenv from "dotenv";
import path from "path";
import { RecordingService } from "../services/recordingsService";
import logger from "../utils/winston/logger";
import { getFileName } from "../utils/helpers";
import { SystemService } from "../services/systemService";
import dayjs from "dayjs";
import { WriteStream } from "fs";

dotenv.config();

// RECORDING DIRECTORY
const RECORDING_DIR = process.env.RECORDING_DIR || "./pending_upload";
fs.ensureDirSync(RECORDING_DIR);

// DEFAULT VARIABLES
const RECORDING_INTERVAL = 2 * 60 * 60 * 1000; // 2 hours in milliseconds
const CONVERSION_CHECK_INTERVAL = 3 * 60 * 60 * 1000;
// const NORMAL_FILE_DURATION = 7020; // 1 hour & 57 minutes accepted range of recording
const recordingFiles = new Set<string>(); // Stores active recordings

// DYNAMIC VARIABLES
let micInstance: MicInstance;
let micInputStream: MicInputStream;
let outputFileStream: WriteStream;

let recordingSession = false;
let restartTimer: NodeJS.Timeout | null = null;
let micLastActive: number = Date.now();
let micHealthIntervalActive: NodeJS.Timeout | null = null;

// MIC VARIABLES
let isMicInterrupted = false;
export let isMicActive = false;

// MIC AUDIO OPTIONS
const micOptions: MicOptions = {
  rate: "16000",
  channels: "1",
  bitwidth: "16",
  encoding: "signed-integer",
  fileType: "raw",
  debug: true,
};

export const startRecording = async () => {
  if (recordingSession) {
    logger.warn(
      "Active recording is already in progress. Skipping starting new recording...",
    );
    return;
  }

  isMicInterrupted = false;

  await SystemService.checkMicOnStart(isMicActive);

  const device = (await SystemService.getDefaultMicDevice()) || "plughw:1,0";

  micInstance = mic({ ...micOptions, device });

  micInputStream = micInstance.getAudioStream();

  recordingSession = true;

  const fileName = `${Date.now()}.raw`;
  recordingFiles.add(fileName);
  const rawFile = path.join(RECORDING_DIR, fileName);

  outputFileStream = fs.createWriteStream(rawFile, {
    encoding: "binary",
  });

  micInputStream.pipe(outputFileStream);

  micInputStream.on("startComplete", () => {
    logger.info(`🎙️ Recording started: ${fileName}`);
  });

  micInputStream.on("error", (err) => {
    logger.error(`⚠️ Mic error: ${err}`);
  });

  micInputStream.on("data", function () {
    micLastActive = Date.now();
    isMicActive = true;
  });

  outputFileStream.once("finish", async () => {
    logger.info(`📁 Output file stream closed: ${rawFile}`);
    RecordingService.convertAndUploadToServer(rawFile, recordingFiles);
  });

  micInputStream.on("stopComplete", async () => {
    recordingSession = false;
    logger.info(`✅ Finished recording: ${getFileName(rawFile)}`);
  });

  micInstance.start();
};

// Stops the current recording gracefully
export const stopRecording = async () => {
  if (micInstance) {
    micInstance.stop();
    outputFileStream?.close();
    micInputStream?.removeAllListeners(); // Prevent memory leaks
    await RecordingService.killExistingRecordings();
  }
};

// Restart recording on error or interruption
export const restartRecording = async () => {
  logger.info("🔄 Restarting recording...");
  await stopRecording();

  if (dayjs().hour() === 0) {
    logger.info("🌙 It's midnight! Waiting 1 second before new session.");
  }

  setTimeout(() => startRecording(), 1000);
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

    if (filteredRawFiles?.length) {
      await Promise.all(conversionPromises);
    }

    if (filteredMp3Files?.length) {
      for (const file of filteredMp3Files) {
        logger.info(
          `⬆️ Uploading interrupted file: ${getFileName(file)} to server...`,
        );
        const mp3FilePath = path.join(RECORDING_DIR, file);
        try {
          await RecordingService.uploadRecording(mp3FilePath);
        } catch (error: any) {
          logger.error(
            `❌ Error uploading file: ${getFileName(file)} - ${error?.message || error}`,
          );
        }
      }
    }
    if (!filteredMp3Files?.length && !filteredRawFiles?.length) {
      logger.info("✅ Checking complete! No Interrupted files found");
    }
  } catch (err) {
    console.error(`❌ Error reading directory ${RECORDING_DIR}:`, err);
  }
};

// Restart recording periodically (e.g. every 2h or at midnight)
export const scheduleNextRestart = () => {
  if (restartTimer) return;
  const now = dayjs();
  // Calculate time until next 12:00 AM
  const nextMidnight = now.endOf("day");
  const timeUntilMidnight = nextMidnight.diff(now);

  // Determine the shorter interval: 2 hours or time until midnight
  const stopInterval = Math.min(RECORDING_INTERVAL, timeUntilMidnight);

  restartTimer = setTimeout(async () => {
    restartTimer = null;
    await restartRecording();
    scheduleNextRestart(); // Re-schedule based on new current time
  }, stopInterval);
};

const runOnStart = async () => {
  startRecording(); // Start recording first
  scheduleNextRestart();
  await handleInterruptedFiles(); // Run it immediately once
  SystemService.checkForUpdates(); // check for updates after all interrupted file handled to avoid interruption
};

runOnStart();

export function cancelNextRestart() {
  if (restartTimer) {
    clearTimeout(restartTimer);
    restartTimer = null;
    console.log("🛑 Restart schedule canceled.");
  }
}

export const startMicHealthCheckInterval = async () => {
  if (micHealthIntervalActive) return;

  micHealthIntervalActive = setTimeout(async () => {
    const isMicAvailable = await SystemService.isMicAvailable();

    if (!isMicAvailable) {
      micHealthIntervalActive = null;
      startMicHealthCheckInterval();
    } else {
      cancelMicHealthCheckInterval();
      restartRecording();
      scheduleNextRestart();
    }
  }, 10000);
};

export function cancelMicHealthCheckInterval() {
  if (micHealthIntervalActive) {
    clearTimeout(micHealthIntervalActive);
    micHealthIntervalActive = null;
    logger.info("Cancelled Mic Health Check Interval");
  }
}

const micMonitor = () => {
  if (
    Date.now() - micLastActive > 3000 &&
    !isMicInterrupted &&
    recordingSession
  ) {
    logger.error(`⚠️ Mic Interrupted, handling interruption in progress...`);
    isMicInterrupted = true;
    isMicActive = false;
    SystemService.handleMicInterruption("firstAttempt");
  }
};

// Then schedule periodic checks
setInterval(handleInterruptedFiles, CONVERSION_CHECK_INTERVAL);

setInterval(() => {
  micMonitor();
  SystemService.CPUHealthUsage();
}, 3000);

SystemService.realTimeUsbEventDetection();

process.on("SIGINT", async () => {
  logger.info("👋 Gracefully shutting down...");
  await stopRecording();
  process.exit(0);
});
