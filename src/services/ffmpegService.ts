import ffmpeg from "fluent-ffmpeg";
import fs from "fs";
// import ffmpegInstaller from "@ffmpeg-installer/ffmpeg";
// import ffprobeInstaller from "@ffprobe-installer/ffprobe";
import logger from "../utils/winston/logger";
import { getFileName } from "../utils/helpers";

// ffmpeg.setFfmpegPath(ffmpegInstaller.path);
// ffmpeg.setFfprobePath(ffprobeInstaller.path);

// Set ffmpeg and ffprobe paths
ffmpeg.setFfmpegPath("/usr/bin/ffmpeg");
ffmpeg.setFfprobePath("/usr/bin/ffprobe");


interface MetadataMedia {
  fileSize: number;
}

export class ffmpegService {
  static async convertAudioToMp3(rawFile: string) {
    const mp3File = rawFile.replace(".raw", ".mp3");
    try {
      // Validate media file
      const { fileSize } = await this.getMediaMetadata(rawFile);
      if (!fileSize) {
        logger.warn(
          `⚠️ File ${getFileName(rawFile)} is corrupted, will not be converted.`,
        );
        return null;
      }
      // Convert to MP3 using ffmpeg
      return await new Promise<string | void>((resolve, reject) => {
        ffmpeg()
          .input(rawFile)
          .audioCodec("libmp3lame")
          .format("mp3")
          .on("end", async () => {
            logger.info(`🎵 Converted to MP3: ${getFileName(mp3File)}`);
            try {
              fs.unlinkSync(rawFile);
            } catch (unlinkErr) {
              logger.error("⚠️ Error deleting raw file:", unlinkErr);
            }
            resolve(mp3File);
          })
          .on("error", (err) => {
            logger.error("⚠️ Error during conversion:", err);
            reject(err);
          })
          .save(mp3File);
      });
    } catch (error: any) {
      console.log(error)
      logger.error("🚨 Conversion failed:", error?.message || error);
    }
  }

  static async getMediaMetadata(fileInput: string): Promise<MetadataMedia> {
    return new Promise((resolve, reject) => {
      ffmpeg()
        .input(fileInput)
        .ffprobe((err, metadata) => {
          if (err) {
            console.log(err)
            try {
              fs.unlinkSync(fileInput);
              return reject(
                new Error(
                  `Invalid media file: ${getFileName(fileInput)}, file is deleted`,
                ),
              );
            } catch (err) {
              logger.error(
                `error deleting corrupted file ${getFileName(fileInput)}`,
              );
            }
          }
          resolve({ fileSize: metadata.format?.size || 0 });
        });
    });
  }
}
