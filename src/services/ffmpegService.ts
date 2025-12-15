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

// Metadata for conversion results - new interface for teh conversion results
// transcriptFile: MP3 for Whisper, diarizationFile: WAV for diarization
interface ConversionResult {
  transcriptFile: string | null;
  diarizationFile: string | null;
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
          .inputOptions(["-f", "s16le", "-ar", "16000", "-ac", "1"])
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

  /**
   * Convert multi-channel RAW audio to two files:
   * - Channel 0 → MP3 (for Whisper transcription)
   * - Channels 1-4 → 4-channel WAV (for speaker diarization)
   */
  static async convertMultiChannelAudio(
    rawFile: string,
  ): Promise<ConversionResult> {
    const baseName = rawFile.replace(".raw", "");
    const transcriptFile = `${baseName}_transcript.mp3`;
    const diarizationFile = `${baseName}_diarization.wav`;

    try {
      // Validate media file
      const { fileSize } = await this.getMediaMetadata(rawFile);
      if (!fileSize) {
        logger.warn(
          `⚠️ File ${getFileName(rawFile)} is corrupted, will not be converted.`,
        );
        return { transcriptFile: null, diarizationFile: null };
      }

      // Convert both files in parallel
      const [transcriptResult, diarizationResult] = await Promise.allSettled([
        this.convertChannel0ToMp3(rawFile, transcriptFile),
        this.convertChannels1To4ToWav(rawFile, diarizationFile),
      ]);

      const transcriptSuccess =
        transcriptResult.status === "fulfilled" && transcriptResult.value;
      const diarizationSuccess =
        diarizationResult.status === "fulfilled" && diarizationResult.value;

      // Delete raw file only if both conversions succeeded
      if (transcriptSuccess && diarizationSuccess) {
        try {
          fs.unlinkSync(rawFile);
          logger.info(`🗑️ Deleted raw file: ${getFileName(rawFile)}`);
        } catch (unlinkErr) {
          logger.error(`⚠️ Error deleting raw file: ${unlinkErr}`);
        }
      }

      return {
        transcriptFile: transcriptSuccess ? transcriptFile : null,
        diarizationFile: diarizationSuccess ? diarizationFile : null,
      };
    } catch (error: any) {
      logger.error(
        `🚨 Multi-channel conversion failed: ${error?.message || error}`,
      );
      return { transcriptFile: null, diarizationFile: null };
    }
  }

  /**
   * Extract Channel 0 and convert to MP3 mono
   */
  private static async convertChannel0ToMp3(
    rawFile: string,
    outputFile: string,
  ): Promise<boolean> {
    return new Promise((resolve, reject) => {
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
          "0.0.0", // Map channel 0 from input stream 0
          "-ac",
          "1", // Output mono
          "-ar",
          "16000", // Maintain 16kHz sample rate
        ])
        .audioCodec("libmp3lame")
        .audioBitrate(128) // Set bitrate for MP3
        .format("mp3")
        .on("end", () => {
          logger.info(
            `🎵 Converted Channel 0 to MP3: ${getFileName(outputFile)}`,
          );
          resolve(true);
        })
        .on("error", (err) => {
          logger.error(
            `⚠️ Error converting Channel 0 to MP3: ${err.message}`,
          );
          reject(err);
        })
        .save(outputFile);
    }).catch(() => false);
  }

  /**
   * Extract Channels 1-4 and convert to 4-channel WAV
   */
  private static async convertChannels1To4ToWav(
    rawFile: string,
    outputFile: string,
  ): Promise<boolean> {
    return new Promise((resolve, reject) => {
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
          "0.0.1", // Map channel 1
          "-map_channel",
          "0.0.2", // Map channel 2
          "-map_channel",
          "0.0.3", // Map channel 3
          "-map_channel",
          "0.0.4", // Map channel 4
          "-ac",
          "4", // Output 4 channels
          "-ar",
          "16000", // Maintain 16kHz sample rate
        ])
        .audioCodec("pcm_s16le") // 16-bit PCM
        .format("wav")
        .on("end", () => {
          logger.info(
            `🎵 Converted Channels 1-4 to WAV: ${getFileName(outputFile)}`,
          );
          resolve(true);
        })
        .on("error", (err) => {
          logger.error(
            `⚠️ Error converting Channels 1-4 to WAV: ${err.message}`,
          );
          reject(err);
        })
        .save(outputFile);
    }).catch(() => false);
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
