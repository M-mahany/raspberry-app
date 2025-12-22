# DOA vs Pyannote System Review

## Executive Summary

This document reviews the DOA (Direction of Arrival) implementation as a replacement for pyannote speaker diarization. The DOA system provides **spatial channel detection** (where sound comes from) rather than **speaker identification** (who is speaking), which has important implications for accuracy and matching with Whisper transcriptions.

---

## 1. System Comparison

### Pyannote System (Previous)
- **Purpose**: Speaker diarization - identifies WHO is speaking
- **Output Format**:
  ```json
  {
    "start": 0.0,        // seconds
    "end": 2.5,          // seconds
    "speaker": "SPEAKER_00"
  }
  ```
- **Segments**: Variable-length based on speech activity
- **Time Units**: Seconds
- **Accuracy**: Can distinguish different speakers even from same direction
- **Limitations**: Requires audio processing, can be CPU-intensive

### DOA System (Current)
- **Purpose**: Direction detection - identifies WHERE sound comes from
- **Output Format**:
  ```json
  {
    "start": 0,          // milliseconds ⚠️
    "end": 100,          // milliseconds ⚠️
    "channel": 1,        // 1-4 (spatial quadrant)
    "angle": 45,         // degrees
    "accuracy": 100.0    // percentage
  }
  ```
- **Segments**: Fixed 100ms intervals (10 per second)
- **Time Units**: Milliseconds ⚠️ **INCONSISTENCY**
- **Accuracy**: Reliable for direction, but cannot distinguish speakers from same direction
- **Advantages**: Hardware-based, low CPU usage, real-time

---

## 2. Critical Issues Identified

### ⚠️ Issue #1: Time Unit Inconsistency

**Problem**: DOA uses **milliseconds** while Whisper and pyannote typically use **seconds**.

**Impact**: Server-side matching logic must convert between units, which can lead to:
- Rounding errors
- Precision loss
- Matching failures

**Current DOA Format**:
```typescript
interface DOASegment {
  start: number;    // milliseconds (0, 100, 200, ...)
  end: number;      // milliseconds (100, 200, 300, ...)
  channel: number;
  angle: number;
  accuracy: number;
}
```

**Whisper Format** (typical):
```json
{
  "start": 0.0,     // seconds
  "end": 2.5,       // seconds
  "text": "..."
}
```

**Recommendation**: 
- Option A: Convert DOA segments to seconds on server (divide by 1000)
- Option B: Convert Whisper segments to milliseconds on server (multiply by 1000)
- Option C: **Standardize DOA to use seconds** (recommended for consistency)

### ⚠️ Issue #2: Segment Granularity Mismatch

**Problem**: DOA creates **fixed 100ms segments** while Whisper creates **variable-length segments** based on speech.

**Example Scenario**:
- Whisper segment: `{start: 0.0, end: 2.5}` (2.5 seconds of speech)
- DOA segments: 25 segments covering 0-2500ms (one every 100ms)

**Matching Challenge**: 
- Need to determine which DOA channel was active during Whisper segment
- Options:
  1. **Majority vote**: Most common channel in time range
  2. **Weighted average**: Consider accuracy scores
  3. **Start time**: Use channel at segment start
  4. **Overlap calculation**: Calculate channel coverage percentage

**Current Implementation**: Not clear how server handles this matching.

### ⚠️ Issue #3: Speaker vs Channel Semantics

**Problem**: DOA provides **spatial channels** (1-4) while pyannote provides **speaker labels** (SPEAKER_00, SPEAKER_01, etc.).

**Key Difference**:
- **Pyannote**: Two speakers from same direction = different labels
- **DOA**: Two speakers from same direction = same channel

**Example**:
```
Scenario: Two people speaking from Channel 1 direction
- Pyannote: SPEAKER_00 (person 1), SPEAKER_01 (person 2)
- DOA: Channel 1 (both people)
```

**Impact on Accuracy**:
- ✅ DOA is more accurate for **spatial separation** (different directions)
- ❌ DOA is less accurate for **speaker separation** (same direction, different people)

---

## 3. Matching Flow Analysis

### Current Flow (Pyannote)
```
1. Record audio → Upload to server
2. Server processes with pyannote → Speaker segments (seconds)
3. Server processes with Whisper → Transcription segments (seconds)
4. Server matches by time overlap:
   - For each Whisper segment [start, end]
   - Find pyannote segments that overlap
   - Assign speaker label to Whisper segment
```

### Proposed Flow (DOA)
```
1. Record audio + DOA segments → Upload to server
2. Server processes with Whisper → Transcription segments (seconds)
3. Server matches DOA with Whisper:
   - Convert DOA segments to seconds (divide by 1000)
   - For each Whisper segment [start, end]
   - Find DOA segments that overlap
   - Determine channel (majority vote or weighted)
   - Assign channel to Whisper segment
```

### Matching Algorithm Requirements

The server needs to implement:

```typescript
function matchDOAWithWhisper(
  whisperSegment: { start: number; end: number }, // seconds
  doaSegments: DOASegment[] // milliseconds
): number | null {
  // 1. Convert DOA to seconds
  const doaInSeconds = doaSegments.map(s => ({
    start: s.start / 1000,
    end: s.end / 1000,
    channel: s.channel,
    accuracy: s.accuracy
  }));
  
  // 2. Find overlapping segments
  const overlapping = doaInSeconds.filter(s => 
    s.start < whisperSegment.end && s.end > whisperSegment.start
  );
  
  // 3. Determine channel (majority vote with accuracy weighting)
  if (overlapping.length === 0) return null;
  
  const channelScores = new Map<number, number>();
  overlapping.forEach(s => {
    const weight = s.accuracy / 100; // Normalize accuracy
    channelScores.set(
      s.channel,
      (channelScores.get(s.channel) || 0) + weight
    );
  });
  
  // Return channel with highest weighted score
  return Array.from(channelScores.entries())
    .sort((a, b) => b[1] - a[1])[0][0];
}
```

---

## 4. Accuracy Assessment

### ✅ DOA Advantages

1. **Hardware-based**: More reliable than software analysis
2. **Real-time**: No post-processing delay
3. **Low CPU**: Minimal computational overhead
4. **Consistent**: Same angle always maps to same channel
5. **Spatial accuracy**: Excellent for directional separation

### ❌ DOA Limitations

1. **Cannot distinguish speakers from same direction**
   - Two people speaking from Channel 1 → Both labeled as Channel 1
   - Pyannote would label them as SPEAKER_00 and SPEAKER_01

2. **Fixed granularity**: 100ms segments may miss quick speaker changes
   - If speaker changes mid-segment, entire segment gets one channel

3. **No silence detection**: DOA segments created even during silence
   - May assign channel to non-speech audio

4. **Boundary ambiguity**: Angles at quadrant boundaries (0°, 90°, 180°, 270°) have 0% accuracy
   - Could map to wrong channel if angle is exactly on boundary

### Accuracy Comparison Matrix

| Scenario | Pyannote | DOA | Winner |
|----------|----------|-----|--------|
| Single speaker, clear direction | ✅ High | ✅ High | Tie |
| Multiple speakers, different directions | ✅ High | ✅ High | Tie |
| Multiple speakers, same direction | ✅ High | ❌ Low | Pyannote |
| Speaker moves during speech | ✅ High | ⚠️ Medium | Pyannote |
| Background noise | ⚠️ Medium | ⚠️ Medium | Tie |
| Overlapping speech | ⚠️ Medium | ❌ Low | Pyannote |

---

## 5. Recommendations

### 🔧 Immediate Fixes Required

#### 1. **Standardize Time Units**
   - **Option A** (Recommended): Convert DOA segments to seconds in `doaService.ts`
   ```typescript
   // In generateDOAJsonFile or before upload
   segments: segments.map(seg => ({
     start: seg.start / 1000,  // Convert to seconds
     end: seg.end / 1000,        // Convert to seconds
     channel: seg.channel,
     angle: seg.angle,
     accuracy: seg.accuracy
   }))
   ```
   
   - **Option B**: Document time unit clearly and ensure server handles conversion

#### 2. **Add Segment Metadata**
   - Include recording duration in JSON
   - Add segment count for validation
   - Include sampling rate (100ms = 10 Hz)

#### 3. **Improve Boundary Handling**
   - Consider using 8 channels (45° increments) instead of 4 (90° increments)
   - Or implement fuzzy boundary logic (e.g., 89.5°-90.5° → both channels considered)

### 📊 Server-Side Requirements

1. **Matching Algorithm**: Implement weighted channel assignment
2. **Time Conversion**: Handle milliseconds → seconds conversion
3. **Fallback Logic**: Handle cases where no DOA segments overlap
4. **Validation**: Verify DOA segment coverage matches audio duration

### 🎯 Long-term Improvements

1. **Hybrid Approach**: Use DOA for spatial separation + pyannote for speaker identification
2. **Adaptive Sampling**: Increase DOA sampling rate during detected speech
3. **Confidence Thresholds**: Filter out low-accuracy segments
4. **Channel History**: Use previous segments to smooth channel transitions

---

## 6. Compatibility Check

### ✅ Compatible Aspects

- ✅ Time-based segments (can be matched by overlap)
- ✅ JSON format (easy to parse)
- ✅ Uploaded with audio file (same flow)
- ✅ Recording ID linking (same mechanism)

### ⚠️ Requires Server Changes

- ⚠️ Time unit conversion (milliseconds → seconds)
- ⚠️ Matching algorithm (channel assignment vs speaker assignment)
- ⚠️ UI/display changes (show "Channel 1" instead of "SPEAKER_00")

---

## 7. Conclusion

### Is DOA a Solid Replacement?

**For spatial separation**: ✅ **YES** - DOA is more reliable and efficient

**For speaker identification**: ❌ **NO** - DOA cannot distinguish speakers from same direction

### Will It Follow the Same Flow?

**Partially**: 
- ✅ Same upload flow
- ✅ Same segment-based matching concept
- ⚠️ Requires time unit conversion
- ⚠️ Requires different matching algorithm (channel vs speaker)

### Recommendation

1. **Short-term**: Fix time unit inconsistency, implement server-side matching
2. **Medium-term**: Evaluate accuracy in real-world scenarios
3. **Long-term**: Consider hybrid approach (DOA + pyannote) for best accuracy

---

## 8. Action Items

- [ ] **Fix time units**: Convert DOA segments to seconds before upload
- [ ] **Document matching algorithm**: Specify how server should match DOA with Whisper
- [ ] **Add validation**: Ensure DOA segment coverage matches audio duration
- [ ] **Test accuracy**: Compare DOA vs pyannote on real recordings
- [ ] **Update server code**: Implement DOA matching logic
- [ ] **Handle edge cases**: Boundary angles, missing segments, silence periods

---

**Review Date**: 2025-01-XX  
**Reviewed By**: AI Assistant  
**Status**: ⚠️ Requires fixes before production deployment

