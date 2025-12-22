# DOA Event-Based Optimization

## Problem Solved

### Before (Interval-Based)
- ❌ Used `setInterval` every 100ms regardless of audio activity
- ❌ Multiple initializations possible if `data` event fires before initialization completes
- ❌ CPU overhead from periodic timers
- ❌ Not synchronized with actual audio data flow

### After (Event-Based with Throttling)
- ✅ Uses `data` event (synchronized with audio)
- ✅ Single initialization (isolated from data events)
- ✅ Throttled to prevent CPU overload
- ✅ Only reads DOA when audio data is actually flowing

---

## Key Improvements

### 1. Isolated Initialization

**Before**:
```typescript
micInputStream.on("data", async function () {
  if (!doaMonitoringStarted) {
    doaMonitoringStarted = true;
    await DOAService.startDOAMonitoringWithChannels(...); // Could be called multiple times!
  }
});
```

**After**:
```typescript
// Initialize ONCE, isolated from data events
let doaMonitoringInitialized = false;
const actualRecordingStartTime = Date.now();

(async () => {
  if (!doaMonitoringInitialized) {
    doaMonitoringInitialized = true;
    await DOAService.initializeDOAMonitoring(actualRecordingStartTime, 100);
  }
})();

// Data event only triggers readings (throttled)
micInputStream.on("data", async function () {
  if (doaMonitoringInitialized) {
    DOAService.processDOAReading(); // Throttled internally
  }
});
```

**Benefits**:
- ✅ Initialization happens once, immediately
- ✅ No risk of multiple initializations
- ✅ Data event only triggers readings, not initialization

---

### 2. Event-Based DOA Readings with Throttling

**New Method**: `processDOAReading()`
- Called from `data` event handler
- **Throttled internally** to prevent CPU overload
- **Prevents concurrent reads** with `pendingDOARead` flag
- Only reads if enough time has passed since last read

**Throttling Logic**:
```typescript
static async processDOAReading(): Promise<void> {
  // Prevent concurrent reads
  if (this.pendingDOARead) {
    return; // Skip if already reading
  }

  // Throttle: only read if enough time has passed
  const now = Date.now();
  const timeSinceLastRead = now - this.lastDOAReadingTime;

  if (timeSinceLastRead < this.samplingIntervalMs) {
    return; // Too soon, skip
  }

  // Mark as pending and read
  this.pendingDOARead = true;
  try {
    const angle = await this.readDOAAngle();
    // ... process reading
  } finally {
    this.pendingDOARead = false; // Always clear
  }
}
```

**Benefits**:
- ✅ Reads DOA when audio data arrives (better synchronization)
- ✅ Throttled to ~100ms intervals (prevents CPU overload)
- ✅ Prevents concurrent reads (no race conditions)
- ✅ Non-blocking (fire and forget)

---

## Performance Comparison

### CPU Usage

**Before (Interval-Based)**:
- Timer fires every 100ms regardless of audio
- Even during silence, DOA is read
- Fixed overhead from timer management

**After (Event-Based)**:
- Only reads when audio data arrives
- Automatically pauses during silence (no data events)
- Lower CPU usage during quiet periods

### Synchronization

**Before**:
- DOA readings may not align with actual audio chunks
- Fixed 100ms intervals may miss rapid changes

**After**:
- DOA readings triggered by actual audio data
- Better alignment with audio flow
- Still throttled to prevent overload

---

## Implementation Details

### New Methods in DOAService

1. **`initializeDOAMonitoring()`**
   - Called once at recording start
   - Sets up monitoring state
   - Performs initial DOA reading
   - Isolated from data events

2. **`processDOAReading()`**
   - Called from data event handler
   - Throttled internally
   - Prevents concurrent reads
   - Non-blocking

### State Management

```typescript
private static lastDOAReadingTime: number = 0;      // Throttling timestamp
private static pendingDOARead: boolean = false;    // Prevents concurrent reads
private static samplingIntervalMs: number = 100;    // Throttle interval
```

---

## Usage

### In audioRecording.ts

```typescript
// 1. Initialize once (isolated)
let doaMonitoringInitialized = false;
const actualRecordingStartTime = Date.now();

(async () => {
  if (!doaMonitoringInitialized) {
    doaMonitoringInitialized = true;
    await DOAService.initializeDOAMonitoring(actualRecordingStartTime, 100);
  }
})();

// 2. Trigger readings on data events (throttled)
micInputStream.on("data", async function () {
  micLastActive = Date.now();
  isMicActive = true;

  if (doaMonitoringInitialized) {
    // Fire and forget - throttling handled internally
    DOAService.processDOAReading().catch((error) => {
      logger.error(`⚠️ Error in DOA reading: ${error?.message || error}`);
    });
  }
});
```

---

## Benefits Summary

### ✅ Performance
- Lower CPU usage (only reads when audio data arrives)
- No unnecessary reads during silence
- Better synchronization with audio flow

### ✅ Reliability
- Single initialization (no race conditions)
- Prevents concurrent reads
- Proper error handling

### ✅ Efficiency
- Event-driven (not timer-driven)
- Throttled to prevent overload
- Non-blocking operations

---

## Backward Compatibility

The old `startDOAMonitoringWithChannels()` method is still available for backward compatibility, but marked as deprecated. New code should use:
- `initializeDOAMonitoring()` - for initialization
- `processDOAReading()` - for event-based readings

---

## Testing

### Test Cases

1. **Single Initialization**
   - ✅ Verify initialization happens only once
   - ✅ Multiple data events don't trigger multiple initializations

2. **Throttling**
   - ✅ Verify readings are throttled to ~100ms
   - ✅ Rapid data events don't cause CPU overload

3. **Concurrent Read Prevention**
   - ✅ Verify `pendingDOARead` flag prevents concurrent reads
   - ✅ Flag is always cleared (even on error)

4. **Silence Handling**
   - ✅ No data events during silence = no DOA reads
   - ✅ CPU usage drops during quiet periods

---

## Migration Notes

If you're using the old interval-based approach, you can migrate by:

1. Replace `startDOAMonitoringWithChannels()` with `initializeDOAMonitoring()`
2. Add `processDOAReading()` call in data event handler
3. Remove `setInterval` usage

The new approach is more efficient and reliable!

