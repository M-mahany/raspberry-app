import FormData from "form-data";
import { serverAPI } from "../utils/config/voiceApiConfig";
import fs from "fs";
import { isAxiosError } from "axios";
import { ffmpegService } from "./ffmpegService";

export class RecordingService {
  static async uploadRecording(filePath: string): Promise<void> {
    try {
      console.log(`⬆️ Uploading file: ${filePath} to server...`);
      const formData = new FormData();
      formData.append("mediaFile", fs.createReadStream(filePath));

      await serverAPI.post("/recordings/device-upload", formData, {
        headers: {
          ...formData.getHeaders(),
        },
      });

      console.log(`✅ Uploaded ${filePath} successfully to the server:`);
      fs.unlink(filePath, (err) => {
        if (err) {
          console.error(`Error deleting file after upload: ${err}`);
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
          console.error(`File: ${filePath}, already uploaded to the server`);
          if (err) {
            console.error(
              `Error deleting file ${filePath} that has been already uploaded to server: ${err}`,
            );
          }
        });
      }else{
        console.error(
          `Error uploading file ${filePath} to server ${isAxiosError(error) ? error?.response?.data?.message : error}`,
        );
      }
    }
  }
  static async convertAndUploadToServer(rawFile: string) {
    try {
      const mp3File = await ffmpegService.convertAudioToMp3(rawFile);
      if (mp3File) {
        await this.uploadRecording(mp3File);
      }
    } catch (error) {
      console.log(
        `🚨 Error Converting and uploading file:${rawFile}! ${error}`,
      );
    }
  }
}
