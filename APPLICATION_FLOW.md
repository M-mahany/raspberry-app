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

*Last Updated: Based on current codebase analysis*
*Application Version: 1.0.0*

