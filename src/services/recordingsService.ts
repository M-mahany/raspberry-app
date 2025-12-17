import FormData from "form-data";
import { serverAPI } from "../utils/config/voiceApiConfig";
import fs from "fs";
import { isAxiosError } from "axios";
import { ffmpegService } from "./ffmpegService";
import logger from "../utils/winston/logger";
import { getFileName, getTimeZone } from "../utils/helpers";
import { execSync } from "child_process";

export interface DOAMetadata {
  doaAngle?: number | null;
  doaData?: Array<{ angle: number; timestamp: number }>;
  doaSegments?: Array<{
    start: number; // milliseconds
    end: number; // milliseconds
    channel: number; // 1-4
    angle: number; // DOA angle
  }>;
  doaReadings?: Array<{ angle: number; timestamp: number }>;
}

export class RecordingService {
  static async uploadRecording(
    filePath: string,
    doaMetadata?: DOAMetadata,
    fileType: "transcript" | "diarization" = "transcript",
    doaJsonFilePath?: string
  ): Promise<void> {
    try {
      const formData = new FormData();
      formData.append("mediaFile", fs.createReadStream(filePath));
      formData.append("timeZone", getTimeZone());
      formData.append("fileType", fileType);

      // Add DOA JSON file if it exists
      if (doaJsonFilePath && fs.existsSync(doaJsonFilePath)) {
        formData.append("doaJsonFile", fs.createReadStream(doaJsonFilePath));
        logger.info(
          `📎 Attaching DOA JSON file: ${getFileName(doaJsonFilePath)} to upload`
        );
      }

      // Add DOA segments for transcript files
      if (fileType === "transcript" && doaMetadata) {
        if (doaMetadata.doaSegments && doaMetadata.doaSegments.length > 0) {
          formData.append(
            "doaSegments",
            JSON.stringify(doaMetadata.doaSegments)
          );
        }
        //LOAI - FOR ME: check if we need to add this since we're getting the needed data from segments already "doaMetadata.doaReadings" and "the old format"
        if (doaMetadata.doaReadings && doaMetadata.doaReadings.length > 0) {
          formData.append(
            "doaReadings",
            JSON.stringify(doaMetadata.doaReadings)
          );
        }
        // LOAI - FOR ME: check if we need to add this since we're getting the needed data from segments already "doaMetadata.doaReadings" and "the old format"
        if (
          doaMetadata.doaAngle !== undefined &&
          doaMetadata.doaAngle !== null
        ) {
          formData.append("doaAngle", doaMetadata.doaAngle.toString());
        }
        if (doaMetadata.doaData && doaMetadata.doaData.length > 0) {
          formData.append("doaData", JSON.stringify(doaMetadata.doaData));
        }
      }

      // Add DOA metadata for diarization files (backward compatibility)
      //LOAI - FOR ME: check if we need since we're not using diarization files anymore
      if (fileType === "diarization" && doaMetadata) {
        if (
          doaMetadata.doaAngle !== undefined &&
          doaMetadata.doaAngle !== null
        ) {
          formData.append("doaAngle", doaMetadata.doaAngle.toString());
        }
        if (doaMetadata.doaData && doaMetadata.doaData.length > 0) {
          formData.append("doaData", JSON.stringify(doaMetadata.doaData));
        }
      }

      // Add recording ID to link transcript and diarization files (we're not using diarization files anymore) - will be removed later. LOAI - FOR ME: check if we need to add this since we're not using diarization files anymore
      const recordingId = getFileName(filePath).split(".")[0];
      formData.append("recordingId", recordingId);

      await serverAPI.post("/recordings/device-upload", formData, {
        headers: {
          ...formData.getHeaders(),
        },
      });

      logger.info(
        `✅ Uploaded ${getFileName(filePath)} (${fileType}) successfully to the server`
      );

      // Delete audio file after successful upload
      fs.unlink(filePath, (err) => {
        if (err) {
          logger.error(`🚨 Error deleting file after upload: ${err}`);
        }
      });

      // Delete JSON file after successful upload if it was attached
      if (doaJsonFilePath && fs.existsSync(doaJsonFilePath)) {
        fs.unlink(doaJsonFilePath, (err) => {
          if (err) {
            logger.error(
              `🚨 Error deleting DOA JSON file after upload: ${err}`
            );
          } else {
            logger.info(
              `🗑️ Deleted DOA JSON file: ${getFileName(doaJsonFilePath)}`
            );
          }
        });
      }
    } catch (error: any) {
      if (
        isAxiosError(error) &&
        error?.response?.data?.message?.includes(
          "already exists for this recording."
        )
      ) {
        fs.unlink(filePath, (err) => {
          logger.error(
            `🚨File: ${getFileName(filePath)}, already uploaded to the server`
          );
          if (err) {
            logger.error(
              `🚨 Error deleting file ${getFileName(filePath)} that has been already uploaded to server: ${err}`
            );
          }
        });
        // Delete JSON file if audio was already uploaded
        if (doaJsonFilePath && fs.existsSync(doaJsonFilePath)) {
          fs.unlink(doaJsonFilePath, (err) => {
            if (err) {
              logger.error(`🚨 Error deleting DOA JSON file: ${err}`);
            }
          });
        }
      } else {
        logger.error(
          `🚨 Failed uploading file ${getFileName(filePath)} to server: ${JSON.stringify(isAxiosError(error) ? error.toJSON?.() || error : error)}`
        );
        if (
          isAxiosError(error) &&
          error?.response?.data?.message?.includes("Invalid media file")
        ) {
          fs.unlink(filePath, (err) => {
            if (err) {
              logger.error(
                `🚨 Error deleting file ${getFileName(filePath)} - ${err}`
              );
            }
          });
          // Delete JSON file if audio file is invalid
          if (doaJsonFilePath && fs.existsSync(doaJsonFilePath)) {
            fs.unlink(doaJsonFilePath, (err) => {
              if (err) {
                logger.error(`🚨 Error deleting DOA JSON file: ${err}`);
              }
            });
          }
        }
        // Keep both files for retry if upload failed (don't delete)
      }
    }
  }

  static async convertAndUploadToServer(
    rawFile: string,
    currentRecordingFileSet?: Set<string>,
    doaMetadata?: DOAMetadata,
    doaJsonFilePath?: string
  ) {
    try {
      // Check if file is multi-channel (6 channels) or single channel
      // For backward compatibility, try multi-channel conversion first
      const conversionResult =
        await ffmpegService.convertMultiChannelAudio(rawFile);

      if (conversionResult.transcriptFile && conversionResult.diarizationFile) {
        // Multi-channel recording: upload transcript file with DOA segments and JSON file
        logger.info(
          `⬆️ Uploading transcript file: ${getFileName(conversionResult.transcriptFile)} to server...`
        );
        await this.uploadRecording(
          conversionResult.transcriptFile,
          doaMetadata, // Pass DOA segments here
          "transcript",
          doaJsonFilePath // Pass JSON file path to upload together
        );

        // Note: We're no longer uploading diarization WAV file
        // Delete it if it was created
        //LOAI - FOR ME: simplified the code since we're not using diarization files anymore
        if (conversionResult.diarizationFile) {
          try {
            fs.unlinkSync(conversionResult.diarizationFile);
            logger.info(
              `🗑️ Deleted diarization file: ${getFileName(conversionResult.diarizationFile)}`
            );
          } catch (err) {
            logger.warn(`⚠️ Could not delete diarization file: ${err}`);
          }
        }
      } else {
        // Fallback to single-channel conversion (backward compatibility)
        logger.warn(
          `⚠️ Multi-channel conversion failed, falling back to single-channel conversion`
        );
        const mp3File = await ffmpegService.convertAudioToMp3(rawFile);
        if (mp3File) {
          logger.info(
            `⬆️ Uploading file: ${getFileName(mp3File)} to server...`
          );
          await this.uploadRecording(
            mp3File,
            undefined,
            "transcript",
            doaJsonFilePath // Pass JSON file path to upload together
          );
        }
      }

      if (currentRecordingFileSet) {
        currentRecordingFileSet?.delete(getFileName(rawFile));
      }
    } catch (error) {
      logger.error(
        `🚨 Error Converting and uploading file:${getFileName(rawFile)}! ${error}`
      );

      // Clean up JSON file if audio conversion fails
      if (doaJsonFilePath && fs.existsSync(doaJsonFilePath)) {
        try {
          fs.unlinkSync(doaJsonFilePath);
          logger.warn(`⚠️ Deleted DOA JSON file due to conversion error`);
        } catch (err) {
          logger.warn(`⚠️ Could not delete DOA JSON file: ${err}`);
        }
      }
    }
  }
  static async killExistingRecordings() {
    try {
      const result = execSync("pgrep -af arecord").toString().trim();

      if (!result) {
        logger.info("✅ No active arecord processes detected.");
        return;
      }

      // const matchingLines = result
      //   .split("\n")
      //   .filter((line) => line.includes("arecord"));

      const matchingLines = result
        .split("\n")
        .filter((line) => /^(\d+)\s+arecord\b/.test(line));

      if (matchingLines.length === 0) {
        logger.info("✅ No relevant arecord processes running.");
        return;
      }

      logger.warn("⚠️ Detected active arecord process(es). Killing...");
      for (const line of matchingLines) {
        const pid = line.split(" ")[0];
        try {
          execSync(`sudo kill -9 ${pid}`);
          logger.info(`🛑 Killed arecord process PID: ${pid}`);
        } catch (killErr: any) {
          logger.error(
            `❌ Failed to kill PID ${pid}. Error: ${killErr?.message || killErr}`
          );
        }
      }
    } catch (error: any) {
      if (
        error.status === 1 &&
        error.message.includes("pgrep") &&
        error.stderr?.toString().includes("arecord")
      ) {
        logger.info("✅ No arecord process found.");
      } else {
        logger.error(
          `🚨 Error checking for existing arecord processes: ${
            error.message || error
          }`
        );
      }
    }
  }
}
