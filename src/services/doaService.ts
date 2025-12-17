import { usb } from "usb";
import logger from "../utils/winston/logger";
import { exec } from "child_process";
import { promisify } from "util";
import { Buffer } from "buffer";
import { formatDOASegments } from "../utils/helpers";
import { writeFileSync, unlinkSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const execPromise = promisify(exec);

// ReSpeaker USB Mic Array USB Vendor and Product IDs
// These may need to be adjusted based on actual device
const RESPEAKER_VENDOR_ID = 0x2886; // Seeed Studio vendor ID
const RESPEAKER_PRODUCT_ID = 0x0018; // ReSpeaker USB Mic Array product ID

// USB Control Transfer Parameters for DOA
// Based on respeaker/usb_4_mic_array tuning.py implementation
// Python uses 0x40 but pyusb auto-detects direction - Node.js needs explicit 0xC0 for IN
const CONTROL_REQUEST_TYPE = 0xc0; // IN transfer (device to host) - bit 7=1 for reading
const CONTROL_REQUEST = 0x00; // Custom request code
const CONTROL_VALUE = 0x0200; // Parameter ID for DOAANGLE
const CONTROL_INDEX = 0x0000;

export interface DOAReading {
  angle: number;
  timestamp: number;
}

export interface DOASegment {
  start: number; // milliseconds
  end: number; // milliseconds
  channel: number; // 1-4
  angle: number; // DOA angle in degrees
}

export class DOAService {
  private static doaReadings: DOAReading[] = [];
  private static doaSegments: DOASegment[] = [];
  private static doaMonitoringInterval: NodeJS.Timeout | null = null;
  private static isMonitoring = false;

  // Track active speech segments per channel
  private static activeSegments: Map<
    number,
    {
      start: number;
      lastAngle: number;
      lastUpdate: number;
    }
  > = new Map();

  // Recording start time
  private static recordingStartTime: number = 0;

  // Audio processing parameters
  private static readonly CHANNELS = 6;
  private static readonly BYTES_PER_SAMPLE = 2; // 16-bit
  private static readonly SPEECH_THRESHOLD = 500; // Amplitude threshold for speech detection
  private static readonly SILENCE_DURATION_MS = 500; // Close segment after 500ms silence

  /**
   * Read DOA angle from ReSpeaker USB Mic Array
   * Uses Python script (more reliable) with Node.js USB as fallback
   */
  static async readDOAAngle(): Promise<number | null> {
    try {
      // Try Python script first (more reliable, based on respeaker tools)
      console.log("🔍 Attempting Python DOA read...");
      const pythonResult = await this.readDOAViaPython();
      if (pythonResult !== null) {
        console.log(`✅ Python DOA read successful: ${pythonResult}°`);
        return pythonResult;
      }
      console.log("⚠️ Python DOA read failed, trying Node USB...");

      // Fallback to Node.js USB approach
      const nodeResult = await this.readDOAViaNodeUSB();
      if (nodeResult !== null) {
        console.log(`✅ Node USB DOA read successful: ${nodeResult}°`);
        return nodeResult;
      }
      console.log("⚠️ Node USB DOA read also failed");

      // If both fail, check if device might be reconnecting after power cycle
      // Don't log as error if device was recently power cycled
      return null;
    } catch (error: any) {
      logger.error(`❌ Error reading DOA angle: ${error?.message || error}`);
      console.log(`❌ Error reading DOA angle: ${error?.message || error}`);
      return null;
    }
  }

  /**
   * Read DOA angle using Node.js USB library (fallback method)
   */
  private static async readDOAViaNodeUSB(): Promise<number | null> {
    try {
      const devices = usb.getDeviceList();
      const foundDevice = devices.find(
        (d) =>
          d.deviceDescriptor.idVendor === RESPEAKER_VENDOR_ID &&
          d.deviceDescriptor.idProduct === RESPEAKER_PRODUCT_ID
      );

      if (!foundDevice) {
        logger.debug("📡 ReSpeaker USB Mic Array not found via USB");
        console.log("📡 ReSpeaker USB Mic Array not found via USB");
        console.log(
          `🔍 Looking for Vendor: 0x${RESPEAKER_VENDOR_ID.toString(16)}, Product: 0x${RESPEAKER_PRODUCT_ID.toString(16)}`
        );
        console.log(`🔍 Found ${devices.length} USB device(s), listing all:`);
        devices.forEach((d, i) => {
          console.log(
            `  ${i + 1}. Vendor: 0x${d.deviceDescriptor.idVendor.toString(16)}, Product: 0x${d.deviceDescriptor.idProduct.toString(16)}`
          );
        });
        console.log(
          "�� Tip: Verify device is connected with: lsusb | grep 2886"
        );
        return null;
      }

      console.log(
        `📡 Found ReSpeaker device: Vendor ${foundDevice.deviceDescriptor.idVendor.toString(16)}, Product ${foundDevice.deviceDescriptor.idProduct.toString(16)}`
      );

      // Use attemptDOARead with 0xC0 (IN transfer for reading)
      const result = await this.attemptDOARead(
        foundDevice,
        CONTROL_REQUEST_TYPE
      );
      return result;
    } catch (usbError: any) {
      logger.debug(
        `⚠️ Node.js USB control transfer failed: ${usbError?.message || usbError}`
      );
      console.log(`⚠️ Node.js USB exception: ${usbError?.message || usbError}`);
      console.log(`⚠️ USB error stack:`, usbError?.stack);
      return null;
    }
  }

  // Helper method to attempt DOA read with a specific request type
  private static async attemptDOARead(
    foundDevice: any,
    requestType: number
  ): Promise<number | null> {
    // Helper function to open and setup device
    const openAndSetupDevice = () => {
      const device = foundDevice;

      // CRITICAL: Open device first
      device.open();

      // CRITICAL: Set configuration - must match device's active configuration
      try {
        // Get active configuration or set to 1
        const config = device.configDescriptor;
        if (config) {
          device.setConfiguration(config.bConfigurationValue);
        } else {
          device.setConfiguration(1);
        }
      } catch (e) {
        // If already configured, ignore error
      }

      const interfaceNumber = 0;
      const iface = device.interface(interfaceNumber);

      // CRITICAL: Detach kernel driver if active (allows us to claim interface)
      if (iface.isKernelDriverActive()) {
        iface.detachKernelDriver();
      }

      // CRITICAL: Claim interface (exclusive access)
      iface.claim();

      return { device, iface };
    };

    // Helper function to close device
    const closeDevice = (device: any, iface: any) => {
      try {
        if (iface) {
          iface.release(true);
        }
      } catch (e) {
        // Ignore cleanup errors
      }
      try {
        if (device) {
          device.close();
        }
      } catch (e) {
        // Ignore cleanup errors
      }
    };

    let retryCount = 0;
    const maxRetries = 2;

    return new Promise<number | null>((resolve) => {
      const attemptTransfer = () => {
        let device: any = null;
        let iface: any = null;

        try {
          // Open and setup device for this attempt
          const setup = openAndSetupDevice();
          device = setup.device;
          iface = setup.iface;

          device.controlTransfer(
            requestType,
            CONTROL_REQUEST,
            CONTROL_VALUE,
            CONTROL_INDEX,
            4, // 4 bytes for int32
            (error: Error | null, buffer: Buffer | undefined) => {
              try {
                if (error) {
                  const usbError = error as Error & { errno?: number };
                  const isStall =
                    usbError.message?.includes("STALL") ||
                    usbError.errno === 4 ||
                    usbError.message?.includes("TRANSFER_STALL") ||
                    usbError.message?.includes("PIPE");

                  // Close device before retry
                  closeDevice(device, iface);

                  if (isStall && retryCount < maxRetries) {
                    retryCount++;
                    logger.debug(
                      `⚠️ USB transfer error (requestType 0x${requestType.toString(16)}), retrying (attempt ${retryCount}/${maxRetries})...`
                    );
                    console.log(
                      `⚠️ USB transfer error (requestType 0x${requestType.toString(16)}), retrying (attempt ${retryCount}/${maxRetries})...`
                    );

                    // Wait before retry and reopen device - give device time to recover
                    setTimeout(() => {
                      attemptTransfer();
                    }, 300); // Increased from 200ms to 300ms for better recovery
                    return;
                  }

                  // Max retries reached or non-stall error
                  logger.debug(
                    `⚠️ USB control transfer error (requestType 0x${requestType.toString(16)}): ${usbError.message}`
                  );
                  console.log(
                    `⚠️ USB control transfer error (requestType 0x${requestType.toString(16)}): ${usbError.message}`
                  );
                  if (usbError.errno) {
                    console.log(`⚠️ Error code: ${usbError.errno}`);
                  }
                  return resolve(null);
                }

                // Success - parse buffer
                if (buffer && Buffer.isBuffer(buffer) && buffer.length >= 4) {
                  const angle = buffer.readInt32LE(0);
                  closeDevice(device, iface);
                  logger.debug(
                    `�� DOA Angle read via Node USB (requestType 0x${requestType.toString(16)}): ${angle}°`
                  );
                  console.log(
                    `�� DOA Angle read via Node USB (requestType 0x${requestType.toString(16)}): ${angle}°`
                  );
                  resolve(angle);
                } else {
                  closeDevice(device, iface);
                  const bufferInfo = Buffer.isBuffer(buffer)
                    ? `length ${buffer.length}`
                    : typeof buffer === "number"
                      ? `number ${buffer}`
                      : "null";
                  logger.warn(`⚠️ Invalid buffer from USB: ${bufferInfo}`);
                  console.log(`⚠️ Invalid buffer from USB: ${bufferInfo}`);
                  resolve(null);
                }
              } catch (callbackError: any) {
                // Catch any exceptions in callback
                closeDevice(device, iface);
                logger.error(
                  `⚠️ Exception in USB callback: ${callbackError?.message}`
                );
                console.log(
                  `⚠️ Exception in USB callback: ${callbackError?.message}`
                );
                resolve(null);
              }
            }
          );
        } catch (transferError: any) {
          closeDevice(device, iface);
          logger.error(
            `⚠️ Failed to initiate USB control transfer: ${transferError?.message}`
          );
          console.log(
            `⚠️ Failed to initiate USB control transfer: ${transferError?.message}`
          );
          resolve(null);
        }
      };

      // Start first attempt
      attemptTransfer();
    });
  }

  /**
   * Read DOA angle using Python script (fallback method)
   * Requires pyusb and respeaker tools to be installed
   */
  private static async readDOAViaPython(): Promise<number | null> {
    try {
      // Check if python3 is available first
      try {
        await execPromise("python3 --version");
      } catch (pyCheckError: any) {
        logger.debug("⚠️ python3 not available, skipping Python DOA read");
        return null;
      }

      // Check if pyusb is installed
      try {
        await execPromise("python3 -c 'import usb.core'");
      } catch (pyusbCheckError: any) {
        logger.warn(
          "⚠️ Python 'usb' module (pyusb) not installed. Install with: pip3 install pyusb"
        );
        console.log(
          "⚠️ Python 'usb' module (pyusb) not installed. Install with: pip3 install pyusb"
        );
        return null;
      }

      // Python script to read DOAANGLE using official Tuning class
      const pythonScript = `import sys
import os

# Add the usb_4_mic_array directory to Python path
sys.path.insert(0, '/home/ops-ai-node33/usb_4_mic_array')

from tuning import Tuning
import usb.core
import time

# Find ReSpeaker USB Mic Array
dev = usb.core.find(idVendor=0x2886, idProduct=0x0018)
if dev is None:
    print("ERROR: Device not found", file=sys.stderr)
    sys.exit(1)

max_retries = 3
retry_count = 0

while retry_count <= max_retries:
    try:
        # Use official Tuning class - handles all USB communication properly
        Mic_tuning = Tuning(dev)
        angle = Mic_tuning.direction
        print(angle)
        sys.exit(0)
    except Exception as e:
        retry_count += 1
        if retry_count <= max_retries:
            time.sleep(0.3)
            try:
                dev.reset()
            except:
                pass
            continue
        else:
            print("ERROR: " + str(e), file=sys.stderr)
            import traceback
            traceback.print_exc(file=sys.stderr)
            sys.exit(1)

sys.exit(1)
`;

      const tempFile = join(tmpdir(), `doa_read_${Date.now()}.py`);
      try {
        writeFileSync(tempFile, pythonScript);
        const { stdout, stderr } = await execPromise(`python3 "${tempFile}"`);
        const angle = parseInt(stdout.trim(), 10);

        if (!isNaN(angle)) {
          logger.debug(`�� DOA Angle read via Python: ${angle}°`);
          console.log(`�� DOA Angle read via Python: ${angle}°`);
          return angle;
        } else {
          logger.warn(
            `⚠️ Python DOA reading returned invalid number: ${stdout.trim()}`
          );
          console.log(
            `⚠️ Python DOA reading returned invalid number: "${stdout.trim()}"`
          );
          if (stderr) {
            console.log(`⚠️ Python stderr: ${stderr}`);
          }
        }
      } catch (error: any) {
        // Only log as warning if it's not a missing module error
        if (
          error?.stderr?.includes("ModuleNotFoundError") ||
          error?.message?.includes("ModuleNotFoundError")
        ) {
          logger.debug(
            `⚠️ Python 'usb' module not installed. Install with: pip3 install pyusb`
          );
        } else {
          logger.warn(
            `⚠️ Python DOA reading failed: ${error?.message || error}. DOA data will not be available.`
          );
          console.log(
            `⚠️ Python DOA reading failed: ${error?.message || error}`
          );
        }

        // Always show stderr if available
        if (error.stderr) {
          const stderrStr =
            typeof error.stderr === "string"
              ? error.stderr
              : error.stderr.toString();
          if (stderrStr.trim()) {
            logger.warn(`⚠️ Python stderr: ${stderrStr}`);
            console.log(`⚠️ Python stderr: ${stderrStr}`);
          }
        }

        // Also show stdout if available (might contain error info)
        if (error.stdout) {
          const stdoutStr =
            typeof error.stdout === "string"
              ? error.stdout
              : error.stdout.toString();
          if (stdoutStr.trim()) {
            logger.debug(`⚠️ Python stdout: ${stdoutStr}`);
            console.log(`⚠️ Python stdout: ${stdoutStr}`);
          }
        }

        // Show error code
        if (error.code !== undefined) {
          logger.debug(`⚠️ Python error code: ${error.code}`);
          console.log(`⚠️ Python error code: ${error.code}`);
        }
      } finally {
        // Clean up temp file
        try {
          unlinkSync(tempFile);
        } catch (cleanupError) {
          // Ignore cleanup errors
        }
      }
    } catch (error: any) {
      // Only log as warning if it's not a missing module error
      if (
        error?.stderr?.includes("ModuleNotFoundError") ||
        error?.message?.includes("ModuleNotFoundError")
      ) {
        logger.debug(
          `⚠️ Python 'usb' module not installed. Install with: pip3 install pyusb`
        );
      } else {
        logger.warn(
          `⚠️ Python DOA reading failed: ${error?.message || error}. DOA data will not be available.`
        );
        console.log(`⚠️ Python DOA reading failed: ${error?.message || error}`);
      }

      // Always show stderr if available
      if (error.stderr) {
        const stderrStr =
          typeof error.stderr === "string"
            ? error.stderr
            : error.stderr.toString();
        if (stderrStr.trim()) {
          logger.warn(`⚠️ Python stderr: ${stderrStr}`);
          console.log(`⚠️ Python stderr: ${stderrStr}`);
        }
      }

      // Also show stdout if available (might contain error info)
      if (error.stdout) {
        const stdoutStr =
          typeof error.stdout === "string"
            ? error.stdout
            : error.stdout.toString();
        if (stdoutStr.trim()) {
          logger.debug(`⚠️ Python stdout: ${stdoutStr}`);
          console.log(`⚠️ Python stdout: ${stdoutStr}`);
        }
      }

      // Show error code
      if (error.code !== undefined) {
        logger.debug(`⚠️ Python error code: ${error.code}`);
        console.log(`⚠️ Python error code: ${error.code}`);
      }
    }

    return null;
  }

  /**
   * Start monitoring DOA angle during recording
   * Samples DOA every 1-2 seconds and stores readings with timestamps
   */
  static startDOAMonitoring(samplingIntervalMs: number = 2000): void {
    if (this.isMonitoring) {
      logger.warn("⚠️ DOA monitoring is already active");
      return;
    }

    this.isMonitoring = true;
    this.doaReadings = [];
    logger.info(
      `📡 Starting DOA monitoring (sampling every ${samplingIntervalMs}ms)`
    );

    this.doaMonitoringInterval = setInterval(async () => {
      const angle = await this.readDOAAngle();
      if (angle !== null) {
        this.doaReadings.push({
          angle,
          timestamp: Date.now(),
        });
        logger.debug(
          `📡 DOA reading: ${angle}° at ${new Date().toISOString()}`
        );
      }
    }, samplingIntervalMs);
  }

  /**
   * Start monitoring DOA with channel-based speech detection
   */
  static async startDOAMonitoringWithChannels(
    recordingStartTime: number,
    samplingIntervalMs: number = 100
  ): Promise<void> {
    if (this.isMonitoring) {
      logger.warn("⚠️ DOA monitoring is already active");
      return;
    }

    this.isMonitoring = true;
    this.doaReadings = [];
    this.doaSegments = [];
    this.activeSegments.clear();
    this.recordingStartTime = recordingStartTime;

    logger.info(
      `📡 Starting DOA monitoring with channel detection (sampling every ${samplingIntervalMs}ms)`
    );

    // Try to read DOA immediately to test if device is available
    const initialAngle = await this.readDOAAngle();
    if (initialAngle !== null) {
      const initialTimestamp = Date.now();
      this.doaReadings.push({
        angle: initialAngle,
        timestamp: initialTimestamp,
      });
      console.log(`📡 Initial DOA reading: ${initialAngle}°`);
      logger.info(`📡 Initial DOA reading: ${initialAngle}°`);
    } else {
      console.log(
        `⚠️ Initial DOA reading failed - device may not be available`
      );
      logger.warn(
        `⚠️ Initial DOA reading failed - device may not be available`
      );
    }

    // Update DOA angle periodically
    this.doaMonitoringInterval = setInterval(async () => {
      const angle = await this.readDOAAngle();
      if (angle !== null) {
        const timestamp = Date.now();
        this.doaReadings.push({
          angle,
          timestamp,
        });

        // Update active segments with latest angle
        this.updateActiveSegments(angle, timestamp);

        logger.debug(
          `📡 DOA reading: ${angle}° at ${new Date().toISOString()}`
        );
        console.log(`📡 DOA reading: ${angle}°`);
      } else {
        logger.warn(`⚠️ DOA reading failed - returned null`);
        console.log(`⚠️ DOA reading failed - returned null`);
      }
    }, samplingIntervalMs);
  }

  /**
   * Process audio chunk to detect speech on channels 1-4
   */
  static processAudioChunk(audioBuffer: Buffer): void {
    if (!this.isMonitoring) return;

    const currentTime = Date.now();
    const relativeTime = currentTime - this.recordingStartTime;

    // Parse 6-channel audio buffer
    // Format: interleaved samples [ch0_sample1, ch1_sample1, ch2_sample1, ch3_sample1, ch4_sample1, ch5_sample1, ch0_sample2, ...]
    const samplesPerChannel =
      audioBuffer.length / (this.CHANNELS * this.BYTES_PER_SAMPLE);

    // Extract channels 1-4 (indices 1-4 in 0-indexed)
    const channelData: number[][] = [[], [], [], []]; // For channels 1-4

    for (let i = 0; i < samplesPerChannel; i++) {
      for (let ch = 1; ch <= 4; ch++) {
        const offset = (i * this.CHANNELS + ch) * this.BYTES_PER_SAMPLE;
        if (offset + 1 < audioBuffer.length) {
          const sample = audioBuffer.readInt16LE(offset);
          channelData[ch - 1].push(Math.abs(sample));
        }
      }
    }

    // Detect speech on each channel
    for (let ch = 1; ch <= 4; ch++) {
      const channelIndex = ch - 1;
      const samples = channelData[channelIndex];

      if (samples.length === 0) continue;

      // Calculate RMS (Root Mean Square) energy for speech detection
      const sumSquares = samples.reduce(
        (sum, sample) => sum + sample * sample,
        0
      );
      const rms = Math.sqrt(sumSquares / samples.length);

      const hasSpeech = rms > this.SPEECH_THRESHOLD;
      const channelKey = ch;

      if (hasSpeech) {
        // Speech detected - start or continue segment
        if (!this.activeSegments.has(channelKey)) {
          // Start new segment
          const currentAngle = this.getCurrentDOAAngle();
          this.activeSegments.set(channelKey, {
            start: relativeTime,
            lastAngle: currentAngle,
            lastUpdate: currentTime,
          });
          logger.debug(
            `🎤 Speech detected on channel ${ch} at ${relativeTime}ms, DOA: ${currentAngle}°`
          );
          console.log(
            `🎤 Speech detected on channel ${ch} at ${relativeTime}ms, DOA: ${currentAngle}°, Total readings: ${this.doaReadings.length}`
          );
        } else {
          // Update existing segment
          const segment = this.activeSegments.get(channelKey)!;
          const currentAngle = this.getCurrentDOAAngle();
          segment.lastAngle = currentAngle;
          segment.lastUpdate = currentTime;
        }
      } else {
        // No speech - check if we should close segment
        if (this.activeSegments.has(channelKey)) {
          const segment = this.activeSegments.get(channelKey)!;
          const silenceDuration = currentTime - segment.lastUpdate;

          if (silenceDuration >= this.SILENCE_DURATION_MS) {
            // Close segment
            this.closeSegment(channelKey, relativeTime);
          }
        }
      }
    }
  }

  /**
   * Close a speech segment and add to segments array
   */
  private static closeSegment(channel: number, endTime: number): void {
    const segment = this.activeSegments.get(channel);
    if (!segment) return;

    // Use the most recent angle, or calculate average angle during segment
    let finalAngle = segment.lastAngle;

    // If we have readings during this segment, use the most recent one
    if (this.doaReadings.length > 0) {
      const segmentStartTime = this.recordingStartTime + segment.start;
      const segmentEndTime = this.recordingStartTime + endTime;

      // Find readings during this segment
      const readingsDuringSegment = this.doaReadings.filter(
        (r) => r.timestamp >= segmentStartTime && r.timestamp <= segmentEndTime
      );

      if (readingsDuringSegment.length > 0) {
        // Use the most recent reading during the segment
        finalAngle =
          readingsDuringSegment[readingsDuringSegment.length - 1].angle;
      } else {
        // Use the most recent reading overall if no readings during segment
        finalAngle = this.doaReadings[this.doaReadings.length - 1].angle;
      }
    }

    this.doaSegments.push({
      start: segment.start,
      end: endTime,
      channel: channel,
      angle: finalAngle,
    });

    this.activeSegments.delete(channel);
    logger.debug(
      `🔇 Speech ended on channel ${channel} at ${endTime}ms, Final DOA: ${finalAngle}°`
    );
    console.log(
      `🔇 Speech ended on channel ${channel} at ${endTime}ms, Final DOA: ${finalAngle}°`
    );
  }

  /**
   * Update active segments with latest DOA angle
   */
  private static updateActiveSegments(angle: number, timestamp: number): void {
    for (const [, segment] of this.activeSegments.entries()) {
      // Update angle if segment is still active
      segment.lastAngle = angle;
      segment.lastUpdate = timestamp;
    }
  }

  /**
   * Get current DOA angle (from most recent reading)
   */
  private static getCurrentDOAAngle(): number {
    if (this.doaReadings.length === 0) {
      return 0; // Default angle if no readings yet
    }
    return this.doaReadings[this.doaReadings.length - 1].angle;
  }

  /**
   * Stop DOA monitoring and return collected readings
   */
  static stopDOAMonitoring():
    | DOAReading[]
    | { segments: DOASegment[]; readings: DOAReading[] } {
    if (this.doaMonitoringInterval) {
      clearInterval(this.doaMonitoringInterval);
      this.doaMonitoringInterval = null;
    }

    this.isMonitoring = false;

    // If we have active segments, return segments and readings
    if (this.activeSegments.size > 0 || this.doaSegments.length > 0) {
      // Close all active segments
      const currentTime = Date.now();
      const relativeTime = currentTime - this.recordingStartTime;

      for (const channel of this.activeSegments.keys()) {
        this.closeSegment(channel, relativeTime);
      }

      const segments = [...this.doaSegments];
      const readings = [...this.doaReadings];

      this.doaSegments = [];
      this.doaReadings = [];
      this.activeSegments.clear();

      logger.info(
        `📡 DOA monitoring stopped. Collected ${segments.length} segments, ${readings.length} readings`
      );

      console.log("\n📊 ========== DOA SEGMENTS OUTPUT ==========");
      console.log(formatDOASegments(segments));
      console.log("\n📊 Raw JSON:");
      console.log(JSON.stringify(segments, null, 2));
      console.log("📊 =========================================\n");

      return { segments, readings };
    }

    // Otherwise return just readings (backward compatibility)
    const readings = [...this.doaReadings];
    this.doaReadings = [];

    logger.info(
      `📡 DOA monitoring stopped. Collected ${readings.length} readings`
    );
    return readings;
  }

  /**
   * Get current DOA segments without stopping monitoring
   */
  static getDOASegments(): DOASegment[] {
    return [...this.doaSegments];
  }

  /**
   * Get current DOA readings without stopping monitoring
   */
  static getDOAReadings(): DOAReading[] {
    return [...this.doaReadings];
  }

  /**
   * Get the most recent DOA angle
   */
  static getLatestDOAAngle(): number | null {
    if (this.doaReadings.length === 0) {
      return null;
    }
    return this.doaReadings[this.doaReadings.length - 1].angle;
  }

  /**
   * Clear stored DOA readings
   */
  static clearDOAReadings(): void {
    this.doaReadings = [];
  }
}
