# DOA (Direction of Arrival) System Documentation

## Table of Contents
1. [Overview](#overview)
2. [What We Built](#what-we-built)
3. [System Architecture](#system-architecture)
4. [DOA Angle-Based Channel Detection](#doa-angle-based-channel-detection)
5. [Recording Flow](#recording-flow)
6. [Segment Generation](#segment-generation)
7. [File Output Format](#file-output-format)
8. [Technical Details](#technical-details)

---

## Overview

This document describes the Direction of Arrival (DOA) system implemented in the Raspberry Pi voice recording application. The system uses a ReSpeaker USB Mic Array to detect the direction of sound sources and maps them to one of four microphone channels based on 90° quadrants.

---

## What We Built

### Previous Implementation (Removed)
- **Speech-based detection**: Used RMS (Root Mean Square) energy analysis of audio samples to detect which channels had speech activity
- **Complex lifecycle management**: Segments were opened when speech was detected and closed after 500ms of silence
- **Unreliable**: Dependent on audio amplitude thresholds that could produce false positives from background noise

### Current Implementation
- **Angle-based detection**: Uses the DOA angle directly from the ReSpeaker device hardware
- **Time-based segments**: Creates segments every 100ms (10 per second) based on the current DOA angle
- **Simple quadrant mapping**: Maps DOA angles to channels using 90° quadrants
- **Accuracy calculation**: Provides confidence score based on how close the angle is to the quadrant center

---

## System Architecture

### Components

1. **`doaService.ts`** - Core DOA service
   - Reads DOA angles from ReSpeaker USB Mic Array
   - Maps angles to channels
   - Calculates accuracy
   - Generates segments

2. **`audioRecording.ts`** - Recording job
   - Starts/stops recordings
   - Triggers DOA monitoring
   - Handles file processing and upload

3. **`recordingsService.ts`** - File handling
   - Converts audio files
   - Uploads recordings and DOA JSON files

### Hardware
- **ReSpeaker USB Mic Array** (Vendor ID: 0x2886, Product ID: 0x0018)
- **4 Microphones** arranged in a circular array
- **USB Control Transfer** for reading DOA angle

---

## DOA Angle-Based Channel Detection

### How Channels Are Detected

The system uses **90° quadrant mapping** to determine which channel detected the sound:

```
        0°/360°
           ↑
           |
   270° ←──┼──→ 90°
           |
           ↓
         180°
```

#### Channel Mapping Rules

| Channel | Angle Range | Quadrant Center | Description |
|---------|-------------|-----------------|-------------|
| **Channel 1** | 0° ≤ angle < 90° | 45° | Front-right quadrant |
| **Channel 2** | 90° ≤ angle < 180° | 135° | Back-right quadrant |
| **Channel 3** | 180° ≤ angle < 270° | 225° | Back-left quadrant |
| **Channel 4** | 270° ≤ angle < 360° | 315° | Front-left quadrant |

#### Boundary Handling

When the DOA angle falls exactly on a boundary (0°, 90°, 180°, 270°), it maps to the **first channel of that quadrant**:
- **0°** → Channel 1
- **90°** → Channel 2
- **180°** → Channel 3
- **270°** → Channel 4

### Accuracy Calculation

The accuracy field represents how confident we are that the sound source is in the assigned channel. It's calculated based on the distance from the quadrant center:

#### Formula
```
accuracy = 100 × (1 - |angle - center| / 45)
```

Where:
- `angle` = The actual DOA angle from the device (0-360°)
- `center` = The quadrant center angle (45°, 135°, 225°, or 315°)
- `45` = Half of the 90° quadrant width (maximum distance from center)

#### Accuracy Values

| Angle Position | Accuracy | Example |
|----------------|----------|---------|
| **At quadrant center** | 100% | 45°, 135°, 225°, 315° |
| **Midway between center and boundary** | 50% | 22.5°, 67.5°, 112.5°, etc. |
| **At quadrant boundary** | 0% | 0°, 90°, 180°, 270°, 360° |

#### Examples

**Example 1: Angle at quadrant center**
- DOA angle: **45°**
- Mapped channel: **Channel 1**
- Distance from center: |45° - 45°| = 0°
- Accuracy: 100 × (1 - 0/45) = **100%**

**Example 2: Angle at boundary**
- DOA angle: **90°**
- Mapped channel: **Channel 2** (first channel of 90-180° quadrant)
- Distance from center: |90° - 135°| = 45°
- Accuracy: 100 × (1 - 45/45) = **0%**

**Example 3: Angle midway**
- DOA angle: **67.5°**
- Mapped channel: **Channel 1**
- Distance from center: |67.5° - 45°| = 22.5°
- Accuracy: 100 × (1 - 22.5/45) = **50%**

**Example 4: Real-world angle**
- DOA angle: **322°**
- Mapped channel: **Channel 4** (270-360° quadrant)
- Distance from center: |322° - 315°| = 7°
- Accuracy: 100 × (1 - 7/45) = **84.4%**

---

## Recording Flow

### Step-by-Step Process

```
1. Recording Starts
   ↓
2. DOA Monitoring Begins (every 100ms)
   ↓
3. Read DOA Angle from Device
   ↓
4. Map Angle to Channel (0-90° → Ch1, 90-180° → Ch2, etc.)
   ↓
5. Calculate Accuracy (distance from quadrant center)
   ↓
6. Create Segment (100ms window with channel, angle, accuracy)
   ↓
7. Repeat every 100ms until recording stops
   ↓
8. Generate JSON File (all segments)
   ↓
9. Upload Audio + JSON to Server
```

### Detailed Flow

#### 1. Recording Initialization
```typescript
// audioRecording.ts
const recordingStartTime = Date.now();
const fileName = `${recordingStartTime}.raw`;

// Start DOA monitoring
await DOAService.startDOAMonitoringWithChannels(recordingStartTime, 100);
```

#### 2. DOA Monitoring Loop (Every 100ms)
```typescript
// doaService.ts
setInterval(async () => {
  const angle = await this.readDOAAngle(); // Read from USB device
  
  // Map to channel
  const mappedChannel = this.mapAngleToChannel(angle);
  
  // Calculate accuracy
  const accuracy = this.calculateAccuracy(angle, mappedChannel);
  
  // Create segment
  this.doaSegments.push({
    start: windowStart,      // e.g., 0ms
    end: windowEnd,          // e.g., 100ms
    channel: mappedChannel,  // 1-4
    angle: angle,            // Actual DOA angle (e.g., 45°)
    accuracy: accuracy       // 0-100 (e.g., 100.0)
  });
}, 100); // Every 100ms
```

#### 3. Recording Completion
```typescript
// When recording stops
const doaResult = DOAService.stopDOAMonitoring();

// Generate JSON file
const jsonFilePath = DOAService.generateDOAJsonFile(
  doaResult.segments,
  recordingId,
  RECORDING_DIR
);

// Upload both audio and JSON
RecordingService.convertAndUploadToServer(
  rawFile,
  recordingFiles,
  doaMetadata,
  jsonFilePath
);
```

---

## Segment Generation

### Segment Structure

Each segment represents a 100ms time window with DOA information:

```typescript
interface DOASegment {
  start: number;    // Start time in milliseconds (relative to recording start)
  end: number;      // End time in milliseconds (relative to recording start)
  channel: number;  // Channel number (1-4)
  angle: number;    // Actual DOA angle from device (0-360°)
  accuracy: number; // Accuracy percentage (0-100, rounded to 1 decimal)
}
```

### Segment Creation Rules

1. **Time Windows**: Segments are created in non-overlapping 100ms windows
   - Window 1: 0-100ms
   - Window 2: 100-200ms
   - Window 3: 200-300ms
   - etc.

2. **One Segment Per Window**: Each 100ms window produces exactly one segment

3. **Channel Assignment**: The channel is determined by the DOA angle at that moment

4. **Continuous Coverage**: Segments cover the entire recording duration without gaps

### Example Segments

For a 1-second recording (1000ms), you'll get 10 segments:

```json
[
  {
    "start": 0,
    "end": 100,
    "channel": 1,
    "angle": 45,
    "accuracy": 100.0
  },
  {
    "start": 100,
    "end": 200,
    "channel": 1,
    "angle": 67.5,
    "accuracy": 50.0
  },
  {
    "start": 200,
    "end": 300,
    "channel": 2,
    "angle": 90,
    "accuracy": 0.0
  },
  {
    "start": 300,
    "end": 400,
    "channel": 2,
    "angle": 135,
    "accuracy": 100.0
  },
  // ... 6 more segments
]
```

---

## File Output Format

### JSON File Structure

The DOA JSON file is created with the same timestamp as the audio file:

**Filename**: `{timestamp}.json` (e.g., `1766001844595.json`)

**Structure**:
```json
{
  "recordingId": "1766001844595",
  "timestamp": "2025-12-17T20:04:18.164Z",
  "segments": [
    {
      "start": 0,
      "end": 100,
      "channel": 1,
      "angle": 45,
      "accuracy": 100.0
    },
    {
      "start": 100,
      "end": 200,
      "channel": 1,
      "angle": 67.5,
      "accuracy": 50.0
    }
    // ... more segments
  ]
}
```

### Upload Process

Both files are uploaded together in a single request:
- **Audio file**: `{timestamp}.mp3`
- **JSON file**: `{timestamp}.json`

The JSON file is attached as `doaJsonFile` in the FormData along with the audio file.

---

## Technical Details

### DOA Angle Reading

The system reads DOA angles using two methods (with fallback):

1. **Python Script** (Primary)
   - Uses `pyusb` library
   - Executes `tuning.py` class from ReSpeaker SDK
   - More reliable for USB communication

2. **Node.js USB** (Fallback)
   - Uses `usb` npm package
   - Direct USB control transfer
   - Used if Python method fails

### USB Control Transfer Parameters

```typescript
const CONTROL_REQUEST_TYPE = 0xC0; // IN transfer (device to host)
const CONTROL_REQUEST = 0x00;     // Custom request code
const CONTROL_VALUE = 0x0200;     // Parameter ID for DOAANGLE
const CONTROL_INDEX = 0x0000;
```

### Sampling Rate

- **DOA Reading**: Every 100ms (10 times per second)
- **Segment Creation**: One segment per DOA reading
- **Result**: 10 segments per second

### Recording Intervals

- **Recording Duration**: 2 hours or until midnight (whichever comes first)
- **Segment Frequency**: 10 segments/second
- **Total Segments**: ~72,000 segments per 2-hour recording

### Error Handling

- **DOA Read Failure**: If angle reading fails, no segment is created for that window
- **Device Disconnection**: System attempts retry with exponential backoff
- **USB Errors**: Falls back to alternative reading method

### Performance Considerations

- **Low Overhead**: No audio processing required (uses hardware DOA directly)
- **Deterministic**: Same angle always maps to same channel
- **Real-time**: Segments created immediately as angles are read
- **Memory Efficient**: Segments stored in memory, written to JSON on completion

---

## Summary

The DOA system provides:

1. **Reliable Channel Detection**: Uses hardware DOA angle instead of audio analysis
2. **High Temporal Resolution**: 10 segments per second (100ms windows)
3. **Confidence Scoring**: Accuracy field indicates how certain we are about channel assignment
4. **Simple Logic**: Straightforward 90° quadrant mapping
5. **Complete Coverage**: Every moment of recording has a corresponding segment

This approach eliminates the complexity and unreliability of speech detection while providing precise, time-aligned channel information for every moment of the recording.

