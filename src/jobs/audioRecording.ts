import fs from "fs-extra";
import mic, { MicInputStream, MicInstance, MicOptions } from "mic";
import dotenv from "dotenv";
import path from "path";
import {
  RecordingService,
  type DOAMetadata,
} from "../services/recordingsService";
import logger from "../utils/winston/logger";
import { getFileName } from "../utils/helpers";
import { SystemService } from "../services/systemService";
import dayjs from "dayjs";
import { WriteStream } from "fs";
import { flushQueueLoop } from "../services/notificationService";
import {
  DOAService,
  DOAReading,
  type DOASegment,
} from "../services/doaService";
import { formatDOASegments } from "../utils/helpers";

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
let currentRawFile: string | null = null; // Add this to track current recording file

let recordingSession = false;
let restartTimer: NodeJS.Timeout | null = null;
let micLastActive: number = Date.now();
let micHealthIntervalActive: NodeJS.Timeout | null = null;

// MIC VARIABLES
let isMicInterrupted = false;
export let isMicActive = false;

// MIC AUDIO OPTIONS
// Updated to 6 channels for ReSpeaker USB Mic Array:
// Channel 0: Processed audio (beamformed, noise suppressed)
// Channels 1-4: Raw data from each of the 4 microphones
// Channel 5: Playback audio (will be discarded during conversion)
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
      "Active recording is already in progress. Skipping starting new recording..."
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

  micInputStream.on("startComplete", async () => {
    logger.info(`🎙️ Recording started: ${fileName}`);
  });

  micInputStream.on("error", (err) => {
    logger.error(`⚠️ Mic error: ${err}`);
  });

  // Initialize DOA monitoring once (isolated from data events)
  // This prevents multiple initializations even if data event fires multiple times
  let doaMonitoringInitialized = false;
  const actualRecordingStartTime = Date.now();

  // Initialize DOA monitoring immediately when recording starts
  // This is isolated from the data event to prevent multiple initializations
  (async () => {
    if (!doaMonitoringInitialized) {
      doaMonitoringInitialized = true;
      await DOAService.initializeDOAMonitoring(actualRecordingStartTime, 100);
      logger.info(
        `📡 DOA monitoring initialized at recording start: ${actualRecordingStartTime}`
      );
    }
  })();

  micInputStream.on("data", async function () {
    micLastActive = Date.now();
    isMicActive = true;

    // Process DOA reading on data event (throttled internally to prevent CPU overload)
    // This is non-blocking and throttled to ~100ms intervals
    if (doaMonitoringInitialized) {
      // Fire and forget - throttling is handled inside processDOAReading()
      DOAService.processDOAReading().catch((error) => {
        logger.error(`⚠️ Error in DOA reading: ${error?.message || error}`);
      });
    }
  });

  outputFileStream.once("finish", async () => {
    logger.info(`📁 Output file stream closed: ${rawFile}`);

    // Extract recording ID from filename
    const recordingId = getFileName(rawFile).split(".")[0];

    // Stop DOA monitoring and get channel segments
    const doaResult = DOAService.stopDOAMonitoring();

    // Prepare DOA metadata for upload
    let doaMetadata;
    let doaJsonFilePath: string | undefined;

    if (
      typeof doaResult === "object" &&
      !Array.isArray(doaResult) &&
      "segments" in doaResult
    ) {
      // New format with segments
      const segmentsResult = doaResult as {
        segments: DOASegment[];
        readings: DOAReading[];
      };
      doaMetadata = {
        doaSegments:
          segmentsResult.segments.length > 0
            ? segmentsResult.segments
            : undefined,
        doaReadings:
          segmentsResult.readings.length > 0
            ? segmentsResult.readings
            : undefined,
      };

      // Generate JSON file when segments exist
      if (doaMetadata.doaSegments && doaMetadata.doaSegments.length > 0) {
        doaJsonFilePath = DOAService.generateDOAJsonFile(
          doaMetadata.doaSegments,
          recordingId,
          RECORDING_DIR
        );
        logger.info(
          `📄 Created DOA JSON file: ${getFileName(doaJsonFilePath)}`
        );
      }

      // Print DOA segments
      console.log("\n📊 ========== DOA SEGMENTS (Before Upload) ==========");
      if (doaMetadata.doaSegments) {
        console.log(formatDOASegments(doaMetadata.doaSegments));
        console.log("\n📊 Raw JSON:");
        console.log(JSON.stringify(doaMetadata.doaSegments, null, 2));
      }
      if (doaMetadata.doaReadings) {
        console.log(
          "\n📊 DOA Readings:",
          doaMetadata.doaReadings.length,
          "readings"
        );
      }
      console.log("📊 =================================================\n");
    } else {
      // Backward compatibility with old format
      const doaReadings = doaResult as DOAReading[];
      const latestDOAAngle = DOAService.getLatestDOAAngle();
      doaMetadata = {
        doaAngle: latestDOAAngle,
        doaData: doaReadings.length > 0 ? doaReadings : undefined,
      };
    }

    RecordingService.convertAndUploadToServer(
      rawFile,
      recordingFiles,
      doaMetadata,
      doaJsonFilePath
    );

    currentRawFile = null; // Clear current file reference after processing
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
    // Stop DOA monitoring if active and save segments to file
    if (
      DOAService.getDOAReadings().length > 0 ||
      DOAService.getDOASegments().length > 0
    ) {
      const doaResult = DOAService.stopDOAMonitoring();

      // Save DOA segments to JSON file if we have a current recording file
      if (currentRawFile) {
        const recordingId = getFileName(currentRawFile).split(".")[0];

        if (
          typeof doaResult === "object" &&
          !Array.isArray(doaResult) &&
          "segments" in doaResult
        ) {
          const segmentsResult = doaResult as {
            segments: DOASegment[];
            readings: DOAReading[];
          };

          // Save DOA segments to JSON file for later processing
          if (segmentsResult.segments.length > 0) {
            const doaJsonFilePath = DOAService.generateDOAJsonFile(
              segmentsResult.segments,
              recordingId,
              RECORDING_DIR
            );
            logger.info(
              `📄 Saved DOA segments to JSON file: ${getFileName(doaJsonFilePath)}`
            );
          }
        }
      }

      // Print DOA segments when manually stopping - LOAI - FOR ME: remove when done debugging
      if (
        typeof doaResult === "object" &&
        !Array.isArray(doaResult) &&
        "segments" in doaResult
      ) {
        const segmentsResult = doaResult as {
          segments: DOASegment[];
          readings: DOAReading[];
        };
        console.log("\n📊 ========== DOA SEGMENTS (On Manual Stop) ==========");
        console.log(formatDOASegments(segmentsResult.segments));
        console.log("\n📊 Raw JSON:");
        console.log(JSON.stringify(segmentsResult.segments, null, 2));
        console.log("📊 ===================================================\n");
      }
    }
    micInstance.stop();
    outputFileStream?.close();
    micInputStream?.removeAllListeners(); // Prevent memory leaks
    await RecordingService.killExistingRecordings();
    currentRawFile = null; // Clear current file reference
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
    logger.info("🔄 Checking Interrupted files...");

    // list of eligible .raw interrupted files
    const filteredRawFiles = files.filter(
      (file) => path.extname(file) === ".raw" && !recordingFiles.has(file)
    );
    // list of eligible .mp3 interrupted files (transcript files)
    const filteredMp3Files = files.filter((file) => {
      const fileNameWithoutExt = path.basename(file, ".mp3");
      const rawFileName = `${fileNameWithoutExt}.raw`;
      return (
        path.extname(file) === ".mp3" &&
        !recordingFiles.has(rawFileName) &&
        file.includes("_transcript")
      );
    });
    // list of eligible .wav interrupted files (diarization files)
    //LOAI - FOR ME: for later use if we need to use diarization files again
    const filteredWavFiles = files.filter((file) => {
      const fileNameWithoutExt = path.basename(file, ".wav");
      const rawFileName = `${fileNameWithoutExt}.raw`;
      return (
        path.extname(file) === ".wav" &&
        !recordingFiles.has(rawFileName) &&
        file.includes("_diarization")
      );
    });

    const conversionPromises = filteredRawFiles.map(async (file) => {
      const rawFilePath = path.join(RECORDING_DIR, file);
      const recordingId = path.basename(file, ".raw");
      const jsonFilePath = path.join(RECORDING_DIR, `${recordingId}.json`);

      logger.info(
        `🔄 Converting interrupted recording: ${getFileName(rawFilePath)}`
      );

      // Check if DOA JSON file exists for this interrupted recording
      let doaMetadata: DOAMetadata | undefined;
      let doaJsonFilePath: string | undefined;

      if (fs.existsSync(jsonFilePath)) {
        try {
          const jsonData = JSON.parse(fs.readFileSync(jsonFilePath, "utf-8"));
          logger.info(
            `📄 Found DOA JSON file for interrupted recording: ${getFileName(jsonFilePath)}`
          );

          doaMetadata = {
            doaSegments: jsonData.segments || undefined,
            doaReadings: jsonData.readings || undefined,
          };
          doaJsonFilePath = jsonFilePath;
        } catch (error: any) {
          logger.warn(
            `⚠️ Failed to read DOA JSON file ${getFileName(jsonFilePath)}: ${error?.message || error}`
          );
        }
      }

      await RecordingService.convertAndUploadToServer(
        rawFilePath,
        undefined,
        doaMetadata,
        doaJsonFilePath
      );
    });

    if (filteredRawFiles?.length) {
      await Promise.all(conversionPromises);
    }

    if (filteredMp3Files?.length) {
      for (const file of filteredMp3Files) {
        logger.info(
          `⬆️ Uploading interrupted transcript file: ${getFileName(file)} to server...`
        );
        const mp3FilePath = path.join(RECORDING_DIR, file);
        try {
          await RecordingService.uploadRecording(
            mp3FilePath,
            undefined,
            "transcript"
          );
        } catch (error: any) {
          logger.error(
            `❌ Error uploading file: ${getFileName(file)} - ${error?.message || error}`
          );
        }
      }
    }

    if (filteredWavFiles?.length) {
      for (const file of filteredWavFiles) {
        logger.info(
          `⬆️ Uploading interrupted diarization file: ${getFileName(file)} to server...`
        );
        const wavFilePath = path.join(RECORDING_DIR, file);
        try {
          // No DOA data available for interrupted files
          await RecordingService.uploadRecording(
            wavFilePath,
            undefined,
            "diarization"
          );
        } catch (error: any) {
          logger.error(
            `❌ Error uploading file: ${getFileName(file)} - ${error?.message || error}`
          );
        }
      }
    }

    if (
      !filteredMp3Files?.length &&
      !filteredWavFiles?.length &&
      !filteredRawFiles?.length
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
