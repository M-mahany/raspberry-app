# Voice Recording & Processing System

This project is a Node.js-based voice recording and processing system designed to record audio, convert raw audio files to MP3, and handle interrupted recordings.

## Features

- 🎙️ **Continuous Voice Recording**: Automatically records audio in `.raw` format at defined intervals.
- 🔄 **Automatic Conversion**: Converts `.raw` audio files to `.mp3` using FFmpeg.
- 🛠 **Interrupted File Handling**: Detects and processes unfinished recordings.
- 📁 **File Management**: Ensures smooth transitions between recordings and prevents file conflicts.
- 🌐 **Remote Log Access**: Provides an API to fetch logs remotely.

## Installation

### Prerequisites

Ensure you have the following installed:

- Node.js (v16+ recommended)
- FFmpeg
- A microphone connected to the system

### Setup

1. **Clone the repository**

   ```sh
   git clone https://github.com/your-repo/voice-recorder.git
   cd voice-recorder
   ```

2. **Install dependencies**

   ```sh
   npm install
   ```

3. **Create a `.env` file**

   ```
   RECORDING_DIR=./pending_upload
   CONVERSION_CHECK_INTERVAL=60000 # 60 seconds
   LOG_FILE=./logs/app.log
   ```

4. **Ensure the required directories exist**
   ```sh
   mkdir -p pending_upload logs
   ```

## Usage

### Start Recording & Processing

```sh
npm start
```

This will:

- Start recording audio files in `pending_upload/`.
- Convert raw files to MP3 after recording.
- Process any interrupted recordings.

### API Endpoints

#### Get Logs

```http
GET /logs
```

**Response (JSON)**

```json
{
  "logs": ["[2025-02-23 12:00:00] 🎙️ Recording started...", "[2025-02-23 12:02:00] ✅ Finished recording..."]
}
```

### How It Works

1. The system starts recording audio and saves it as `.raw`.
2. Every **recording interval**, it stops the recording and converts the file to `.mp3`.
3. If the system crashes or restarts, it will detect unfinished `.raw` files and process them automatically.
4. A remote logging system allows fetching logs for monitoring.

## File Structure

```
voice-recorder/
├── src/
│   ├── services/
│   │   ├── ffmpegService.ts  # Handles audio conversion
│   ├── recorder.ts           # Starts/stops recording
│   ├── processFiles.ts       # Handles file conversions
│   ├── logs.ts               # Remote logging API
├── logs/                     # Stores log files
├── pending_upload/           # Stores temporary audio recordings
├── .gitignore                # Ignores .log files
├── .env                      # Environment variables
├── package.json              # Node.js dependencies
├── README.md                 # Documentation
```

## Troubleshooting

**1. FFmpeg not found**  
Ensure FFmpeg is installed and accessible in your system's PATH. Try running:

```sh
ffmpeg -version
```

**2. Permission issues on Linux**  
You may need to give execution permission:

```sh
chmod +x start.sh
```

**3. Logs not displaying in API response**  
Check if `logs/app.log` exists and is being written to correctly.

## License

MIT License © 2025 Your Name
