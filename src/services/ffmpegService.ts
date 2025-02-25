import ffmpeg from "fluent-ffmpeg";
import fs from "fs"; // Use promises for better async handling
import ffmpegInstaller from "@ffmpeg-installer/ffmpeg";
import ffprobeInstaller from "@ffprobe-installer/ffprobe";

// Set ffmpeg and ffprobe paths
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
        console.log(`⚠️ File ${rawFile} is corrupted, will not be converted.`);
        return null;
      }

      // Convert to MP3 using ffmpeg
      return await new Promise<string | void>((resolve, reject) => {
        ffmpeg()
          .input(rawFile)
          .audioCodec("libmp3lame")
          .format("mp3")
          .on("end", async () => {
            console.log(`🎵 Converted to MP3: ${mp3File}`);
            try {
              fs.unlinkSync(rawFile);
            } catch (unlinkErr) {
              console.error("⚠️ Error deleting raw file:", unlinkErr);
            }
            resolve(mp3File);
          })
          .on("error", (err) => {
            console.error("⚠️ Error during conversion:", err);
            reject(err);
          })
          .save(mp3File);
      });
    } catch (error: any) {
      console.error("🚨 Conversion failed:", error?.message || error);
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
                new Error(`Invalid media file: ${fileInput}, file is deleted`),
              );
            } catch (err) {
              console.log(`error deleting corrupted file ${fileInput}`);
            }
          }
          resolve({ fileSize: metadata.format?.size || 0 });
        });
    });
  }
}
