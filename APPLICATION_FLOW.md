# Raspberry Pi Voice Recording Application - Detailed Flow Documentation

## 📋 Table of Contents
1. [Application Overview](#application-overview)
2. [Architecture & Components](#architecture--components)
3. [Application Startup Flow](#application-startup-flow)
4. [Core Recording Flow](#core-recording-flow)
5. [File Processing & Upload Flow](#file-processing--upload-flow)
6. [Microphone Health Monitoring](#microphone-health-monitoring)
7. [System Health Monitoring](#system-health-monitoring)
8. [Update & Maintenance Flow](#update--maintenance-flow)
9. [Error Handling & Recovery](#error-handling--recovery)
10. [API Endpoints](#api-endpoints)
11. [Background Jobs & Scheduled Tasks](#background-jobs--scheduled-tasks)

---

## 🎯 Application Overview

This is a **Raspberry Pi-based voice recording application** that:
- Continuously records audio from USB microphones
- Converts raw audio files to MP3 format
- Uploads recordings to a remote server
- Monitors system health and microphone status
- Handles interruptions and recovery automatically
- Provides remote management via REST API and WebSocket

---

## 🏗️ Architecture & Components

### **Core Modules:**

1. **`app.ts`** - Express server & entry point
2. **`audioRecording.ts`** - Main recording job (auto-starts on import)
3. **`recordingsService.ts`** - File conversion & upload logic
4. **`ffmpegService.ts`** - Audio format conversion (RAW → MP3)
5. **`systemService.ts`** - System operations, mic detection, USB management
6. **`notificationService.ts`** - Device status notifications to server
7. **`socketClient.ts`** - WebSocket connection for real-time status
8. **`autoUpdateCron.ts`** - Scheduled update checks
9. **`liveMonitoring.ts`** - System health monitoring (optional)

---

## 🚀 Application Startup Flow

### **Step-by-Step Startup Sequence:**

```
1. app.ts loads
   ↓
2. Imports audioRecording.ts (triggers auto-start)
   ↓
3. Imports autoUpdateCron.ts (sets up cron job)
   ↓
4. Imports socketClient.ts (establishes WebSocket connection)
   ↓
5. Express server starts on port 5001
   ↓
6. runOnStart() executes in audioRecording.ts:
   ├─→ startRecording() - Begins first recording session
   ├─→ scheduleNextRestart() - Sets timer for next restart (2h or midnight)
   ├─→ handleInterruptedFiles() - Processes any leftover files
   └─→ SystemService.checkForUpdates() - Checks for app updates
```

### **Initialization Details:**

**`audioRecording.ts` → `runOnStart()`:**
- Creates recording directory (`./pending_upload` or `RECORDING_DIR` env var)
- Starts first recording session immediately
- Schedules periodic restart (every 2 hours OR at midnight, whichever comes first)
- Scans for interrupted `.raw` and `.mp3` files
- Checks for app updates after handling interrupted files

**Background Processes Started:**
- **Mic Health Monitor** - Checks every 3 seconds for mic activity
- **Interrupted Files Checker** - Runs every 3 hours (`CONVERSION_CHECK_INTERVAL`)
- **CPU Health Monitor** - Checks CPU usage every 3 seconds
- **USB Event Detection** - Real-time USB device attach/detach monitoring
- **Notification Queue Flusher** - Retries failed notifications when online

---

## 🎙️ Core Recording Flow

### **Recording Session Lifecycle:**

```
┌─────────────────────────────────────────────────────────────┐
│ 1. START RECORDING                                          │
│    - Check if recording session already active             │
│    - Get default mic device (arecord -l)                   │
│    - Initialize mic instance with options:                 │
│      • Rate: 16000 Hz                                       │
│      • Channels: 1 (mono)                                   │
│      • Bitwidth: 16-bit                                     │
│      • Encoding: signed-integer                             │
│      • Format: raw                                          │
└─────────────────────────────────────────────────────────────┘
                        ↓
┌─────────────────────────────────────────────────────────────┐
│ 2. CREATE OUTPUT FILE                                       │
│    - Generate filename: {timestamp}.raw                     │
│    - Add to recordingFiles Set (tracks active recordings)   │
│    - Create write stream to pending_upload/                 │
└─────────────────────────────────────────────────────────────┘
                        ↓
┌─────────────────────────────────────────────────────────────┐
│ 3. PIPE AUDIO STREAM                                        │
│    - micInputStream → outputFileStream                      │
│    - Audio data flows continuously                          │
└─────────────────────────────────────────────────────────────┘
                        ↓
┌─────────────────────────────────────────────────────────────┐
│ 4. MONITOR STREAM EVENTS                                    │
│    • startComplete → Log recording started                  │
│    • data → Update micLastActive timestamp                  │
│    • error → Log mic errors                                 │
│    • stopComplete → Mark session as finished                │
│    • finish (file stream) → Trigger conversion & upload     │
└─────────────────────────────────────────────────────────────┘
                        ↓
┌─────────────────────────────────────────────────────────────┐
│ 5. SCHEDULE RESTART                                         │
│    - Calculate time until next restart:                    │
│      • Next midnight OR                                      │
│      • 2 hours from now (whichever is shorter)             │
│    - Set timeout to call restartRecording()                │
└─────────────────────────────────────────────────────────────┘
```

### **Recording Restart Logic:**

**`scheduleNextRestart()`:**
- Calculates time until next midnight (12:00 AM)
- Compares with `RECORDING_INTERVAL` (2 hours)
- Uses the **shorter** interval
- Sets timeout to restart recording
- Recursively schedules next restart after completion

**`restartRecording()`:**
- Stops current recording gracefully
- Waits 1 second (special handling at midnight)
- Starts new recording session
- Re-schedules next restart

---

## 📁 File Processing & Upload Flow

### **Conversion & Upload Pipeline:**

```
┌─────────────────────────────────────────────────────────────┐
│ RECORDING COMPLETES                                         │
│ - outputFileStream emits 'finish' event                     │
│ - File: {timestamp}.raw saved to pending_upload/           │
└─────────────────────────────────────────────────────────────┘
                        ↓
┌─────────────────────────────────────────────────────────────┐
│ convertAndUploadToServer()                                  │
│ 1. Validate file metadata (ffprobe)                        │
│    - Check file size                                        │
│    - If corrupted/empty → Delete & skip                     │
└─────────────────────────────────────────────────────────────┘
                        ↓
┌─────────────────────────────────────────────────────────────┐
│ 2. CONVERT TO MP3                                           │
│    - Input: {timestamp}.raw                                 │
│    - Output: {timestamp}.mp3                                │
│    - Codec: libmp3lame                                      │
│    - Format: mp3                                            │
│    - On success: Delete .raw file                           │
└─────────────────────────────────────────────────────────────┘
                        ↓
┌─────────────────────────────────────────────────────────────┐
│ 3. UPLOAD TO SERVER                                         │
│    - Create FormData with:                                  │
│      • mediaFile: MP3 file stream                           │
│      • timeZone: Device timezone                            │
│    - POST to /recordings/device-upload                      │
│    - Headers: Authorization Bearer token                    │
└─────────────────────────────────────────────────────────────┘
                        ↓
┌─────────────────────────────────────────────────────────────┐
│ 4. HANDLE RESPONSE                                          │
│    ✅ Success:                                              │
│       - Log success                                         │
│       - Delete local MP3 file                               │
│       - Remove from recordingFiles Set                      │
│                                                             │
│    ❌ Error:                                                │
│       - File already exists → Delete local copy             │
│       - Invalid media file → Delete corrupted file         │
│       - Other errors → Log & keep file for retry            │
└─────────────────────────────────────────────────────────────┘
```

### **Interrupted Files Recovery:**

**`handleInterruptedFiles()`** runs:
- **On startup** (immediately)
- **Every 3 hours** (scheduled interval)

**Process:**
1. Scan `pending_upload/` directory
2. Find `.raw` files NOT in `recordingFiles` Set (orphaned files)
3. Find `.mp3` files without corresponding `.raw` (upload failed)
4. Convert orphaned `.raw` files → `.mp3` → Upload
5. Upload orphaned `.mp3` files directly

---

## 🎤 Microphone Health Monitoring

### **Real-Time Mic Monitoring:**

**Mic Activity Check (Every 3 seconds):**
```
micMonitor() function:
├─ Check if micLastActive > 3 seconds ago
├─ Check if recordingSession is active
├─ Check if mic not already marked as interrupted
└─ If all true → Trigger mic interruption handler
```

### **Mic Interruption Handling Flow:**

```
┌─────────────────────────────────────────────────────────────┐
│ DETECT MIC INTERRUPTION                                     │
│ - No data received for 3+ seconds                           │
│ - Mark isMicInterrupted = true                              │
│ - Mark isMicActive = false                                  │
└─────────────────────────────────────────────────────────────┘
                        ↓
┌─────────────────────────────────────────────────────────────┐
│ handleMicInterruption("firstAttempt")                       │
│                                                             │
│ 1. CHECK BUFFER                                             │
│    - Prevent duplicate checks (15s buffer)                 │
│    - Mark check as active                                   │
└─────────────────────────────────────────────────────────────┘
                        ↓
┌─────────────────────────────────────────────────────────────┐
│ 2. CHECK MIC DETECTION                                      │
│    - Run: arecord -l (isMicDetected)                       │
│                                                             │
│    ✅ MIC DETECTED:                                         │
│       ├─ Check mic availability (test recording)           │
│       ├─ If available → Restart recording                  │
│       └─ If unavailable → Stop & start health check        │
│                                                             │
│    ❌ MIC NOT DETECTED:                                     │
│       ├─ Check USB connection (lsusb)                      │
│       ├─ Send notification:                                │
│       │  • DEVICE_SYSTEM_MIC_OFF (USB connected)          │
│       │  • DEVICE_HARDWARE_MIC_OFF (USB disconnected)     │
│       └─ Power cycle USB ports                              │
└─────────────────────────────────────────────────────────────┘
                        ↓
┌─────────────────────────────────────────────────────────────┐
│ 3. SECOND ATTEMPT (after USB cycle)                         │
│    handleMicInterruption("secondAttempt")                   │
│                                                             │
│    ✅ MIC DETECTED:                                         │
│       - Restart recording                                   │
│                                                             │
│    ❌ STILL NOT DETECTED:                                   │
│       - Stop recording                                      │
│       - Cancel restart schedule                             │
│       - Check device uptime                                 │
│       - If uptime > 60 min → Reboot device                 │
│       - If uptime < 60 min → Skip reboot (recent boot)    │
└─────────────────────────────────────────────────────────────┘
```

### **USB Power Cycling:**

**`cycleAllUsbPorts()`:**
1. Check if `uhubctl` is installed
2. If not → Install from source (GitHub)
3. Power OFF USB hubs 2 and 4
4. Wait 3 seconds
5. Power ON USB hubs 2 and 4
6. Wait 3 seconds
7. Mic should be re-detected by system

### **USB Event Detection:**

**`realTimeUsbEventDetection()`:**
- Listens for USB device attach events
- Filters events within 10s of power cycle (ignore false positives)
- If mic not active → Check detection → Restart recording

### **Mic Health Check Interval:**

**`startMicHealthCheckInterval()`:**
- Runs when mic detected but not available
- Checks every 10 seconds
- When mic becomes available → Restart recording

---

## 💻 System Health Monitoring

### **CPU Health Monitoring:**

**`CPUHealthUsage()`** (Every 3 seconds):
- Gets CPU usage percentage
- If > 70% threshold:
  - Check if last report was > 60 minutes ago
  - Send `DEVICE_CPU_ALARM` notification
  - Include CPU usage and threshold in metadata

### **System Health API:**

**`GET /system-health`** returns:
- **Uptime**: System uptime in hours
- **CPU**: Usage percentage, count
- **Memory**: Usage %, total, used (GB)
- **Disk**: Total, used, available (GB), usage %
- **Temperature**: CPU temp, GPU temp (°C)

---

## 🔄 Update & Maintenance Flow

### **Automatic Update Check:**

**Scheduled (Cron):**
- **Every 7 days at 3:00 AM** (`autoUpdateCron.ts`)
- Calls `SystemService.checkForUpdates()`

**Manual Trigger:**
- **API**: `GET /update-app`
- **On Startup**: After handling interrupted files

### **Update Process:**

```
┌─────────────────────────────────────────────────────────────┐
│ checkForUpdates()                                           │
│                                                             │
│ 1. FETCH LATEST CHANGES                                    │
│    - git fetch origin                                       │
└─────────────────────────────────────────────────────────────┘
                        ↓
┌─────────────────────────────────────────────────────────────┐
│ 2. COMPARE COMMITS                                          │
│    - Get local commit hash (HEAD)                          │
│    - Get remote commit hash (origin/main)                  │
│    - Compare hashes                                         │
└─────────────────────────────────────────────────────────────┘
                        ↓
┌─────────────────────────────────────────────────────────────┐
│ 3. IF UPDATES FOUND:                                        │
│    ├─ git pull origin main                                 │
│    ├─ npm install (update dependencies)                    │
│    ├─ npm run build (compile TypeScript)                   │
│    └─ pm2 restart ai-voice-app (restart app)              │
│                                                             │
│    IF NO UPDATES:                                           │
│    └─ Return "No updates found"                            │
└─────────────────────────────────────────────────────────────┘
```

### **System Update:**

**`GET /update-system`:**
- Runs: `sudo apt update && sudo apt upgrade -y`
- Updates all system packages
- Returns success/error status

---

## 🚨 Error Handling & Recovery

### **Recording Errors:**

**Mic Stream Errors:**
- Logged but don't stop recording
- Mic health monitor detects inactivity

**File Stream Errors:**
- Handled in `finish` event
- Conversion/upload errors logged

**Conversion Errors:**
- Corrupted files detected via ffprobe
- Invalid files deleted automatically
- Errors logged, process continues

### **Upload Errors:**

**Network Errors:**
- Files remain in `pending_upload/`
- Retried on next `handleInterruptedFiles()` run (3h interval)

**Server Errors:**
- Duplicate file → Delete local copy
- Invalid media → Delete corrupted file
- Other errors → Log & keep for retry

### **System Errors:**

**Mic Unavailable:**
- Automatic USB power cycle
- Health check interval
- Device reboot if persistent (after 60 min uptime)

**High CPU Usage:**
- Notification sent to server
- Rate-limited (max once per hour)

---

## 🌐 API Endpoints

### **1. GET `/`**
- **Purpose**: Health check
- **Response**: `"Raspberry Pi App!"`

### **2. GET `/system-health`**
- **Purpose**: Get system metrics
- **Response**: JSON with CPU, memory, disk, temperature

### **3. GET `/logs`**
- **Query Params**: 
  - `page` (default: 1)
  - `limit` (default: 500)
- **Response**: Paginated log entries (JSON)

### **4. GET `/update-app`**
- **Purpose**: Manually trigger app update
- **Response**: Update status message

### **5. GET `/update-system`**
- **Purpose**: Update system packages
- **Response**: Update status message

### **6. GET `/reboot`**
- **Purpose**: Reboot device
- **Response**: Confirmation message
- **Action**: Reboots in 3 seconds

---

## ⏰ Background Jobs & Scheduled Tasks

### **Continuous Processes:**

1. **Mic Activity Monitor** (3s interval)
   - Checks `micLastActive` timestamp
   - Detects interruptions

2. **CPU Health Monitor** (3s interval)
   - Checks CPU usage
   - Sends alerts if > 70%

3. **USB Event Listener** (Real-time)
   - Monitors USB device attach/detach
   - Auto-restarts recording on mic reconnect

4. **Notification Queue Flusher** (Continuous loop)
   - Retries failed notifications
   - Waits for socket connection
   - Processes queue when online

### **Scheduled Tasks:**

1. **Recording Restart** (Dynamic)
   - Every 2 hours OR at midnight
   - Whichever comes first

2. **Interrupted Files Check** (3 hours)
   - Scans for orphaned files
   - Converts and uploads

3. **Auto Update Check** (Weekly)
   - Every 7 days at 3:00 AM
   - Checks Git for updates

---

## 📡 WebSocket Communication

### **Socket Connection:**

**Connection Details:**
- URL: `MAIN_SERVER_URL` (from .env)
- Query Params:
  - `clientType: "device"`
  - `accessToken: ACCESS_TOKEN`

**Events:**
- **connect**: Sets `isOnline = true`, checks mic status
- **disconnect**: Sets `isOnline = false`
- **connect_error**: Logs connection errors

**Purpose:**
- Real-time connection status
- Enables notification queue flushing
- Server can track device online/offline state

---

## 🔔 Notification System

### **Notification Events:**

1. **`DEVICE_SYSTEM_MIC_OFF`**
   - Mic detected by USB but not accessible
   - 5-minute delay before sending
   - Cancelled if mic comes back online

2. **`DEVICE_SYSTEM_MIC_ON`**
   - Mic becomes available
   - Cancels pending MIC_OFF notification

3. **`DEVICE_HARDWARE_MIC_OFF`**
   - USB mic physically disconnected
   - 5-minute delay before sending

4. **`DEVICE_HARDWARE_MIC_ON`**
   - USB mic reconnected
   - Cancels pending MIC_OFF notification

5. **`DEVICE_CPU_ALARM`**
   - CPU usage > 70%
   - Rate-limited (max once per hour)
   - Includes CPU usage and threshold

### **Notification Flow:**

```
┌─────────────────────────────────────────────────────────────┐
│ sendHeartBeatToServer()                                      │
│                                                             │
│ 1. CHECK RATE LIMITING                                      │
│    - CPU_ALARM: 1 hour buffer                               │
│    - Others: No buffer                                      │
└─────────────────────────────────────────────────────────────┘
                        ↓
┌─────────────────────────────────────────────────────────────┐
│ 2. HANDLE MIC_OFF EVENTS                                    │
│    - Set 5-minute delay timer                              │
│    - If MIC_ON received before delay → Cancel              │
│    - After delay → Send notification                        │
└─────────────────────────────────────────────────────────────┘
                        ↓
┌─────────────────────────────────────────────────────────────┐
│ 3. HANDLE MIC_ON EVENTS                                     │
│    - Cancel pending MIC_OFF timer                          │
│    - If no MIC_OFF was sent → Add skipNotification flag    │
│    - Send notification immediately                          │
└─────────────────────────────────────────────────────────────┘
                        ↓
┌─────────────────────────────────────────────────────────────┐
│ 4. SEND TO SERVER                                           │
│    - POST /notification/device                              │
│    - Body: { event, meta_data }                             │
│                                                             │
│    ✅ Success: Logged                                        │
│    ❌ Error: Added to retry queue                           │
└─────────────────────────────────────────────────────────────┘
```

### **Retry Queue:**

**`flushQueueLoop()`:**
- Runs continuously in background
- Checks `isOnline` status (socket connection)
- Processes queue when online
- Retries failed notifications
- Handles duplicate MIC events (keeps latest)

---

## 🔐 Security & Configuration

### **Environment Variables:**

- **`RECORDING_DIR`**: Directory for recordings (default: `./pending_upload`)
- **`MAIN_SERVER_URL`**: Server API base URL
- **`ACCESS_TOKEN`**: Bearer token for API authentication

### **File Management:**

- Raw files deleted after successful MP3 conversion
- MP3 files deleted after successful upload
- Corrupted files deleted automatically
- Duplicate uploads detected and handled

---

## 📊 Data Flow Summary

```
┌──────────────┐
│   Microphone │
└──────┬───────┘
       │ Audio Stream
       ↓
┌──────────────────┐      ┌──────────────┐
│ micInputStream   │─────→│ .raw file   │
└──────────────────┘      └──────┬───────┘
                                 │
                                 ↓
                        ┌─────────────────┐
                        │ FFmpeg Convert  │
                        │ (.raw → .mp3)   │
                        └────────┬────────┘
                                 │
                                 ↓
                        ┌─────────────────┐
                        │ Upload to Server│
                        │ (FormData POST) │
                        └────────┬────────┘
                                 │
                                 ↓
                        ┌─────────────────┐
                        │ Delete Local    │
                        │ File            │
                        └─────────────────┘
```

---

## 🎯 Key Features Summary

✅ **Continuous Recording**: 2-hour sessions or until midnight  
✅ **Automatic Conversion**: RAW → MP3 using FFmpeg  
✅ **Smart Restart**: Handles midnight transitions gracefully  
✅ **Interruption Recovery**: Processes orphaned files automatically  
✅ **Mic Health Monitoring**: Detects and recovers from mic issues  
✅ **USB Power Cycling**: Hardware-level mic recovery  
✅ **System Monitoring**: CPU, memory, disk, temperature tracking  
✅ **Auto Updates**: Git-based update system with PM2 restart  
✅ **Notification System**: Device status alerts to server  
✅ **WebSocket Integration**: Real-time connection status  
✅ **Error Resilience**: Comprehensive error handling and recovery  
✅ **Remote Management**: REST API for monitoring and control  

---

## 🔍 Troubleshooting Flow

**If recording stops:**
1. Check mic health monitor logs
2. Verify USB mic connection
3. Check system health API
4. Review notification events

**If files not uploading:**
1. Check network connectivity
2. Verify server API endpoint
3. Check authentication token
4. Review interrupted files handler logs

**If mic not detected:**
1. USB power cycle triggered automatically
2. Check USB device list (`lsusb`)
3. Verify mic device (`arecord -l`)
4. System may reboot if persistent issue

---

## 📝 Transcription & Speaker Diarization Flow

### Overview

This section explains how to combine Whisper transcription output with speaker diarization from the 4-channel WAV file to determine **which speaker spoke in each second** of the recording.

---

### Complete Pipeline Flow

```
┌─────────────────────────────────────────────────────────────┐
│ STEP 1: Recording (Raspberry Pi)                             │
│                                                              │
│ Input: ReSpeaker USB Mic Array (6 channels)                  │
│ Output: Multi-channel RAW file (6 channels, 16kHz, 16-bit) │
│ File: {timestamp}.raw                                       │
└─────────────────────────────────────────────────────────────┘
                        ↓
┌─────────────────────────────────────────────────────────────┐
│ STEP 2: Channel Splitting                                  │
│                                                              │
│ Channel 0 → {timestamp}_transcript.mp3 (mono, 16kHz)      │
│ Channels 1-4 → {timestamp}_diarization.wav (4-ch, 16kHz)  │
│ Channel 5 → Discarded                                      │
└─────────────────────────────────────────────────────────────┘
                        ↓
        ┌───────────────┴───────────────┐
        ↓                               ↓
┌───────────────────────┐   ┌───────────────────────┐
│ STEP 3A: Whisper      │   │ STEP 3B: Diarization  │
│ Transcription          │   │ Speaker Detection     │
│                        │   │                       │
│ Input: MP3 (Channel 0) │   │ Input: WAV (Ch 1-4)  │
│ Output: Transcript     │   │ Output: Speaker       │
│ with timestamps        │   │ segments with times   │
└───────────────────────┘   └───────────────────────┘
        ↓                               ↓
┌─────────────────────────────────────────────────────────────┐
│ STEP 4: Alignment & Mapping                                 │
│                                                              │
│ Combine transcript segments with speaker segments          │
│ Map "who said what" using time alignment                    │
└─────────────────────────────────────────────────────────────┘
                        ↓
┌─────────────────────────────────────────────────────────────┐
│ STEP 5: Final Output                                        │
│                                                              │
│ Speaker-labeled transcript with timestamps                 │
└─────────────────────────────────────────────────────────────┘
```

---

### Step-by-Step Detailed Flow

#### **STEP 1: Recording & File Generation**

**Files Created:**
- `{timestamp}_transcript.mp3` - Channel 0 (processed audio, mono, 16kHz)
- `{timestamp}_diarization.wav` - Channels 1-4 (raw mics, 4-channel, 16kHz)

**Important:** Both files share the **same timestamp** and are **time-synchronized** (same start time, same duration).

---

#### **STEP 2: Whisper Transcription**

**Input:** `{timestamp}_transcript.mp3`

**Whisper Output Format (JSON):**
```json
{
  "text": "Hello, how are you? I'm doing great, thanks.",
  "segments": [
    {
      "id": 0,
      "start": 0.0,
      "end": 2.5,
      "text": "Hello, how are you?",
      "words": [
        {"word": "Hello", "start": 0.0, "end": 0.5},
        {"word": "how", "start": 0.6, "end": 0.8},
        {"word": "are", "start": 0.9, "end": 1.1},
        {"word": "you", "start": 1.2, "end": 1.5}
      ]
    },
    {
      "id": 1,
      "start": 2.6,
      "end": 5.2,
      "text": "I'm doing great, thanks.",
      "words": [
        {"word": "I'm", "start": 2.6, "end": 2.8},
        {"word": "doing", "start": 2.9, "end": 3.2},
        {"word": "great", "start": 3.3, "end": 3.7},
        {"word": "thanks", "start": 3.8, "end": 4.2}
      ]
    }
  ]
}
```

**Key Fields:**
- `segments[].start` - Start time in seconds
- `segments[].end` - End time in seconds
- `segments[].text` - Transcribed text for that segment
- `segments[].words[]` - Word-level timestamps (optional, more precise)

---

#### **STEP 3: Speaker Diarization**

**Input:** `{timestamp}_diarization.wav` (4-channel WAV)

**Diarization Process:**

1. **Load 4-channel WAV file**
   - Channel 0: Microphone 1
   - Channel 1: Microphone 2
   - Channel 2: Microphone 3
   - Channel 3: Microphone 4

2. **Extract speaker segments** using any diarization algorithm:
   - **TDOA-based** (Time Difference of Arrival)
   - **Beamforming** (steer beams toward speakers)
   - **Clustering** (group similar audio segments)
   - **ML-based** (pyannote.audio, SpeechBrain, etc.)

**Diarization Output Format (Example):**
```json
{
  "speakers": [
    {
      "speaker_id": "SPEAKER_00",
      "segments": [
        {
          "start": 0.0,
          "end": 2.5,
          "confidence": 0.95
        },
        {
          "start": 6.1,
          "end": 8.3,
          "confidence": 0.92
        }
      ]
    },
    {
      "speaker_id": "SPEAKER_01",
      "segments": [
        {
          "start": 2.6,
          "end": 5.2,
          "confidence": 0.88
        },
        {
          "start": 8.5,
          "end": 12.0,
          "confidence": 0.90
        }
      ]
    }
  ]
}
```

**Key Fields:**
- `speakers[].speaker_id` - Unique identifier for each speaker
- `speakers[].segments[].start` - Start time in seconds
- `speakers[].segments[].end` - End time in seconds
- `speakers[].segments[].confidence` - Confidence score (0-1)

---

#### **STEP 4: Alignment & Mapping**

**Goal:** Map each transcript segment to the correct speaker using time alignment.

**Algorithm:**

```python
def align_transcript_with_speakers(whisper_segments, diarization_segments):
    """
    Align Whisper transcript segments with speaker diarization segments.
    
    Args:
        whisper_segments: List of transcript segments with start/end times
        diarization_segments: List of speaker segments with start/end times
    
    Returns:
        List of aligned segments with speaker labels
    """
    aligned_segments = []
    
    for transcript_seg in whisper_segments:
        transcript_start = transcript_seg['start']
        transcript_end = transcript_seg['end']
        
        # Find which speaker was active during this time segment
        speaker_id = find_speaker_for_time_range(
            transcript_start, 
            transcript_end, 
            diarization_segments
        )
        
        aligned_segments.append({
            'start': transcript_start,
            'end': transcript_end,
            'text': transcript_seg['text'],
            'speaker': speaker_id,
            'confidence': calculate_overlap_confidence(
                transcript_seg, 
                speaker_id, 
                diarization_segments
            )
        })
    
    return aligned_segments


def find_speaker_for_time_range(start, end, diarization_segments):
    """
    Find which speaker was active during a given time range.
    
    Strategy:
    1. Find all speaker segments that overlap with [start, end]
    2. Calculate overlap percentage for each speaker
    3. Return speaker with highest overlap
    """
    speaker_overlaps = {}
    
    for speaker_id, segments in diarization_segments.items():
        total_overlap = 0
        
        for seg in segments:
            # Calculate overlap between transcript segment and speaker segment
            overlap_start = max(start, seg['start'])
            overlap_end = min(end, seg['end'])
            
            if overlap_start < overlap_end:
                overlap_duration = overlap_end - overlap_start
                total_overlap += overlap_duration
        
        speaker_overlaps[speaker_id] = total_overlap
    
    # Return speaker with maximum overlap
    if speaker_overlaps:
        return max(speaker_overlaps.items(), key=lambda x: x[1])[0]
    else:
        return "UNKNOWN"


def calculate_overlap_confidence(transcript_seg, speaker_id, diarization_segments):
    """
    Calculate confidence score for speaker assignment.
    
    Based on:
    - Overlap percentage (how much of transcript segment overlaps with speaker segment)
    - Diarization confidence score
    """
    transcript_duration = transcript_seg['end'] - transcript_seg['start']
    
    if speaker_id not in diarization_segments:
        return 0.0
    
    total_overlap = 0
    max_confidence = 0
    
    for seg in diarization_segments[speaker_id]:
        overlap_start = max(transcript_seg['start'], seg['start'])
        overlap_end = min(transcript_seg['end'], seg['end'])
        
        if overlap_start < overlap_end:
            overlap_duration = overlap_end - overlap_start
            total_overlap += overlap_duration
            max_confidence = max(max_confidence, seg.get('confidence', 0.5))
    
    overlap_percentage = total_overlap / transcript_duration if transcript_duration > 0 else 0
    
    # Combined confidence: overlap percentage * diarization confidence
    return overlap_percentage * max_confidence
```

**Example Alignment:**

**Whisper Segments:**
```
Segment 1: [0.0s - 2.5s] "Hello, how are you?"
Segment 2: [2.6s - 5.2s] "I'm doing great, thanks."
```

**Diarization Segments:**
```
SPEAKER_00: [0.0s - 2.5s]
SPEAKER_01: [2.6s - 5.2s]
```

**Aligned Output:**
```json
[
  {
    "start": 0.0,
    "end": 2.5,
    "text": "Hello, how are you?",
    "speaker": "SPEAKER_00",
    "confidence": 0.95
  },
  {
    "start": 2.6,
    "end": 5.2,
    "text": "I'm doing great, thanks.",
    "speaker": "SPEAKER_01",
    "confidence": 0.88
  }
]
```

---

#### **STEP 5: Handling Edge Cases**

##### **Case 1: Multiple Speakers in One Transcript Segment**

**Situation:** One transcript segment spans multiple speaker segments.

**Example:**
```
Transcript: [0.0s - 5.0s] "Hello, how are you? I'm doing great."
Diarization: 
  SPEAKER_00: [0.0s - 2.5s]
  SPEAKER_01: [2.6s - 5.0s]
```

**Solution Options:**

1. **Split transcript segment** at speaker boundaries:
   ```json
   [
     {
       "start": 0.0,
       "end": 2.5,
       "text": "Hello, how are you?",
       "speaker": "SPEAKER_00"
     },
     {
       "start": 2.6,
       "end": 5.0,
       "text": "I'm doing great.",
       "speaker": "SPEAKER_01"
     }
   ]
   ```

2. **Assign to dominant speaker** (speaker with most overlap):
   ```json
   [
     {
       "start": 0.0,
       "end": 5.0,
       "text": "Hello, how are you? I'm doing great.",
       "speaker": "SPEAKER_00",  // 2.5s overlap vs 2.4s overlap
       "confidence": 0.50  // Lower confidence due to mixed speakers
     }
   ]
   ```

##### **Case 2: Overlapping Speakers**

**Situation:** Multiple speakers talking simultaneously.

**Example:**
```
Diarization:
  SPEAKER_00: [0.0s - 3.0s]
  SPEAKER_01: [2.0s - 4.0s]  // Overlaps with SPEAKER_00
```

**Solution:** Use word-level timestamps from Whisper (if available) for more precise alignment, or assign to the speaker with highest confidence during overlap.

##### **Case 3: No Speaker Detected**

**Situation:** Transcript segment has no corresponding speaker segment.

**Solution:** Assign to "UNKNOWN" speaker with low confidence, or use DOA data to estimate speaker position.

---

#### **STEP 6: Final Output Format**

**Complete Speaker-Labeled Transcript:**

```json
{
  "recording_id": "1704067200000",
  "duration": 12.5,
  "speakers": {
    "SPEAKER_00": {
      "total_time": 5.2,
      "segments": [
        {
          "start": 0.0,
          "end": 2.5,
          "text": "Hello, how are you?",
          "confidence": 0.95
        },
        {
          "start": 6.1,
          "end": 8.8,
          "text": "That sounds great!",
          "confidence": 0.92
        }
      ]
    },
    "SPEAKER_01": {
      "total_time": 7.3,
      "segments": [
        {
          "start": 2.6,
          "end": 5.2,
          "text": "I'm doing great, thanks.",
          "confidence": 0.88
        },
        {
          "start": 8.5,
          "end": 12.0,
          "text": "Let's meet tomorrow then.",
          "confidence": 0.90
        }
      ]
    }
  },
  "timeline": [
    {
      "time": "0:00",
      "speaker": "SPEAKER_00",
      "text": "Hello, how are you?"
    },
    {
      "time": "0:03",
      "speaker": "SPEAKER_01",
      "text": "I'm doing great, thanks."
    },
    {
      "time": "0:06",
      "speaker": "SPEAKER_00",
      "text": "That sounds great!"
    },
    {
      "time": "0:09",
      "speaker": "SPEAKER_01",
      "text": "Let's meet tomorrow then."
    }
  ]
}
```

---

### Implementation Example (Python)

```python
import json
from typing import List, Dict, Any

def process_recording(transcript_file: str, diarization_file: str) -> Dict[str, Any]:
    """
    Main function to combine Whisper transcript with speaker diarization.
    
    Args:
        transcript_file: Path to Whisper JSON output
        diarization_file: Path to diarization JSON output
    
    Returns:
        Combined speaker-labeled transcript
    """
    # Load files
    with open(transcript_file, 'r') as f:
        whisper_data = json.load(f)
    
    with open(diarization_file, 'r') as f:
        diarization_data = json.load(f)
    
    # Convert diarization to time-indexed format
    speaker_segments = index_speakers_by_time(diarization_data)
    
    # Align transcript with speakers
    aligned_segments = align_transcript_with_speakers(
        whisper_data['segments'],
        speaker_segments
    )
    
    # Build final output
    result = build_final_output(aligned_segments, whisper_data)
    
    return result


def index_speakers_by_time(diarization_data: Dict) -> Dict[str, List[Dict]]:
    """
    Index speaker segments by speaker ID for easy lookup.
    """
    indexed = {}
    
    for speaker in diarization_data['speakers']:
        speaker_id = speaker['speaker_id']
        indexed[speaker_id] = speaker['segments']
    
    return indexed


def align_transcript_with_speakers(
    transcript_segments: List[Dict],
    speaker_segments: Dict[str, List[Dict]]
) -> List[Dict]:
    """
    Align each transcript segment with the appropriate speaker.
    """
    aligned = []
    
    for seg in transcript_segments:
        start = seg['start']
        end = seg['end']
        
        # Find best matching speaker
        speaker_id, confidence = find_best_speaker_match(
            start, end, speaker_segments
        )
        
        aligned.append({
            'start': start,
            'end': end,
            'text': seg['text'],
            'speaker': speaker_id,
            'confidence': confidence
        })
    
    return aligned


def find_best_speaker_match(
    start: float,
    end: float,
    speaker_segments: Dict[str, List[Dict]]
) -> tuple[str, float]:
    """
    Find the speaker with the highest overlap for a given time range.
    """
    best_speaker = "UNKNOWN"
    best_overlap = 0
    best_confidence = 0
    
    segment_duration = end - start
    
    for speaker_id, segments in speaker_segments.items():
        total_overlap = 0
        max_conf = 0
        
        for seg in segments:
            seg_start = seg['start']
            seg_end = seg['end']
            seg_conf = seg.get('confidence', 0.5)
            
            # Calculate overlap
            overlap_start = max(start, seg_start)
            overlap_end = min(end, seg_end)
            
            if overlap_start < overlap_end:
                overlap_duration = overlap_end - overlap_start
                total_overlap += overlap_duration
                max_conf = max(max_conf, seg_conf)
        
        # Calculate overlap percentage
        overlap_pct = total_overlap / segment_duration if segment_duration > 0 else 0
        combined_confidence = overlap_pct * max_conf
        
        if combined_confidence > best_overlap:
            best_overlap = combined_confidence
            best_speaker = speaker_id
            best_confidence = combined_confidence
    
    return best_speaker, best_confidence


def build_final_output(
    aligned_segments: List[Dict],
    whisper_data: Dict
) -> Dict[str, Any]:
    """
    Build the final structured output.
    """
    # Group by speaker
    speakers = {}
    timeline = []
    
    for seg in aligned_segments:
        speaker_id = seg['speaker']
        
        if speaker_id not in speakers:
            speakers[speaker_id] = {
                'total_time': 0,
                'segments': []
            }
        
        duration = seg['end'] - seg['start']
        speakers[speaker_id]['total_time'] += duration
        speakers[speaker_id]['segments'].append({
            'start': seg['start'],
            'end': seg['end'],
            'text': seg['text'],
            'confidence': seg['confidence']
        })
        
        # Add to timeline
        timeline.append({
            'time': format_time(seg['start']),
            'speaker': speaker_id,
            'text': seg['text']
        })
    
    return {
        'duration': whisper_data.get('duration', 0),
        'speakers': speakers,
        'timeline': timeline
    }


def format_time(seconds: float) -> str:
    """Format seconds as MM:SS."""
    minutes = int(seconds // 60)
    secs = int(seconds % 60)
    return f"{minutes}:{secs:02d}"


# Usage
if __name__ == "__main__":
    result = process_recording(
        "1704067200000_transcript.json",
        "1704067200000_diarization.json"
    )
    
    print(json.dumps(result, indent=2))
```

---

### Using GPT to Enhance Mapping

After basic alignment, you can use GPT to:

1. **Resolve ambiguities** when confidence is low
2. **Split segments** that contain multiple speakers
3. **Improve speaker labels** using context
4. **Generate natural conversation format**

**Example GPT Prompt:**

```
You are analyzing a conversation transcript with speaker diarization data.

Transcript segments:
- [0.0s - 2.5s] SPEAKER_00: "Hello, how are you?"
- [2.6s - 5.2s] SPEAKER_01: "I'm doing great, thanks."

Diarization data shows:
- SPEAKER_00 was active from 0.0s to 2.5s
- SPEAKER_01 was active from 2.6s to 5.2s

Please:
1. Verify the alignment is correct
2. If there are any segments with low confidence, suggest corrections
3. Format as a natural conversation with speaker labels
```

---

### Summary

**Key Points:**

1. **Time Synchronization**: Both files share the same timestamp and start time
2. **Alignment Algorithm**: Match transcript segments to speaker segments using time overlap
3. **Confidence Scoring**: Calculate confidence based on overlap percentage and diarization confidence
4. **Edge Cases**: Handle overlapping speakers, missing speakers, and ambiguous segments
5. **Final Output**: Structured format with speaker-labeled segments and timeline

**Files Needed:**
- `{timestamp}_transcript.mp3` → Whisper → `{timestamp}_transcript.json`
- `{timestamp}_diarization.wav` → Diarization → `{timestamp}_diarization.json`
- Alignment algorithm → `{timestamp}_final.json`

**Result:** You'll know exactly which speaker said what at each second of the recording!

---

*Last Updated: Based on current codebase analysis*
*Application Version: 1.0.0*

