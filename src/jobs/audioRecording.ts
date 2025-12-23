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
import { flushQueueLoop } from "../services/notificationService";
import { DOAService } from "../services/doaService";

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
let currentRawFile: string | null = null; // Track current recording file

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
  channels: "6",
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
  const recordingStartTime = Date.now();

  const fileName = `${recordingStartTime}.raw`;
  recordingFiles.add(fileName);
  const rawFile = path.join(RECORDING_DIR, fileName);
  currentRawFile = rawFile; // Store current file path

  outputFileStream = fs.createWriteStream(rawFile, {
    encoding: "binary",
  });

  micInputStream.pipe(outputFileStream);

  let doaMonitoringStarted = false;

  micInputStream.on("startComplete", () => {
    logger.info(`🎙️ Recording started: ${fileName}`);
  });

  micInputStream.on("error", (err) => {
    logger.error(`⚠️ Mic error: ${err}`);
  });

  micInputStream.on("data", async function () {
    micLastActive = Date.now();
    isMicActive = true;

    // Start DOA monitoring on first data event
    if (!doaMonitoringStarted) {
      doaMonitoringStarted = true;
      await DOAService.startDOAMonitoring(recordingStartTime, 100);
    }
  });

  outputFileStream.once("finish", async () => {
    logger.info(`📁 Output file stream closed: ${rawFile}`);

    // Stop DOA monitoring and generate JSON file (normal completion)
    const doaJsonFilePath = await stopAndGenerateDOAJson(rawFile);

    if (!doaJsonFilePath) {
      logger.error(
        `❌ DOA JSON file not generated for recording: ${getFileName(rawFile)}`
      );
      currentRawFile = null; // Clear current file
      return;
    }

    currentRawFile = null; // Clear current file after processing
    RecordingService.convertAndUploadToServer(
      rawFile,
      doaJsonFilePath
    );

  });

  micInputStream.on("stopComplete", async () => {
    recordingSession = false;
    logger.info(`✅ Finished recording: ${getFileName(rawFile)}`);
    currentRawFile = null; // Clear current file
  });

  micInstance.start();
};


const stopAndGenerateDOAJson = async (rawFile: string) => {
  // Stop DOA monitoring and get segments
  const doaSegments = DOAService.stopDOAMonitoring();
  const recordingId = getFileName(rawFile).split(".")[0];

  // Always generate DOA JSON file, even with 0 segments (for server validation)
  // This ensures the server knows the file was processed with DOA support
  const doaJsonFilePath = DOAService.generateDOAJsonFile(
    doaSegments,
    recordingId,
    RECORDING_DIR
  );

  if (doaSegments.length === 0) {
    logger.warn(`⚠️ No DOA segments collected for recording: ${getFileName(rawFile)} (recording may have failed too quickly)`);
  }

  return doaJsonFilePath;
};

// Stops the current recording gracefully
export const stopRecording = async () => {
  if (micInstance) {
    // Stop DOA monitoring and generate JSON file before stopping (important for PM2 restarts)
    if (currentRawFile && recordingSession) {
      logger.info(`🛑 Stopping recording and generating DOA JSON for: ${getFileName(currentRawFile)}`);
      try {
        const doaJsonFilePath = await stopAndGenerateDOAJson(currentRawFile);
        if (doaJsonFilePath) {
          // Queue the file for conversion/upload (don't await to avoid blocking shutdown)
          RecordingService.convertAndUploadToServer(
            currentRawFile,
            doaJsonFilePath
          ).catch((err) => {
            logger.error(`❌ Error processing file after stop: ${err?.message || err}`);
          });
        }
      } catch (err: any) {
        logger.error(`❌ Error generating DOA JSON on stop: ${err?.message || err}`);
      }
    }

    // Stop mic
    micInstance.stop();

    // Wait a bit for stream to finish writing
    if (outputFileStream) {
      await new Promise<void>((resolve) => {
        outputFileStream.once("finish", () => resolve());
        outputFileStream.once("close", () => resolve());
        outputFileStream.end();
        // Timeout after 2 seconds to avoid hanging
        setTimeout(() => resolve(), 2000);
      });
    }

    outputFileStream?.close();
    micInputStream?.removeAllListeners(); // Prevent memory leaks
    await RecordingService.killExistingRecordings();
    currentRawFile = null; // Clear current file
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

    // Filter out raw files that don't have corresponding JSON files
    const rawFilesWithJson = filteredRawFiles.filter((file) => {
      const recordingId = path.basename(file, ".raw");
      const jsonFilePath = path.join(RECORDING_DIR, `${recordingId}.json`);
      return fs.existsSync(jsonFilePath);
    });

    // Log files missing JSON
    filteredRawFiles.forEach((file) => {
      const recordingId = path.basename(file, ".raw");
      const jsonFilePath = path.join(RECORDING_DIR, `${recordingId}.json`);
      if (!fs.existsSync(jsonFilePath)) {
        logger.error(
          `❌ DOA JSON file not found for interrupted recording: ${getFileName(file)}. Expected: ${getFileName(jsonFilePath)}`
        );
      }
    });

    const conversionPromises = rawFilesWithJson.map(async (file) => {
      const rawFilePath = path.join(RECORDING_DIR, file);
      const recordingId = path.basename(file, ".raw");
      const jsonFilePath = path.join(RECORDING_DIR, `${recordingId}.json`);

      logger.info(
        `🔄 Converting interrupted recording: ${getFileName(rawFilePath)}`
      );

      await RecordingService.convertAndUploadToServer(
        rawFilePath,
        jsonFilePath
      );
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
        const recordingId = path.basename(file, ".mp3");
        const jsonFilePath = path.join(RECORDING_DIR, `${recordingId}.json`);

        // Check if DOA JSON file exists for interrupted MP3 recording
        if (!fs.existsSync(jsonFilePath)) {
          logger.error(
            `❌ DOA JSON file not found for interrupted MP3 file: ${getFileName(file)}. Expected: ${getFileName(jsonFilePath)}`
          );
          continue;
        }

        try {
          await RecordingService.uploadRecording(mp3FilePath, jsonFilePath);
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
  // Install DOA dependencies (awaited to ensure they're ready before recording)
  try {
    await SystemService.installDOADependencies();
  } catch (err: any) {
    logger.error(`⚠️ Failed to install DOA dependencies: ${err?.message || err}`);
    // Continue anyway - DOA service has fallback mechanisms
  }

  startRecording(); // Start recording first
  scheduleNextRestart();
  await handleInterruptedFiles(); // Run it immediately once
  // SystemService.checkForUpdates(); // check for updates after all interrupted file handled to avoid interruption
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

const gracefulShutdown = async (signal: string) => {
  logger.info(`👋 Received ${signal}, gracefully shutting down...`);
  await stopRecording();
  // Give a moment for any pending operations
  await new Promise((resolve) => setTimeout(resolve, 1000));
  process.exit(0);
};

process.on("SIGINT", () => gracefulShutdown("SIGINT"));
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));

// Suppress unhandled USB errors (expected when Python method is used)
process.on("uncaughtException", (error: Error) => {
  const errorMsg = error.message || String(error);
  if (errorMsg.includes("LIBUSB") || errorMsg.includes("usb") || errorMsg.includes("MODULE_NOT_FOUND")) {
    // Suppress expected USB library errors - these are normal when Python method is preferred
    return;
  }
  // Log other unhandled exceptions
  logger.error(`❌ Uncaught exception: ${errorMsg}`);
  console.error(error);
});

// Suppress unhandled promise rejections from USB library
process.on("unhandledRejection", (reason: any) => {
  const errorMsg = reason?.message || String(reason);
  if (errorMsg.includes("LIBUSB") || errorMsg.includes("usb") || errorMsg.includes("MODULE_NOT_FOUND")) {
    // Suppress expected USB library errors
    return;
  }
  // Log other unhandled rejections
  logger.error(`❌ Unhandled rejection: ${errorMsg}`);
});

// Initialize background retry loop to resend queued notifications
// once internet connection (via socket) is restored
flushQueueLoop();
