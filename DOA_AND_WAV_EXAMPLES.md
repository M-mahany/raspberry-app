# DOA and WAV File Output Examples

This document provides examples of the DOA (Direction of Arrival) output format and the WAV file structure used in the Raspberry Pi audio recording system.

---

## DOA Output Format

### Overview
DOA readings are collected during audio recording at regular intervals (default: every 2 seconds). The DOA angle represents the direction from which sound is arriving, measured in degrees.

### DOA Reading Structure

Each DOA reading contains:
- `angle`: The direction angle in degrees (integer, typically -180 to 180)
- `timestamp`: Unix timestamp in milliseconds when the reading was taken

### Example: Single DOA Reading

```typescript
interface DOAReading {
  angle: number;      // e.g., 45 (degrees)
  timestamp: number;  // e.g., 1704067200000 (Unix timestamp in ms)
}
```

**Example value:**
```json
{
  "angle": 45,
  "timestamp": 1704067200000
}
```

### Example: DOA Metadata (Complete Output)

When a recording completes, the DOA service returns metadata containing:
- `doaAngle`: The most recent/latest DOA angle (or null if unavailable)
- `doaData`: Array of all DOA readings collected during the recording session

```typescript
interface DOAMetadata {
  doaAngle?: number | null;
  doaData?: Array<{ angle: number; timestamp: number }>;
}
```

**Example DOA Metadata:**
```json
{
  "doaAngle": 45,
  "doaData": [
    {
      "angle": 0,
      "timestamp": 1704067200000
    },
    {
      "angle": 15,
      "timestamp": 1704067202000
    },
    {
      "angle": 30,
      "timestamp": 1704067204000
    },
    {
      "angle": 45,
      "timestamp": 1704067206000
    },
    {
      "angle": 45,
      "timestamp": 1704067208000
    }
  ]
}
```

### Real-World Example Scenario

**Recording Session:**
- Recording started at: `1704067200000` (2024-01-01 00:00:00 UTC)
- Recording duration: ~10 seconds
- DOA sampling interval: 2 seconds
- Total readings: 5

**DOA Output:**
```json
{
  "doaAngle": 90,
  "doaData": [
    {
      "angle": 0,
      "timestamp": 1704067200000,
      "time_relative": "0.0s"
    },
    {
      "angle": 30,
      "timestamp": 1704067202000,
      "time_relative": "2.0s"
    },
    {
      "angle": 60,
      "timestamp": 1704067204000,
      "time_relative": "4.0s"
    },
    {
      "angle": 90,
      "timestamp": 1704067206000,
      "time_relative": "6.0s"
    },
    {
      "angle": 90,
      "timestamp": 1704067208000,
      "time_relative": "8.0s"
    }
  ]
}
```

**Interpretation:**
- At 0s: Sound source detected at 0° (directly in front)
- At 2s: Sound source moved to 30° (slightly to the right)
- At 4s: Sound source at 60° (more to the right)
- At 6s-8s: Sound source stabilized at 90° (directly to the right)

---

## WAV File Format

### Overview
The WAV file is created from channels 1-4 of the raw 6-channel audio recording. It's specifically designed for speaker diarization processing.

### WAV File Specifications

**File Naming Convention:**
```
{timestamp}_diarization.wav
```

**Example filename:**
```
1704067200000_diarization.wav
```

### Technical Specifications

| Property | Value |
|----------|-------|
| **Format** | WAV (Waveform Audio File Format) |
| **Audio Codec** | PCM (Pulse Code Modulation) |
| **Sample Rate** | 16,000 Hz (16 kHz) |
| **Bit Depth** | 16-bit |
| **Channels** | 4 channels |
| **Byte Order** | Little-endian |
| **Channel Mapping** | Channels 1-4 from original 6-channel recording |

### Channel Structure

The 4-channel WAV file contains raw microphone data:

```
Channel 0 (in WAV) → Original Channel 1 (Microphone 1)
Channel 1 (in WAV) → Original Channel 2 (Microphone 2)
Channel 2 (in WAV) → Original Channel 3 (Microphone 3)
Channel 3 (in WAV) → Original Channel 4 (Microphone 4)
```

**Note:** Channel 0 from the original recording (processed/beamformed audio) is NOT included in the diarization WAV file. It's used separately for transcription (MP3 file).

### WAV File Structure (Binary Format)

```
┌─────────────────────────────────────────────────────────┐
│ RIFF Header (12 bytes)                                  │
│ - "RIFF" (4 bytes)                                      │
│ - File size - 8 (4 bytes)                              │
│ - "WAVE" (4 bytes)                                      │
├─────────────────────────────────────────────────────────┤
│ fmt Chunk (24 bytes)                                    │
│ - "fmt " (4 bytes)                                      │
│ - Chunk size: 16 (4 bytes)                             │
│ - Audio format: 1 = PCM (2 bytes)                       │
│ - Number of channels: 4 (2 bytes)                       │
│ - Sample rate: 16000 (4 bytes)                          │
│ - Byte rate: 128000 (4 bytes) = 16000 * 4 * 2           │
│ - Block align: 8 (2 bytes) = 4 channels * 2 bytes      │
│ - Bits per sample: 16 (2 bytes)                         │
├─────────────────────────────────────────────────────────┤
│ data Chunk                                              │
│ - "data" (4 bytes)                                      │
│ - Data size (4 bytes)                                   │
│ - Audio samples (interleaved):                          │
│   [Ch0_sample1, Ch1_sample1, Ch2_sample1, Ch3_sample1,│
│    Ch0_sample2, Ch1_sample2, Ch2_sample2, Ch3_sample2,│
│    ...]                                                 │
└─────────────────────────────────────────────────────────┘
```

### Example: File Size Calculation

For a 10-second recording:

```
Sample rate: 16,000 Hz
Channels: 4
Bit depth: 16 bits (2 bytes per sample)
Duration: 10 seconds

Total samples = 16,000 × 10 = 160,000 samples per channel
Total samples (all channels) = 160,000 × 4 = 640,000 samples
Data size = 640,000 × 2 bytes = 1,280,000 bytes (~1.28 MB)

Total file size ≈ 1,280,000 + 44 bytes (headers) ≈ 1,280,044 bytes
```

### Usage in Speaker Diarization

The 4-channel WAV file is used for:
1. **TDOA (Time Difference of Arrival)** - Calculate time differences between microphones
2. **Beamforming** - Steer audio beams toward detected speakers
3. **Spatial Clustering** - Group audio segments by spatial location
4. **ML-based Diarization** - Input to models like pyannote.audio

### Example: Complete Recording File Set

When a recording completes, three files are created:

```
1704067200000.raw                    # Original 6-channel raw recording
1704067200000_transcript.mp3         # Channel 0 → MP3 (for Whisper)
1704067200000_diarization.wav        # Channels 1-4 → 4-channel WAV (for diarization)
```

**Upload to Server:**
- `transcript.mp3` → Uploaded with `fileType: "transcript"`
- `diarization.wav` → Uploaded with `fileType: "diarization"` + DOA metadata

---

## Integration Example

### Complete Recording Output

When a recording session completes, here's what gets uploaded to the server:

**1. Transcript File Upload:**
```javascript
FormData {
  mediaFile: <1704067200000_transcript.mp3>,
  fileType: "transcript",
  recordingId: "1704067200000",
  timeZone: "America/New_York"
}
```

**2. Diarization File Upload:**
```javascript
FormData {
  mediaFile: <1704067200000_diarization.wav>,
  fileType: "diarization",
  recordingId: "1704067200000",
  timeZone: "America/New_York",
  doaAngle: "45",
  doaData: "[{\"angle\":0,\"timestamp\":1704067200000},{\"angle\":45,\"timestamp\":1704067206000}]"
}
```

### Server-Side Processing

The server receives:
- **WAV file**: 4-channel audio for diarization algorithms
- **DOA data**: Spatial information to help identify speaker locations
- **Recording ID**: Links transcript and diarization files together

The DOA data can be used to:
- Validate diarization results
- Provide spatial context for speaker identification
- Improve accuracy when multiple speakers are present

---

## Summary

### DOA Output
- **Format**: JSON array of `{angle, timestamp}` objects
- **Sampling**: Every 2 seconds during recording
- **Angle Range**: Typically -180° to 180°
- **Usage**: Spatial context for speaker diarization

### WAV File
- **Format**: 4-channel PCM WAV
- **Specs**: 16 kHz, 16-bit, little-endian
- **Content**: Raw microphone data from channels 1-4
- **Usage**: Input for speaker diarization algorithms

Both outputs work together to provide complete audio analysis: the WAV file contains the audio data, while the DOA data provides spatial information about where sounds originated.

