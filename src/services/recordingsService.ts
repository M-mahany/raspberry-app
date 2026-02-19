import FormData from "form-data";
import { serverAPI } from "../utils/config/voiceApiConfig";
import fs from "fs";
import { isAxiosError } from "axios";
import { ffmpegService } from "./ffmpegService";
import logger from "../utils/winston/logger";
import { getFileName, getTimeZone } from "../utils/helpers";
import { execSync } from "child_process";

export class RecordingService {
  /**
   * Delete both audio file and its corresponding JSON file as a pair
   */
  static async deleteFilePair(
    audioFilePath: string,
    jsonFilePath: string | undefined,
    reason: string,
  ): Promise<void> {
    try {
      // Delete audio file
      if (fs.existsSync(audioFilePath)) {
        await fs.promises.unlink(audioFilePath);
        logger.info(
          `🗑️ Deleted audio file: ${getFileName(audioFilePath)} (${reason})`,
        );
      }

      // Delete JSON file
      if (jsonFilePath && fs.existsSync(jsonFilePath)) {
        await fs.promises.unlink(jsonFilePath);
        logger.info(
          `🗑️ Deleted JSON file: ${getFileName(jsonFilePath)} (${reason})`,
        );
      }
    } catch (err: any) {
      logger.error(
        `🚨 Error deleting file pair (${reason}): ${err?.message || err}`,
      );
    }
  }
  static async uploadRecording(
    filePath: string,
    doaJsonFilePath: string | undefined,
  ): Promise<void> {
    try {
      const formData = new FormData();
      formData.append("mediaFile", fs.createReadStream(filePath));
      formData.append("timeZone", getTimeZone());

      if (doaJsonFilePath) {
        // Add DOA JSON file (required)
        if (!fs.existsSync(doaJsonFilePath)) {
          throw new Error(`DOA JSON file not found: ${doaJsonFilePath}`);
        }

        formData.append("hasDoa", "true"); // Indicates this is the new version with DOA data
        formData.append("doaJsonFile", fs.createReadStream(doaJsonFilePath));
        logger.info(
          `📎 Attaching DOA JSON file: ${getFileName(doaJsonFilePath)}`,
        );
      }

      await serverAPI.post("/recordings/device-upload", formData, {
        headers: {
          ...formData.getHeaders(),
        },
      });

      logger.info(
        `✅ Uploaded ${getFileName(filePath)} successfully to the server`,
      );

      // Delete both files after successful upload
      await this.deleteFilePair(filePath, doaJsonFilePath, "successful upload");
    } catch (error: any) {
      if (
        isAxiosError(error) &&
        error?.response?.data?.message?.includes(
          "already exists for this recording.",
        )
      ) {
        // File already uploaded - delete both files
        await this.deleteFilePair(
          filePath,
          doaJsonFilePath,
          "already uploaded to server",
        );
      } else {
        logger.error(
          `🚨 Failed uploading file ${getFileName(filePath)} to server: ${JSON.stringify(isAxiosError(error) ? error.toJSON?.() || error : error)}`,
        );
        if (
          isAxiosError(error) &&
          error?.response?.data?.message?.includes("Invalid media file")
        ) {
          // Delete both files if media file is invalid (treat as pair)
          await this.deleteFilePair(
            filePath,
            doaJsonFilePath,
            "invalid media file",
          );
        }
      }
    }
  }

  static async convertAndUploadToServer(
    rawFile: string,
    doaJsonFilePath: string | undefined,
  ) {
    try {
      // Determine channel count: 6 channels if DOA JSON exists (ReSpeaker mic array), otherwise 1 channel (normal mic)
      const channelCount = doaJsonFilePath ? 6 : 1;
      const mp3File = await ffmpegService.convertAudioToMp3(
        rawFile,
        channelCount,
      );
      if (mp3File) {
        logger.info(`⬆️ Uploading file: ${getFileName(mp3File)} to server...`);
        // uploadRecording handles deletion of mp3File and doaJsonFilePath on success/error
        await this.uploadRecording(mp3File, doaJsonFilePath);
        // Delete raw file after successful upload (mp3 and JSON already deleted by uploadRecording)
        if (fs.existsSync(rawFile)) {
          try {
            await fs.promises.unlink(rawFile);
            logger.info(
              `🗑️ Deleted raw file after successful conversion/upload: ${getFileName(rawFile)}`,
            );
          } catch (err: any) {
            logger.error(
              `🚨 Error deleting raw file after successful upload: ${err?.message || err}`,
            );
          }
        }
      } else {
        // Conversion failed - delete both raw and JSON files
        await this.deleteFilePair(
          rawFile,
          doaJsonFilePath,
          "conversion failed",
        );
        throw new Error("Audio conversion failed - file may be corrupted");
      }
    } catch (error: any) {
      logger.error(
        `🚨 Error Converting and uploading file:${getFileName(rawFile)}! ${error?.message || error}`,
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
