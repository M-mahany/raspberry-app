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

let recordingSession = false;
let restartTimer: NodeJS.Timeout | null = null;
let micLastActive: number = Date.now();
let micHealthIntervalActive: NodeJS.Timeout | null = null;

// MIC VARIABLES
let isMicInterrupted = false;
export let isMicActive = false;

export let micInfo = {
  isMicArray: false,
  channelCount: 1,
  isDOACapable: false,
};

// MIC AUDIO OPTIONS
const getMicOptions = (channelCount: number): MicOptions => {
  return {
    rate: "16000",
    channels: channelCount.toString(),
    bitwidth: "16",
    encoding: "signed-integer",
    fileType: "raw",
    debug: true,
  };
};

export const startRecording = async () => {
  if (recordingSession) {
    logger.warn(
      "Active recording is already in progress. Skipping starting new recording...",
    );
    return;
  }

  isMicInterrupted = false;

  micInfo = await SystemService.detectMicType();

  const micOptions = getMicOptions(micInfo.channelCount);

  logger.info(
    `🎤 Starting recording with ${micInfo.isMicArray ? "6-channel mic array" : "normal mic"} (${micInfo.channelCount} channels)`,
  );

  await SystemService.checkMicOnStart(isMicActive);

  const device = (await SystemService.getDefaultMicDevice()) || "plughw:1,0";

  micInstance = mic({ ...micOptions, device });

  micInputStream = micInstance.getAudioStream();

  recordingSession = true;
  const recordingStartTime = Date.now();

  const fileName = `${recordingStartTime}.raw`;
  recordingFiles.add(fileName);
  const rawFile = path.join(RECORDING_DIR, fileName);

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
      if (micInfo.isDOACapable) {
        logger.info("📡 Starting DOA monitoring for 6-channel mic array");
        await DOAService.startDOAMonitoring(recordingStartTime, 100);
      } else {
        logger.info("ℹ️ DOA monitoring disabled - normal mic detected");
      }
    }
  });

  outputFileStream.once("finish", async () => {
    logger.info(`📁 Output file stream closed: ${rawFile}`);

    let doaJsonFilePath: string | undefined;
    if (micInfo.isDOACapable) {
      logger.info("📡 Stopping DOA monitoring for 6-channel mic array");
      // Stop DOA monitoring and generate JSON file (normal completion)
      doaJsonFilePath = await stopAndGenerateDOAJson(rawFile);

      if (!doaJsonFilePath) {
        logger.error(
          `❌ DOA JSON file not generated for recording: ${getFileName(rawFile)}. will be processed as normal recording`,
        );
        // Delete the raw file since it doesn't have a JSON file (invalid)
        // try {
        //   await fs.unlink(rawFile);
        //   logger.info(
        //     `🗑️ Deleted recording without JSON DOA: ${getFileName(rawFile)}`,
        //   );
        // } catch (err: any) {
        //   logger.error(
        //     `🚨 Error deleting invalid recording: ${err?.message || err}`,
        //   );
        // }
        // return;
      }
    }

    RecordingService.convertAndUploadToServer(rawFile, doaJsonFilePath);
  });

  micInputStream.on("stopComplete", async () => {
    recordingSession = false;
    logger.info(`✅ Finished recording: ${getFileName(rawFile)}`);
  });

  micInstance.start();
};

const stopAndGenerateDOAJson = async (rawFile: string) => {
  // Stop DOA monitoring and get segments
  const doaSegments = DOAService.stopDOAMonitoring();
  const recordingId = getFileName(rawFile).split(".")[0];
  let doaJsonFilePath: string | undefined;

  // Generate DOA JSON file if segments exist
  if (doaSegments.length > 0) {
    doaJsonFilePath = DOAService.generateDOAJsonFile(
      doaSegments,
      recordingId,
      RECORDING_DIR,
    );
  }

  return doaJsonFilePath;
};

// Stops the current recording gracefully
export const stopRecording = async () => {
  if (micInstance) {
    // Stop mic - this will trigger stopComplete event which handles DOA JSON generation
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
    // Detect mic type first (in case this runs before startRecording sets micInfo)
    // const currentMicInfo = await SystemService.detectMicType();
    // const isDOACapable = currentMicInfo.isDOACapable;

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

    // Only check for JSON files when DOA is capable
    // For normal mics, recordings don't have JSON files and should be processed normally
    const filesToDelete: Array<{ file: string; type: "raw" | "mp3" }> = [];

    // if (isDOACapable) {
    //   // For DOA-capable mics: find audio files that don't have corresponding JSON files (invalid - should be deleted)
    //   filteredRawFiles.forEach((file) => {
    //     const recordingId = path.basename(file, ".raw");
    //     const jsonFilePath = path.join(RECORDING_DIR, `${recordingId}.json`);
    //     if (!fs.existsSync(jsonFilePath)) {
    //       filesToDelete.push({ file, type: "raw" });
    //       logger.warn(
    //         `⚠️ Raw file missing JSON DOA file: ${getFileName(file)}. Will be deleted.`,
    //       );
    //     }
    //   });

    //   filteredMp3Files.forEach((file) => {
    //     const recordingId = path.basename(file, ".mp3");
    //     const jsonFilePath = path.join(RECORDING_DIR, `${recordingId}.json`);
    //     if (!fs.existsSync(jsonFilePath)) {
    //       filesToDelete.push({ file, type: "mp3" });
    //       logger.warn(
    //         `⚠️ MP3 file missing JSON DOA file: ${getFileName(file)}. Will be deleted.`,
    //       );
    //     }
    //   });
    // }

    // Find and delete orphaned JSON files (JSON files without corresponding audio files)
    // Always clean up orphaned JSON files regardless of mic type

    const jsonFiles = files.filter((file) => path.extname(file) === ".json");
    const orphanedJsonFiles: string[] = [];
    jsonFiles.forEach((file) => {
      const recordingId = path.basename(file, ".json");
      const rawFilePath = path.join(RECORDING_DIR, `${recordingId}.raw`);
      const mp3FilePath = path.join(RECORDING_DIR, `${recordingId}.mp3`);

      // Check if neither raw nor mp3 file exists
      if (!fs.existsSync(rawFilePath) && !fs.existsSync(mp3FilePath)) {
        // Also check if it's not an active recording
        if (!recordingFiles.has(`${recordingId}.raw`)) {
          orphanedJsonFiles.push(file);
          logger.warn(
            `⚠️ Orphaned JSON file (no corresponding audio): ${getFileName(file)}. Will be deleted.`,
          );
        }
      }
    });

    // Delete invalid audio files (missing JSON) - only for DOA-capable mics
    for (const { file, type } of filesToDelete) {
      const audioFilePath = path.join(RECORDING_DIR, file);
      try {
        await fs.promises.unlink(audioFilePath);
        logger.info(
          `🗑️ Deleted invalid ${type.toUpperCase()} file (missing JSON): ${getFileName(audioFilePath)}`,
        );
      } catch (err: any) {
        logger.error(
          `🚨 Error deleting invalid ${type.toUpperCase()} file: ${err?.message || err}`,
        );
      }
    }

    // Delete orphaned JSON files (no corresponding audio files)
    for (const file of orphanedJsonFiles) {
      const jsonFilePath = path.join(RECORDING_DIR, file);
      try {
        await fs.promises.unlink(jsonFilePath);
        logger.info(
          `🗑️ Deleted orphaned JSON file: ${getFileName(jsonFilePath)} (no corresponding audio file)`,
        );
      } catch (err: any) {
        logger.error(
          `🚨 Error deleting orphaned JSON file: ${err?.message || err}`,
        );
      }
    }

    // Process raw files
    // if (isDOACapable) {
    //   // For DOA-capable mics: only process raw files that have corresponding JSON files
    //   const rawFilesWithJson = filteredRawFiles.filter((file) => {
    //     const recordingId = path.basename(file, ".raw");
    //     const jsonFilePath = path.join(RECORDING_DIR, `${recordingId}.json`);
    //     return fs.existsSync(jsonFilePath);
    //   });

    //   const conversionPromises = rawFilesWithJson.map(async (file) => {
    //     const rawFilePath = path.join(RECORDING_DIR, file);
    //     const recordingId = path.basename(file, ".raw");
    //     const jsonFilePath = path.join(RECORDING_DIR, `${recordingId}.json`);

    //     logger.info(
    //       `🔄 Converting interrupted recording: ${getFileName(rawFilePath)}`,
    //     );

    //     // convertAndUploadToServer already handles file deletion on success/error
    //     await RecordingService.convertAndUploadToServer(
    //       rawFilePath,
    //       jsonFilePath,
    //     );
    //   });

    //   if (rawFilesWithJson?.length) {
    //     await Promise.all(conversionPromises);
    //   }
    // } else {
    // For normal mics: process all raw files (no JSON required)

    const conversionPromises = filteredRawFiles.map(async (file) => {
      const rawFilePath = path.join(RECORDING_DIR, file);
      const recordingId = path.basename(file, ".raw");
      const jsonFilePath = path.join(RECORDING_DIR, `${recordingId}.json`);

      logger.info(
        `🔄 Converting interrupted recording: ${getFileName(rawFilePath)}`,
      );

      // convertAndUploadToServer already handles file deletion on success/error
      // Pass undefined for JSON file path since normal mics don't have DOA data
      await RecordingService.convertAndUploadToServer(
        rawFilePath,
        jsonFilePath,
      );
    });

    if (filteredRawFiles?.length) {
      await Promise.all(conversionPromises);
    }
    // }

    // Process MP3 files
    // if (isDOACapable) {
    //   // For DOA-capable mics: only process MP3 files that have corresponding JSON files
    //   const mp3FilesWithJson = filteredMp3Files.filter((file) => {
    //     const recordingId = path.basename(file, ".mp3");
    //     const jsonFilePath = path.join(RECORDING_DIR, `${recordingId}.json`);
    //     return fs.existsSync(jsonFilePath);
    //   });

    //   if (mp3FilesWithJson?.length) {
    //     for (const file of mp3FilesWithJson) {
    //       logger.info(
    //         `⬆️ Uploading interrupted file: ${getFileName(file)} to server...`,
    //       );
    //       const mp3FilePath = path.join(RECORDING_DIR, file);
    //       const recordingId = path.basename(file, ".mp3");
    //       const jsonFilePath = path.join(RECORDING_DIR, `${recordingId}.json`);

    //       // uploadRecording already handles file deletion on success/error
    //       await RecordingService.uploadRecording(mp3FilePath, jsonFilePath);
    //     }
    //   }
    // } else {
    // For normal mics: process all MP3 files (no JSON required)
    if (filteredMp3Files?.length) {
      for (const file of filteredMp3Files) {
        logger.info(
          `⬆️ Uploading interrupted file: ${getFileName(file)} to server...`,
        );
        const mp3FilePath = path.join(RECORDING_DIR, file);
        const recordingId = path.basename(file, ".mp3");
        const jsonFilePath = path.join(RECORDING_DIR, `${recordingId}.json`);

        // uploadRecording already handles file deletion on success/error
        // Pass undefined for JSON file path since normal mics don't have DOA data
        await RecordingService.uploadRecording(mp3FilePath, jsonFilePath);
      }
    }
    // }

    if (
      !filteredMp3Files?.length &&
      !filteredRawFiles?.length &&
      !filesToDelete.length &&
      !orphanedJsonFiles.length
    ) {
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
    logger.error(
      `⚠️ Failed to install DOA dependencies: ${err?.message || err}`,
    );
    // Continue anyway - DOA service has fallback mechanisms
  }

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

// Initialize background retry loop to resend queued notifications
// once internet connection (via socket) is restored
flushQueueLoop();
