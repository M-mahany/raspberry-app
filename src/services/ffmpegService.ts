import ffmpeg from "fluent-ffmpeg";
import fs from "fs";
import ffmpegInstaller from "@ffmpeg-installer/ffmpeg";
import ffprobeInstaller from "@ffprobe-installer/ffprobe";
import logger from "../utils/winston/logger";
import { getFileName } from "../utils/helpers";

ffmpeg.setFfmpegPath(ffmpegInstaller.path);
ffmpeg.setFfprobePath(ffprobeInstaller.path);

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
      // Convert to MP3 using ffmpeg with noise reduction
      return await new Promise<string | void>((resolve, reject) => {
        ffmpeg()
          .input(rawFile)
          .inputOptions([
            "-f",
            "s16le", // Signed 16-bit little-endian
            "-ar",
            "16000", // Sample rate 16kHz
            "-ac",
            "6", // 6 input channels
          ])
          .outputOptions([
            "-map_channel",
            "0.0.0", // Map channel 0 (beamformed/processed channel - best for speech)
            "-ac",
            "1", // Output mono
            "-ar",
            "16000", // Maintain 16kHz sample rate
            // Audio filters for noise reduction and background noise removal
            "-af",
            [
              // High-pass filter: remove low-frequency noise (below 80Hz) - removes rumble, clicks
              "highpass=f=80",
              // Low-pass filter: remove high-frequency noise (above 8000Hz) - removes hiss, clicks
              "lowpass=f=8000",
              // Noise gate: remove silence and quiet background noise
              // Threshold: -45dB (0.0056), ratio: 2.0, attack: 0.05s, release: 0.2s
              "agate=threshold=0.0056:ratio=2.0:attack=0.05:release=0.2",
              // Compressor: reduce dynamic range to minimize background noise
              "acompressor=threshold=0.1:ratio=3:attack=0.05:release=0.2",
              // Normalize audio levels
              "loudnorm=I=-16:TP=-1.5:LRA=11",
            ].join(","),
          ])
          .audioCodec("libmp3lame")
          .audioBitrate(128) // Set bitrate for MP3
          .format("mp3")
          .on("end", async () => {
            logger.info(`🎵 Converted to MP3 with noise reduction: ${getFileName(mp3File)}`);
            try {
              fs.unlinkSync(rawFile);
            } catch (unlinkErr) {
              logger.error(`⚠️ Error deleting raw file: ${unlinkErr}`);
            }
            resolve(mp3File);
          })
          .on("error", (err) => {
            logger.error(`⚠️ Error during conversion: ${err}`);
            reject(err);
          })
          .save(mp3File);
      });
    } catch (error: any) {
      logger.error(`🚨 Conversion failed: ${error?.message || error}`);
    }
  }

  static async getMediaMetadata(fileInput: string): Promise<MetadataMedia> {
    return new Promise((resolve, reject) => {
      ffmpeg()
        .input(fileInput)
        .ffprobe((err, metadata) => {
          if (err) {
            try {
              fs.unlinkSync(fileInput);
              return reject(
                new Error(
                  `Invalid media file: ${getFileName(fileInput)}, file is deleted`,
                ),
              );
            } catch (err: any) {
              logger.error(
                `error deleting corrupted file ${getFileName(fileInput)}`,
              );
              return reject(
                new Error(
                  `Error deleting corrupted file ${getFileName(fileInput)}: ${err?.message || err}`,
                ),
              );
            }
          }
          resolve({ fileSize: metadata.format?.size || 0 });
        });
    });
  }
}
