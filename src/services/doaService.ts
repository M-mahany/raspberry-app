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
  start: number; // milliseconds (internal), converted to seconds in JSON output
  end: number; // milliseconds (internal), converted to seconds in JSON output
  channel: number; // 1-4
  angle: number; // DOA angle in degrees (actual angle from device)
  accuracy: number; // 0-100, percentage accuracy based on distance from quadrant center
}

export class DOAService {
  private static doaReadings: DOAReading[] = [];
  private static doaSegments: DOASegment[] = [];
  private static doaMonitoringInterval: NodeJS.Timeout | null = null;
  private static isMonitoring = false;

  // Recording start time
  private static recordingStartTime: number = 0;

  // Throttling for data event-based DOA readings
  private static lastDOAReadingTime: number = 0;
  private static pendingDOARead: boolean = false;
  private static samplingIntervalMs: number = 100;

  /**
   * Read DOA angle from ReSpeaker USB Mic Array
   * Uses Python script (more reliable) with Node.js USB as fallback
   */
  static async readDOAAngle(): Promise<number | null> {
    try {
      // Try Python script first
      console.log("🔍 Python DOA read...");
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
          "Tip: Verify device is connected with: lsusb - if not found, try to reboot the device"
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

  // Helper method to attempt DOA read with a specific request type - Tuning class implementation
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
                    `🔍 DOA Angle read via Node USB (requestType 0x${requestType.toString(16)}): ${angle}°`
                  );
                  console.log(
                    `🔍 DOA Angle read via Node USB (requestType 0x${requestType.toString(16)}): ${angle}°`
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
          "⚠️ Python 'usb' module (pyusb) not installed. Install with: pip3 install pyusb - if it didn't work, try apt-get install python3-pyusb or sudo apt-get install python3-pyusb"
        );
        console.log(
          "⚠️ Python 'usb' module (pyusb) not installed. Install with: pip3 install pyusb - if it didn't work, try apt-get install python3-pyusb or sudo apt-get install python3-pyusb"
        );
        return null;
      }

      // Python script to read DOAANGLE using Tuning class - note that there is a version incompatibility issue with the Tuning class, so you may need to update line 109 to use tobyte instead of tostring
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
          logger.debug(`🔍 DOA Angle read via Python: ${angle}°`);
          console.log(`🔍 DOA Angle read via Python: ${angle}°`);
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
   * Initialize DOA monitoring (called once, isolated from data events)
   * This prevents multiple initializations
   */
  static async initializeDOAMonitoring(
    recordingStartTime: number,
    samplingIntervalMs: number = 100
  ): Promise<void> {
    // Prevent multiple initializations
    if (this.isMonitoring) {
      logger.warn("⚠️ DOA monitoring is already initialized");
      return;
    }

    this.isMonitoring = true;
    this.doaReadings = [];
    this.doaSegments = [];
    this.recordingStartTime = recordingStartTime;
    this.samplingIntervalMs = samplingIntervalMs;
    this.lastDOAReadingTime = 0;
    this.pendingDOARead = false;

    logger.info(
      `📡 Initialized DOA monitoring (event-based, throttled to ${samplingIntervalMs}ms)`
    );

    // Try to read DOA immediately to test if device is available
    const initialAngle = await this.readDOAAngle();
    if (initialAngle !== null) {
      const initialTimestamp = Date.now();
      this.lastDOAReadingTime = initialTimestamp;
      this.doaReadings.push({
        angle: initialAngle,
        timestamp: initialTimestamp,
      });
      console.log(`📡 Initial DOA reading: ${initialAngle}°`);
      logger.info(`📡 Initial DOA reading: ${initialAngle}°`);

      // Create first segment starting from 0ms
      const initialRelativeTime = initialTimestamp - this.recordingStartTime;
      const initialWindowStart = Math.max(
        0,
        Math.floor(initialRelativeTime / samplingIntervalMs) *
        samplingIntervalMs
      );
      const initialWindowEnd = initialWindowStart + samplingIntervalMs;
      const initialMappedChannel = this.mapAngleToChannel(initialAngle);
      const initialAccuracy = this.calculateAccuracy(
        initialAngle,
        initialMappedChannel
      );

      this.doaSegments.push({
        start: initialWindowStart, // Should be 0ms
        end: initialWindowEnd,
        channel: initialMappedChannel,
        angle: initialAngle,
        accuracy: initialAccuracy,
      });
    } else {
      console.log(
        `⚠️ Initial DOA reading failed - device may not be available`
      );
      logger.warn(
        `⚠️ Initial DOA reading failed - device may not be available`
      );
    }
  }

  /**
   * Process DOA reading triggered by data event (throttled)
   * This is called from the data event handler, but throttled to prevent CPU overload
   */
  static async processDOAReading(): Promise<void> {
    // Prevent multiple concurrent reads
    if (this.pendingDOARead) {
      return;
    }

    // Throttle: only read if enough time has passed
    const now = Date.now();
    const timeSinceLastRead = now - this.lastDOAReadingTime;

    if (timeSinceLastRead < this.samplingIntervalMs) {
      return; // Too soon, skip this reading
    }

    // Mark as pending to prevent concurrent reads
    this.pendingDOARead = true;

    try {
      const angle = await this.readDOAAngle();
      if (angle !== null) {
        const timestamp = Date.now();
        this.lastDOAReadingTime = timestamp;

        this.doaReadings.push({
          angle,
          timestamp,
        });

        // Calculate current window start time
        const relativeTime = timestamp - this.recordingStartTime;
        const windowStart = Math.max(
          0,
          Math.floor(relativeTime / this.samplingIntervalMs) *
          this.samplingIntervalMs
        );
        const windowEnd = windowStart + this.samplingIntervalMs;

        // Map angle to channel
        const mappedChannel = this.mapAngleToChannel(angle);

        // Calculate accuracy
        const accuracy = this.calculateAccuracy(angle, mappedChannel);

        // Create segment
        this.doaSegments.push({
          start: windowStart,
          end: windowEnd,
          channel: mappedChannel,
          angle: angle,
          accuracy: accuracy,
        });

        logger.debug(
          `📡 DOA reading: ${angle}° at ${new Date().toISOString()}`
        );
        console.log(`📡 DOA reading: ${angle}°`);
      } else {
        logger.warn(`⚠️ DOA reading failed - returned null`);
        console.log(`⚠️ DOA reading failed - returned null`);
      }
    } catch (error: any) {
      logger.error(`❌ Error processing DOA reading: ${error?.message || error}`);
    } finally {
      // Always clear pending flag
      this.pendingDOARead = false;
    }
  }

  /**
   * Start monitoring DOA with channel-based speech detection
   * @deprecated Use initializeDOAMonitoring() + processDOAReading() for event-based approach
   */
  static async startDOAMonitoringWithChannels(
    recordingStartTime: number,
    samplingIntervalMs: number = 100
  ): Promise<void> {
    // For backward compatibility, use interval-based approach
    if (this.isMonitoring) {
      logger.warn("⚠️ DOA monitoring is already active");
      return;
    }

    this.isMonitoring = true;
    this.doaReadings = [];
    this.doaSegments = [];
    this.recordingStartTime = recordingStartTime;

    logger.info(
      `📡 Starting DOA monitoring with channel detection (interval-based, sampling every ${samplingIntervalMs}ms)`
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

      // Create first segment starting from 0ms
      const initialRelativeTime = initialTimestamp - this.recordingStartTime;
      const initialWindowStart = Math.max(
        0,
        Math.floor(initialRelativeTime / samplingIntervalMs) *
        samplingIntervalMs
      );
      const initialWindowEnd = initialWindowStart + samplingIntervalMs;
      const initialMappedChannel = this.mapAngleToChannel(initialAngle);
      const initialAccuracy = this.calculateAccuracy(
        initialAngle,
        initialMappedChannel
      );

      this.doaSegments.push({
        start: initialWindowStart,
        end: initialWindowEnd,
        channel: initialMappedChannel,
        angle: initialAngle,
        accuracy: initialAccuracy,
      });
    } else {
      console.log(
        `⚠️ Initial DOA reading failed - device may not be available`
      );
      logger.warn(
        `⚠️ Initial DOA reading failed - device may not be available`
      );
    }

    // Update DOA angle periodically and create segments
    this.doaMonitoringInterval = setInterval(async () => {
      const angle = await this.readDOAAngle();
      if (angle !== null) {
        const timestamp = Date.now();
        this.doaReadings.push({
          angle,
          timestamp,
        });

        const relativeTime = timestamp - this.recordingStartTime;
        const windowStart = Math.max(
          0,
          Math.floor(relativeTime / samplingIntervalMs) * samplingIntervalMs
        );
        const windowEnd = windowStart + samplingIntervalMs;

        const mappedChannel = this.mapAngleToChannel(angle);
        const accuracy = this.calculateAccuracy(angle, mappedChannel);

        this.doaSegments.push({
          start: windowStart,
          end: windowEnd,
          channel: mappedChannel,
          angle: angle,
          accuracy: accuracy,
        });

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
   * Map DOA angle to channel using 90° quadrants
   * Channel 1: 0° ≤ angle < 90°
   * Channel 2: 90° ≤ angle < 180°
   * Channel 3: 180° ≤ angle < 270°
   * Channel 4: 270° ≤ angle < 360°
   * Boundaries (0°, 90°, 180°, 270°) map to first channel of quadrant
   */
  private static mapAngleToChannel(angle: number): number {
    // Normalize angle to 0-360 range
    const normalizedAngle = ((angle % 360) + 360) % 360;

    // Map to channels using simple quadrants
    // Boundaries (0°, 90°, 180°, 270°) map to first channel of quadrant
    if (normalizedAngle >= 0 && normalizedAngle < 90) return 1;
    if (normalizedAngle >= 90 && normalizedAngle < 180) return 2;
    if (normalizedAngle >= 180 && normalizedAngle < 270) return 3;
    if (normalizedAngle >= 270 && normalizedAngle < 360) return 4;

    // Fallback (shouldn't happen)
    return 1;
  }

  /**
   * Calculate accuracy based on distance from quadrant center
   * Returns 0-100 percentage: 100% at center, 0% at boundaries
   */
  private static calculateAccuracy(angle: number, channel: number): number {
    // Normalize angle to 0-360 range
    const normalizedAngle = ((angle % 360) + 360) % 360;

    // Define quadrant centers
    const centers: { [key: number]: number } = {
      1: 45, // 0-90° quadrant center
      2: 135, // 90-180° quadrant center
      3: 225, // 180-270° quadrant center
      4: 315, // 270-360° quadrant center
    };

    const center = centers[channel];
    const maxDistance = 45; // Half of 90° quadrant width
    const distance = Math.abs(normalizedAngle - center);

    // Calculate accuracy: 100% at center, 0% at boundaries
    const accuracy = 100 * (1 - distance / maxDistance);

    // Clamp between 0 and 100, then round to 1 decimal place
    return Math.round(Math.max(0, Math.min(100, accuracy)) * 10) / 10;
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

    // Segments are already created every 100ms, so just return existing segments
    if (this.doaSegments.length > 0) {
      const segments = [...this.doaSegments];
      const readings = [...this.doaReadings];

      this.doaSegments = [];
      this.doaReadings = [];

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

  /**
   * Filter out low-accuracy segments (likely noise or boundary errors)
   * @param segments - Array of DOA segments
   * @param minAccuracy - Minimum accuracy threshold (default: 30%)
   * @returns Filtered segments
   */
  private static filterLowAccuracySegments(
    segments: DOASegment[],
    minAccuracy: number = 30
  ): DOASegment[] {
    return segments.filter((seg) => seg.accuracy >= minAccuracy);
  }

  /**
   * Merge consecutive DOA segments with the same channel into variable-length segments
   * This matches pyannote's behavior of creating segments based on speaker activity
   * @param segments - Array of DOA segments (100ms fixed intervals)
   * @param minSegmentDuration - Minimum segment duration in milliseconds (default: 200ms)
   * @returns Merged segments with variable lengths (like pyannote)
   */
  private static mergeConsecutiveSegments(
    segments: DOASegment[],
    minSegmentDuration: number = 200
  ): DOASegment[] {
    if (segments.length === 0) return [];

    // Filter low-accuracy segments first
    const filtered = this.filterLowAccuracySegments(segments, 30);

    if (filtered.length === 0) return [];

    const merged: DOASegment[] = [];
    let currentSegment = { ...filtered[0] };

    for (let i = 1; i < filtered.length; i++) {
      const nextSegment = filtered[i];

      // If same channel and consecutive (no gap), merge
      if (
        nextSegment.channel === currentSegment.channel &&
        Math.abs(nextSegment.start - currentSegment.end) < 150 // Allow small gaps (< 150ms)
      ) {
        // Extend current segment
        currentSegment.end = nextSegment.end;
        // Update angle to average (weighted by segment duration)
        const currentDuration = currentSegment.end - currentSegment.start;
        const nextDuration = nextSegment.end - nextSegment.start;
        const totalDuration = currentDuration + nextDuration;
        currentSegment.angle =
          (currentSegment.angle * currentDuration +
            nextSegment.angle * nextDuration) /
          totalDuration;
        // Use weighted average accuracy (favor higher accuracy)
        currentSegment.accuracy =
          (currentSegment.accuracy * currentDuration +
            nextSegment.accuracy * nextDuration) /
          totalDuration;
      } else {
        // Different channel or gap - save current if long enough, start new
        const duration = currentSegment.end - currentSegment.start;
        if (duration >= minSegmentDuration) {
          merged.push(currentSegment);
        }
        currentSegment = { ...nextSegment };
      }
    }

    // Don't forget the last segment
    const duration = currentSegment.end - currentSegment.start;
    if (duration >= minSegmentDuration) {
      merged.push(currentSegment);
    }

    return merged;
  }

  /**
   * Convert DOA segments to pyannote-compatible format
   * Output format matches pyannote exactly: {start, end, speaker}
   * @param segments - Array of DOA segments
   * @returns Pyannote-compatible segments
   */
  static convertToPyannoteFormat(segments: DOASegment[]): Array<{
    start: number;
    end: number;
    speaker: string;
  }> {
    // First merge consecutive segments with same channel
    const merged = this.mergeConsecutiveSegments(segments);

    // Convert to pyannote format
    return merged.map((seg) => ({
      start: seg.start / 1000, // Convert milliseconds to seconds
      end: seg.end / 1000, // Convert milliseconds to seconds
      speaker: `Channel ${seg.channel}`, // Map channel to speaker label
    }));
  }

  /**
   * Generate DOA segments JSON file
   * @param segments - Array of DOA segments
   * @param recordingId - Recording ID (timestamp from filename)
   * @param recordingDir - Directory where recordings are stored
   * @param pyannoteFormat - If true, output in pyannote-compatible format (default: true)
   * @returns Path to created JSON file
   */
  static generateDOAJsonFile(
    segments: DOASegment[],
    recordingId: string,
    recordingDir: string,
    pyannoteFormat: boolean = true
  ): string {
    let jsonData: any;

    if (pyannoteFormat) {
      // Output in pyannote-compatible format for seamless integration
      const pyannoteSegments = this.convertToPyannoteFormat(segments);
      jsonData = {
        recordingId,
        timestamp: new Date().toISOString(),
        format: "pyannote-compatible",
        segments: pyannoteSegments,
        // Include raw DOA data for reference
        metadata: {
          totalSegments: segments.length,
          mergedSegments: pyannoteSegments.length,
          source: "hardware-doa",
        },
      };
    } else {
      // Original format with full DOA details
      jsonData = {
        recordingId,
        timestamp: new Date().toISOString(),
        format: "detailed",
        segments: segments.map((seg) => ({
          start: seg.start / 1000, // Convert milliseconds to seconds
          end: seg.end / 1000, // Convert milliseconds to seconds
          channel: seg.channel,
          angle: seg.angle,
          accuracy: seg.accuracy,
        })),
      };
    }

    const jsonFilePath = join(recordingDir, `${recordingId}.json`);
    writeFileSync(jsonFilePath, JSON.stringify(jsonData, null, 2));

    logger.info(`📄 Generated DOA JSON file: ${jsonFilePath}`);
    return jsonFilePath;
  }
}
