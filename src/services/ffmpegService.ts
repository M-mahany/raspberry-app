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
  static async convertAudioToMp3(rawFile: string, channelCount: number = 1) {
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
      const isMultiChannel = channelCount > 1;

      // Build input options based on channel count
      const inputOptions: string[] = [
        "-f",
        "s16le", // Signed 16-bit little-endian
        "-ar",
        "16000", // Sample rate 16kHz
      ];

      if (isMultiChannel) {
        // For 6-channel ReSpeaker USB Mic Array
        // Reference: https://wiki.seeedstudio.com/ReSpeaker-USB-Mic-Array/
        // 6-channel firmware layout:
        // - Channel 0: Processed audio for ASR (beamformed, noise-suppressed) ← USING THIS (best for transcription)
        // - Channels 1-4: 4 microphones' raw data (raw directional mics)
        // - Channel 5: Playback/reference channel
        inputOptions.push("-ac", channelCount.toString());
      } else {
        // For single-channel (normal mic)
        inputOptions.push("-ac", "1");
      }

      // Build output options
      const outputOptions: string[] = [
        "-ac",
        "1", // Output mono
        "-ar",
        "16000", // Maintain 16kHz sample rate
      ];

      // Only map channel 0 for multi-channel recordings
      if (isMultiChannel) {
        outputOptions.unshift(
          "-map_channel",
          "0.0.0", // Map channel 0 (processed audio - beamformed, noise-suppressed, optimized for ASR)
        );
      }

      return await new Promise<string | void>((resolve, reject) => {
        ffmpeg()
          .input(rawFile)
          .inputOptions(inputOptions)
          .outputOptions(outputOptions)
          .audioCodec("libmp3lame")
          .format("mp3")
          .on("end", async () => {
            logger.info(`🎵 Converted to MP3: ${getFileName(mp3File)}`);
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
