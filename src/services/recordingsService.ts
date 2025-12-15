import FormData from "form-data";
import { serverAPI } from "../utils/config/voiceApiConfig";
import fs from "fs";
import { isAxiosError } from "axios";
import { ffmpegService } from "./ffmpegService";
import logger from "../utils/winston/logger";
import { getFileName, getTimeZone } from "../utils/helpers";
import { execSync } from "child_process";
import { DOAService } from "./doaService";

interface DOAMetadata {
  doaAngle?: number | null;
  doaData?: Array<{ angle: number; timestamp: number }>;
}

export class RecordingService {
  static async uploadRecording(
    filePath: string,
    doaMetadata?: DOAMetadata,
    fileType: "transcript" | "diarization" = "transcript",
  ): Promise<void> {
    try {
      const formData = new FormData();
      formData.append("mediaFile", fs.createReadStream(filePath));
      formData.append("timeZone", getTimeZone());
      formData.append("fileType", fileType);

      // Add DOA metadata for diarization files
      if (fileType === "diarization" && doaMetadata) {
        if (doaMetadata.doaAngle !== undefined && doaMetadata.doaAngle !== null) {
          formData.append("doaAngle", doaMetadata.doaAngle.toString());
        }
        if (doaMetadata.doaData && doaMetadata.doaData.length > 0) {
          formData.append("doaData", JSON.stringify(doaMetadata.doaData));
        }
      }

      // Add recording ID to link transcript and diarization files
      const recordingId = getFileName(filePath).split("_")[0];
      formData.append("recordingId", recordingId);

      await serverAPI.post("/recordings/device-upload", formData, {
        headers: {
          ...formData.getHeaders(),
        },
      });

      logger.info(
        `✅ Uploaded ${getFileName(filePath)} (${fileType}) successfully to the server`,
      );
      fs.unlink(filePath, (err) => {
        if (err) {
          logger.error(`🚨 Error deleting file after upload: ${err}`);
        }
      });
    } catch (error: any) {
      if (
        isAxiosError(error) &&
        error?.response?.data?.message?.includes(
          "already exists for this recording.",
        )
      ) {
        fs.unlink(filePath, (err) => {
          logger.error(
            `🚨File: ${getFileName(filePath)}, already uploaded to the server`,
          );
          if (err) {
            logger.error(
              `🚨 Error deleting file ${getFileName(filePath)} that has been already uploaded to server: ${err}`,
            );
          }
        });
      } else {
        logger.error(
          `🚨 Failed uploading file ${getFileName(filePath)} to server: ${JSON.stringify(isAxiosError(error) ? error.toJSON?.() || error : error)}`,
        );
        if (
          isAxiosError(error) &&
          error?.response?.data?.message?.includes("Invalid media file")
        ) {
          fs.unlink(filePath, (err) => {
            if (err) {
              logger.error(
                `🚨 Error deleting file ${getFileName(filePath)} - ${err}`,
              );
            }
          });
        }
      }
    }
  }
  static async convertAndUploadToServer(
    rawFile: string,
    currentRecordingFileSet?: Set<string>,
    doaMetadata?: DOAMetadata,
  ) {
    try {
      // Check if file is multi-channel (6 channels) or single channel
      // For backward compatibility, try multi-channel conversion first
      const conversionResult =
        await ffmpegService.convertMultiChannelAudio(rawFile);

      if (
        conversionResult.transcriptFile &&
        conversionResult.diarizationFile
      ) {
        // Multi-channel recording: upload both files
        logger.info(
          `⬆️ Uploading transcript file: ${getFileName(conversionResult.transcriptFile)} to server...`,
        );
        await this.uploadRecording(
          conversionResult.transcriptFile,
          undefined,
          "transcript",
        );

        logger.info(
          `⬆️ Uploading diarization file: ${getFileName(conversionResult.diarizationFile)} to server...`,
        );
        await this.uploadRecording(
          conversionResult.diarizationFile,
          doaMetadata,
          "diarization",
        );
      } else {
        // Fallback to single-channel conversion (backward compatibility)
        logger.warn(
          `⚠️ Multi-channel conversion failed, falling back to single-channel conversion`,
        );
        const mp3File = await ffmpegService.convertAudioToMp3(rawFile);
        if (mp3File) {
          logger.info(
            `⬆️ Uploading file: ${getFileName(mp3File)} to server...`,
          );
          await this.uploadRecording(mp3File, undefined, "transcript");
        }
      }

      if (currentRecordingFileSet) {
        currentRecordingFileSet?.delete(getFileName(rawFile));
      }
    } catch (error) {
      logger.error(
        `🚨 Error Converting and uploading file:${getFileName(rawFile)}! ${error}`,
      );
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
            `❌ Failed to kill PID ${pid}. Error: ${killErr?.message || killErr}`,
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
          }`,
        );
      }
    }
  }
}
