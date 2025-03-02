# Voice Recording & Processing System

This project is a Node.js-based voice recording and processing system designed to record audio, convert raw audio files to MP3, and handle interrupted recordings.

## Features

- 🎙️ **Continuous Voice Recording**: Automatically records audio in `.raw` format at defined intervals.
- 🔄 **Automatic Conversion**: Converts `.raw` audio files to `.mp3` using FFmpeg.
- 🛠 **Interrupted File Handling**: Detects and processes unfinished recordings.
- 📁 **File Management**: Ensures smooth transitions between recordings and prevents file conflicts.
- 🌐 **Remote Log Access**: Provides an API to fetch logs remotely.
- 🔄 **Automated Updates**: Uses Git to pull updates and restart the app automatically.
- 🛡 **Secure API Endpoints**: Provides system monitoring and manual update triggers.
- 📡 **Real-time Device Status**: Uses `socket.io` to track connection status.

## Installation

### Prerequisites

Ensure you have the following installed:

- Node.js (v16+ recommended)
- FFmpeg
- A microphone connected to the system

### Setup

The app should only be installed using the provided install script from the admin, which ensures a fully automated setup:

```sh
curl -fsSL ${config.SERVER_URL}/scripts/install.sh | bash -s ${preAuthKey}
```

This script handles:

- Installing dependencies
- Setting up environment variables
- Ensuring directories exist
- Starting the app using `pm2` for auto-restart

## Usage

### Start Recording & Processing

```sh
npm start
```

This will:

- Start recording audio files in `pending_upload/`.
- Convert raw files to MP3 after recording.
- Process any interrupted recordings.
- Upload files securely to the main server.

### API Endpoints

#### 1️⃣ Get System Health

```http
GET /system-health
```

**Response (JSON)**

```json
{
  "uptime": "12.5 hours",
  "cpuUsage": "15%",
  "cpuCount": 4,
  "memoryUsage": "500MB",
  "totalMemory": "4GB",
  "usedMemory": "2GB",
  "totalSpace": "32GB",
  "usedSpace": "10GB",
  "availableSpace": "22GB",
  "diskUsage": "30%",
  "cpuTemp": "45°C",
  "gpuTemp": "50°C"
}
```

#### 2️⃣ Get Logs

```http
GET /logs
```

**Response (JSON)**

```json
{
  "logs": ["[2025-02-23 12:00:00] 🎙️ Recording started...", "[2025-02-23 12:02:00] ✅ Finished recording..."]
}
```

#### 3️⃣ Manually Update the App

```http
POST /update-app
```

**Response (JSON)**

```json
{
  "status": "success",
  "message": "App update initiated."
}
```

#### 4️⃣ Manually Update System Packages

```http
POST /update-system
```

**Response (JSON)**

```json
{
  "status": "success",
  "message": "System update initiated."
}
```

### How It Works

1. The system records audio continuously and saves it as `.raw`.
2. Every **recording interval**, it stops recording and converts the file to `.mp3`.
3. If the system crashes or restarts, it detects unfinished `.raw` files and processes them.
4. The app uploads the `.mp3` files securely to the server using an `accessToken`.
5. After successful upload, the local copy is deleted.
6. A scheduled function checks every 3 hours for:
   - Unprocessed `.raw` files (due to unexpected shutdowns)
   - Unuploaded `.mp3` files (due to connectivity issues)
7. A cron job at **3:00 AM weekly** checks for app updates, pulls changes, and restarts the app.
8. PM2 ensures the app auto-starts after any unexpected shutdown.
9. Winston logs all activities for debugging and monitoring.
10. `socket.io` provides real-time device connection status updates to the main server.

## File Structure

```
📦raspberry-app
 ┣ 📂pending_upload
 ┣ 📂src
 ┃ ┣ 📂jobs
 ┃ ┃ ┣ 📜audioRecording.ts
 ┃ ┃ ┣ 📜autoUpdateCron.ts
 ┃ ┃ ┗ 📜liveMonitoring.ts
 ┃ ┣ 📂logs
 ┃ ┃ ┗ 📜app.log
 ┃ ┣ 📂services
 ┃ ┃ ┣ 📜ffmpegService.ts
 ┃ ┃ ┣ 📜recordingsService.ts
 ┃ ┃ ┗ 📜systemService.ts
 ┃ ┣ 📂types
 ┃ ┃ ┗ 📜mic.d.ts
 ┃ ┣ 📂utils
 ┃ ┃ ┣ 📂config
 ┃ ┃ ┃ ┗ 📜voiceApiConfig.ts
 ┃ ┃ ┣ 📂socket
 ┃ ┃ ┃ ┗ 📜socketClient.ts
 ┃ ┃ ┣ 📂winston
 ┃ ┃ ┃ ┗ 📜logger.ts
 ┃ ┃ ┗ 📜helpers.ts
 ┃ ┗ 📜server.ts
 ┣ 📜.env
 ┣ 📜.gitignore
 ┣ 📜package-lock.json
 ┣ 📜package.json
 ┣ 📜prettierrc.json
 ┣ 📜README.MD
 ┗ 📜tsconfig.json
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

MIT License © 2025 [Techrafter LTD](https://www.techrafter.com/)
