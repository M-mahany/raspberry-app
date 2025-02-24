import ffmpeg from "fluent-ffmpeg";
import fs from "fs";
import ffmpegInstaller from "@ffmpeg-installer/ffmpeg";
import ffprobeInstaller from "@ffprobe-installer/ffprobe";

// Set the paths manually
ffmpeg.setFfmpegPath(ffmpegInstaller.path);
ffmpeg.setFfprobePath(ffprobeInstaller.path);

export class ffmpegService {
  static convertAudioToMp3(rawFile: string, mp3File: string) {
    // Convert to MP3 using ffmpeg
    ffmpeg()
      .input(rawFile)
      .audioCodec("libmp3lame")
      .format("mp3")
      .on("end", () => {
        console.log(`🎵 Converted to MP3: ${mp3File}`);

        // Delete the raw file after conversion
        fs.unlink(rawFile, (err) => {
          if (err) console.error("⚠️ Error deleting raw file:", err);
          else {
            console.log(`🗑️ Deleted raw file: ${rawFile}`);
          }
        });
      })
      .on("error", (err) => {
        console.error("⚠️ Error during conversion:", err);
      })
      .save(mp3File);
  }
}
