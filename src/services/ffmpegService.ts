import ffmpeg from "fluent-ffmpeg";
import fs from "fs";
import ffmpegInstaller from "@ffmpeg-installer/ffmpeg";
import ffprobeInstaller from "@ffprobe-installer/ffprobe";

// Set the paths manually
ffmpeg.setFfmpegPath(ffmpegInstaller.path);
ffmpeg.setFfprobePath(ffprobeInstaller.path);

interface MetadataMedia{
  fileSize:number
}

export class ffmpegService {
  static async convertAudioToMp3(rawFile: string, mp3File: string) {
 // Convert to MP3 using ffmpeg
 const {fileSize} = await this.getMediaMetadata(rawFile)
 if(!fileSize) return console.log(`File ${rawFile} is is corrupted will not be converted`)
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
  static async getMediaMetadata(
    fileInput: string,
  ):Promise<MetadataMedia>{
    return new Promise((resolve, reject) => {
      const command = ffmpeg();

        // File URL or file path
      command.input(fileInput);
      
      command.ffprobe((err, metadata) => {
        if (err) {
          return reject(new Error("Invalid media file."));
        }
        resolve({fileSize: metadata.format?.size||0})
      });
    });
  }
}
