import FormData from "form-data";
import { serverAPI } from "../utils/config/voiceApiConfig";
import fs from "fs";
import { isAxiosError } from "axios";
import { ffmpegService } from "./ffmpegService";
import logger from "../utils/winston/logger";
import { getFileName, getTimeZone } from "../utils/helpers";
import { execSync } from "child_process";

export class RecordingService {
  static async uploadRecording(filePath: string): Promise<void> {
    try {
      const formData = new FormData();
      formData.append("mediaFile", fs.createReadStream(filePath));
      formData.append("timeZone", getTimeZone());
      await serverAPI.post("/recordings/device-upload", formData, {
        headers: {
          ...formData.getHeaders(),
        },
      });

      logger.info(
        `✅ Uploaded ${getFileName(filePath)} successfully to the server:`,
      );
      fs.unlink(filePath, (err) => {
        if (err) {
          logger.error(`🚨 Error deleting file after upload: ${err}`);
        }
      });
    } catch (error) {
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
          `🚨 Error uploading file ${getFileName(filePath)} to server ${isAxiosError(error) ? error?.response?.data?.message : error}`,
        );
      }
    }
  }
  static async convertAndUploadToServer(
    rawFile: string,
    currentRecordingFileSet?: Set<string>,
  ) {
    try {
      const mp3File = await ffmpegService.convertAudioToMp3(rawFile);
      if (mp3File) {
        logger.info(`⬆️ Uploading file: ${getFileName(mp3File)} to server...`);
        await this.uploadRecording(mp3File);
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
      const result = execSync("pgrep -af arecord").toString();
      if (result) {
        logger.warn("⚠️ Detected active arecord process! Killing it...");
        execSync("pkill -9 arecord");
      }
    } catch (error) {
      logger.error(
        `🚨 Error checking and killing previous mic process: ${error}`,
      );
    }
  }
}
