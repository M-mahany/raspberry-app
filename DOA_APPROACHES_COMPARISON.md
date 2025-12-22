# DOA Implementation Approaches: Hardware vs Software

## Two Approaches Available

### Approach 1: Hardware DOA (Current Implementation) ✅
**Location**: Raspberry Pi app (`doaService.ts`)
- Reads DOA angle directly from ReSpeaker USB Mic Array hardware
- Real-time during recording (every 100ms)
- Uses USB control transfer to read `DOAANGLE` parameter
- **Advantages**:
  - ✅ Most accurate (hardware-calculated)
  - ✅ Real-time, no post-processing delay
  - ✅ Low CPU usage
  - ✅ Works even if audio file is corrupted
- **Disadvantages**:
  - ❌ Requires device to be connected during recording
  - ❌ Can't process old recordings without DOA data
  - ❌ Fails if USB communication fails

### Approach 2: Software DOA (From Audio File) 🔄
**Location**: Server-side worker (`whisper.py` or separate script)
- Calculates DOA from 4-channel WAV file (channels 1-4)
- Post-processing after recording
- Uses TDOA (Time Difference of Arrival) algorithms
- **Advantages**:
  - ✅ Can process old recordings
  - ✅ Fallback if hardware DOA fails
  - ✅ No hardware dependency
  - ✅ Can validate hardware DOA accuracy
- **Disadvantages**:
  - ❌ More CPU-intensive
  - ❌ Less accurate than hardware (algorithm-dependent)
  - ❌ Requires 4-channel audio file
  - ❌ Post-processing delay

---

## Current Setup

You already have the infrastructure for software DOA:

```typescript
// ffmpegService.ts - Already extracts channels 1-4!
convertChannels1To4ToWav(rawFile, diarizationFile)
// Creates: {recordingId}_diarization.wav with 4 channels
```

**But currently**: This WAV file is deleted after upload (line 201-209 in `recordingsService.ts`)

---

## Recommendation: Hybrid Approach

### Best of Both Worlds

1. **Primary**: Use hardware DOA (current implementation) ✅
   - Most accurate, real-time
   
2. **Fallback**: Calculate software DOA if hardware DOA fails or missing
   - Process the 4-channel WAV file
   - Use as backup/validation

3. **For Old Recordings**: Software DOA only
   - Process existing recordings that don't have DOA JSON

---

## Implementation Options

### Option A: Keep Current + Add Software DOA as Fallback
- Keep hardware DOA as primary
- If DOA JSON is missing or has gaps, calculate from audio file
- **Best for**: Reliability and accuracy

### Option B: Software DOA Only (Server-Side)
- Remove hardware DOA from Raspberry Pi
- Calculate DOA entirely from audio file on server
- **Best for**: Simplicity, no hardware dependency

### Option C: Both (Validation)
- Calculate both, compare results
- Use hardware DOA but validate with software
- **Best for**: Quality assurance, debugging

---

## Software DOA Implementation

To calculate DOA from audio file, you need:

1. **4-channel WAV file** (you already have this!)
2. **TDOA Algorithm** (e.g., GCC-PHAT, MUSIC, SRP-PHAT)
3. **Microphone geometry** (known positions of 4 mics)

### Example Algorithm: GCC-PHAT

```python
# Pseudocode for software DOA calculation
def calculate_doa_from_audio(audio_file_4ch):
    # Load 4-channel audio
    channels = load_audio(audio_file_4ch)  # Shape: [4, samples]
    
    # Calculate time differences between microphone pairs
    # Mic positions: arranged in circle, 90° apart
    mic_positions = [
        (0, 0),      # Mic 1 at 0°
        (r, 0),      # Mic 2 at 90°
        (0, r),      # Mic 3 at 180°
        (-r, 0),     # Mic 4 at 270°
    ]
    
    # For each time window (e.g., 100ms):
    segments = []
    for window_start in range(0, duration, 0.1):  # 100ms windows
        # Calculate TDOA between mic pairs
        tdoa_12 = calculate_tdoa(channels[0], channels[1], window_start)
        tdoa_13 = calculate_tdoa(channels[0], channels[2], window_start)
        tdoa_14 = calculate_tdoa(channels[0], channels[3], window_start)
        
        # Convert TDOA to DOA angle
        angle = tdoa_to_angle(tdoa_12, tdoa_13, tdoa_14, mic_positions)
        
        # Map to channel (same logic as hardware)
        channel = map_angle_to_channel(angle)
        accuracy = calculate_accuracy(angle, channel)
        
        segments.append({
            "start": window_start,
            "end": window_start + 0.1,
            "channel": channel,
            "angle": angle,
            "accuracy": accuracy
        })
    
    return segments
```

### Libraries for Software DOA

- **Python**: `scipy.signal`, `numpy` for signal processing
- **Specialized**: `pyroomacoustics` (room acoustics simulation)
- **Audio processing**: `librosa`, `soundfile`

---

## Which Approach Should You Use?

### For Your Use Case:

**Recommendation: Keep Hardware DOA + Add Software as Fallback**

**Reasons**:
1. ✅ Hardware DOA is more accurate and efficient
2. ✅ You already have it working
3. ✅ Software DOA can fill gaps or validate
4. ✅ Can process old recordings without DOA data

### Implementation Strategy:

1. **Keep current hardware DOA** (Raspberry Pi)
2. **Add software DOA calculation** in `whisper.py`:
   - Check if DOA JSON exists
   - If missing/incomplete, calculate from 4-channel WAV
   - Merge/validate results
3. **Don't delete 4-channel WAV** if DOA JSON is missing

---

## Code Changes Needed

### 1. Keep 4-channel WAV if DOA JSON missing

```typescript
// recordingsService.ts - Modify to keep WAV if DOA missing
if (conversionResult.diarizationFile) {
  // Only delete if DOA JSON exists
  if (doaJsonFilePath && fs.existsSync(doaJsonFilePath)) {
    fs.unlinkSync(conversionResult.diarizationFile);
  } else {
    // Keep WAV for software DOA calculation
    logger.info("📦 Keeping 4-channel WAV for software DOA calculation");
  }
}
```

### 2. Add software DOA to whisper.py

```python
# In whisper_doa.py - Add fallback
if not doa_segments:
    # Try to calculate DOA from 4-channel WAV
    doa_segments = calculate_doa_from_audio(diarization_wav_file)
```

---

## Summary

**Yes, you can implement DOA from audio file!** But:

- ✅ **Keep hardware DOA** as primary (more accurate)
- ✅ **Add software DOA** as fallback/validation
- ✅ **Use software DOA** for old recordings
- ✅ **You already have the 4-channel audio** needed!

The hybrid approach gives you the best of both worlds: accuracy from hardware, flexibility from software.

