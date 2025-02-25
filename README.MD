# Voice Recording & Processing System

This application is designed to record audio on a Raspberry Pi (or any Linux-based system), convert the recorded files to MP3 format, and upload them to a server. It also includes a mechanism to retry failed uploads at scheduled intervals.

## Features

- Continuous voice recording in `.raw` format.
- Automatic conversion of `.raw` files to `.mp3`.
- Upload of processed files to a server.
- Handling of interrupted recordings.
- Retry mechanism for failed uploads.
- API endpoint for retrieving logs remotely.

## Installation

### Prerequisites

- Node.js (>=16)
- FFmpeg (for audio conversion)
- `sox` (for microphone input handling)
- Raspberry Pi or Linux-based system

### Setup

1. Clone the repository:
   ```sh
   git clone <repository-url>
   cd <repository-name>
   ```
2. Install dependencies:
   ```sh
   npm install
   ```
3. Create an `.env` file and configure the required variables:
   ```sh
   RECORDING_DIR=./pending_upload
   UPLOAD_ENDPOINT=https://yourserver.com/upload
   CONVERSION_CHECK_INTERVAL=60000 # (60 seconds)
   RETRY_FAILED_UPLOADS_INTERVAL=300000 # (5 minutes)
   LOG_FILE=./logs/app.log
   ```

## Usage

### Start Recording

```sh
npm start
```

This will:

- Start recording audio.
- Convert recordings to `.mp3`.
- Upload them to the server.
- Handle any interrupted files.
- Retry failed uploads periodically.

### API Endpoints

#### Fetch Logs

```sh
GET /logs
```

Returns system logs in JSON format.

## Background Processes

- **Recording**: Runs continuously, saving audio in `.raw` format every set interval.
- **Conversion & Upload**: Each recording is converted to `.mp3` and uploaded to the server.
- **Retry Mechanism**: Any failed uploads are retried every `RETRY_FAILED_UPLOADS_INTERVAL`.

## Troubleshooting

- **FFmpeg errors**: Ensure FFmpeg is installed and accessible from the command line.
- **Microphone issues**: Check if `sox` is installed and has the correct permissions.
- **Failed uploads**: Verify the server URL in `.env` and ensure the API is working.

## License

MIT License © 2025 [Techrafter LTD](https://www.techrafter.com/)
