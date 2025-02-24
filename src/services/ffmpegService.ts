import ffmpeg from "fluent-ffmpeg";
import fs from "fs/promises"; // Use promises for better async handling
import ffmpegInstaller from "@ffmpeg-installer/ffmpeg";
import ffprobeInstaller from "@ffprobe-installer/ffprobe";

// Set ffmpeg and ffprobe paths
ffmpeg.setFfmpegPath(ffmpegInstaller.path);
ffmpeg.setFfprobePath(ffprobeInstaller.path);

interface MetadataMedia {
  fileSize: number;
}

export class ffmpegService {
  static async convertAudioToMp3(rawFile: string, mp3File: string) {
    try {
      // Validate media file
      const { fileSize } = await this.getMediaMetadata(rawFile);
      if (!fileSize) {
        console.log(`⚠️ File ${rawFile} is corrupted, will not be converted.`);
        return;
      }

      // Convert to MP3 using ffmpeg
      return new Promise<void>((resolve, reject) => {
        ffmpeg()
          .input(rawFile)
          .audioCodec("libmp3lame")
          .format("mp3")
          .on("end", async () => {
            console.log(`🎵 Converted to MP3: ${mp3File}`);

            try {
              await fs.unlink(rawFile);
              console.log(`🗑️ Deleted raw file: ${rawFile}`);
            } catch (unlinkErr) {
              console.error("⚠️ Error deleting raw file:", unlinkErr);
            }

            resolve();
          })
          .on("error", (err) => {
            console.error("⚠️ Error during conversion:", err);
            reject(err);
          })
          .save(mp3File);
      });
    } catch (error) {
      console.error("🚨 Conversion failed:", error);
    }
  }

  static async getMediaMetadata(fileInput: string): Promise<MetadataMedia> {
    return new Promise((resolve, reject) => {
      ffmpeg()
        .input(fileInput)
        .ffprobe((err, metadata) => {
          if (err) {
            return reject(new Error(`Invalid media file: ${fileInput}`));
          }
          resolve({ fileSize: metadata.format?.size || 0 });
        });
    });
  }
}
