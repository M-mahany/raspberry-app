import { usb } from "usb";
import logger from "../utils/winston/logger";
import { exec } from "child_process";
import { promisify } from "util";
import { writeFileSync, unlinkSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const execPromise = promisify(exec);

// ReSpeaker USB Mic Array USB Vendor and Product IDs
const RESPEAKER_VENDOR_ID = 0x2886;
const RESPEAKER_PRODUCT_ID = 0x0018;

// USB Control Transfer Parameters for DOA
const CONTROL_REQUEST_TYPE = 0xc0; // IN transfer
const CONTROL_REQUEST = 0x00;
const CONTROL_VALUE = 0x0200; // Parameter ID for DOAANGLE
const CONTROL_INDEX = 0x0000;

export interface DOASegment {
  start: number; // milliseconds
  end: number; // milliseconds
  channel: number; // 1-4
  angle: number; // DOA angle in degrees
  accuracy: number; // 0-100, percentage accuracy
}

export class DOAService {
  private static doaSegments: DOASegment[] = [];
  private static doaMonitoringInterval: NodeJS.Timeout | null = null;
  private static isMonitoring = false;
  private static recordingStartTime: number = 0;
  private static recentAngles: number[] = []; // Buffer for smoothing
  private static readonly SMOOTHING_WINDOW_SIZE = 5; // Number of readings to average

  /**
   * Read DOA angle from ReSpeaker USB Mic Array
   */
  static async readDOAAngle(): Promise<number | null> {
    try {
      // Try Python script first (more reliable)
      const pythonResult = await this.readDOAViaPython();
      if (pythonResult !== null) {
        return pythonResult;
      }

      // Fallback to Node.js USB
      return await this.readDOAViaNodeUSB();
    } catch (error: any) {
      logger.error(`❌ Error reading DOA angle: ${error?.message || error}`);
      return null;
    }
  }

  /**
   * Read DOA angle using Node.js USB library
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
        return null;
      }

      return new Promise<number | null>((resolve) => {
        try {
          foundDevice.open();
          const config = foundDevice.configDescriptor;
          if (config) {
            foundDevice.setConfiguration(config.bConfigurationValue);
          } else {
            foundDevice.setConfiguration(1);
          }

          const iface = foundDevice.interface(0);
          if (iface.isKernelDriverActive()) {
            iface.detachKernelDriver();
          }
          iface.claim();

          foundDevice.controlTransfer(
            CONTROL_REQUEST_TYPE,
            CONTROL_REQUEST,
            CONTROL_VALUE,
            CONTROL_INDEX,
            4,
            (error, buffer) => {
              try {
                if (error) {
                  iface.release(true);
                  foundDevice.close();
                  return resolve(null);
                }

                if (buffer && Buffer.isBuffer(buffer) && buffer.length >= 4) {
                  const angle = buffer.readInt32LE(0);
                  iface.release(true);
                  foundDevice.close();
                  resolve(angle);
                } else {
                  iface.release(true);
                  foundDevice.close();
                  resolve(null);
                }
              } catch (e) {
                try {
                  iface.release(true);
                  foundDevice.close();
                } catch {
                  // Ignore cleanup errors
                }
                resolve(null);
              }
            }
          );
        } catch {
          resolve(null);
        }
      });
    } catch (error: any) {
      return null;
    }
  }

  /**
   * Read DOA angle using Python script
   */
  private static async readDOAViaPython(): Promise<number | null> {
    try {
      await execPromise("python3 --version");
    } catch {
      return null;
    }

    try {
      await execPromise("python3 -c 'import usb.core'");
    } catch {
      return null;
    }

    const pythonScript = `import sys
import os
sys.path.insert(0, '/home/ops-ai-node33/usb_4_mic_array')
from tuning import Tuning
import usb.core
import time

dev = usb.core.find(idVendor=0x2886, idProduct=0x0018)
if dev is None:
    print("ERROR: Device not found", file=sys.stderr)
    sys.exit(1)

max_retries = 3
retry_count = 0

while retry_count <= max_retries:
    try:
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
            sys.exit(1)

sys.exit(1)`;

    const tempFile = join(tmpdir(), `doa_read_${Date.now()}.py`);
    try {
      writeFileSync(tempFile, pythonScript);
      const { stdout } = await execPromise(`python3 "${tempFile}"`);
      const angle = parseInt(stdout.trim(), 10);
      unlinkSync(tempFile);

      if (!isNaN(angle)) {
        return angle;
      }
    } catch {
      try {
        unlinkSync(tempFile);
      } catch {
        // Ignore cleanup errors
      }
    }

    return null;
  }

  /**
   * Start DOA monitoring
   */
  static async startDOAMonitoring(
    recordingStartTime: number,
    samplingIntervalMs: number = 100
  ): Promise<void> {
    if (this.isMonitoring) {
      return;
    }

    this.isMonitoring = true;
    this.doaSegments = [];
    this.recordingStartTime = recordingStartTime;
    this.recentAngles = []; // Reset smoothing buffer

    logger.info(`📡 Starting DOA monitoring (sampling every ${samplingIntervalMs}ms)`);

    // Initial reading
    const initialAngle = await this.readDOAAngle();
    if (initialAngle !== null) {
      const smoothedAngle = this.smoothAngle(initialAngle);
      const initialTimestamp = Date.now();
      const initialRelativeTime = initialTimestamp - this.recordingStartTime;
      const initialWindowStart = Math.max(
        0,
        Math.floor(initialRelativeTime / samplingIntervalMs) * samplingIntervalMs
      );
      const initialWindowEnd = initialWindowStart + samplingIntervalMs;
      const initialMappedChannel = this.mapAngleToChannel(smoothedAngle);
      const initialAccuracy = this.calculateAccuracy(smoothedAngle, initialMappedChannel);

      this.doaSegments.push({
        start: initialWindowStart,
        end: initialWindowEnd,
        channel: initialMappedChannel,
        angle: smoothedAngle,
        accuracy: initialAccuracy,
      });
    }

    // Periodic readings
    this.doaMonitoringInterval = setInterval(async () => {
      const angle = await this.readDOAAngle();
      if (angle !== null) {
        const smoothedAngle = this.smoothAngle(angle);
        const timestamp = Date.now();
        const relativeTime = timestamp - this.recordingStartTime;
        const windowStart = Math.max(
          0,
          Math.floor(relativeTime / samplingIntervalMs) * samplingIntervalMs
        );
        const windowEnd = windowStart + samplingIntervalMs;
        const mappedChannel = this.mapAngleToChannel(smoothedAngle);
        const accuracy = this.calculateAccuracy(smoothedAngle, mappedChannel);

        this.doaSegments.push({
          start: windowStart,
          end: windowEnd,
          channel: mappedChannel,
          angle: smoothedAngle,
          accuracy: accuracy,
        });
      }
    }, samplingIntervalMs);
  }

  /**
   * Stop DOA monitoring and return segments
   */
  static stopDOAMonitoring(): DOASegment[] {
    if (this.doaMonitoringInterval) {
      clearInterval(this.doaMonitoringInterval);
      this.doaMonitoringInterval = null;
    }

    this.isMonitoring = false;

    const segments = [...this.doaSegments];
    this.doaSegments = [];

    logger.info(`📡 DOA monitoring stopped. Collected ${segments.length} segments`);
    return segments;
  }

  /**
   * Smooth angle readings using circular mean to reduce noise
   */
  private static smoothAngle(angle: number): number {
    // Normalize angle
    const normalizedAngle = ((angle % 360) + 360) % 360;

    // Add to buffer
    this.recentAngles.push(normalizedAngle);

    // Keep only recent readings
    if (this.recentAngles.length > this.SMOOTHING_WINDOW_SIZE) {
      this.recentAngles.shift();
    }

    // Calculate circular mean (handles wrapping)
    if (this.recentAngles.length === 1) {
      return this.recentAngles[0];
    }

    // Convert to radians for circular mean calculation
    const radians = this.recentAngles.map(a => (a * Math.PI) / 180);
    const sinSum = radians.reduce((sum, r) => sum + Math.sin(r), 0);
    const cosSum = radians.reduce((sum, r) => sum + Math.cos(r), 0);
    const meanRad = Math.atan2(sinSum / radians.length, cosSum / radians.length);
    const meanDeg = (meanRad * 180) / Math.PI;

    return ((meanDeg % 360) + 360) % 360;
  }

  /**
   * Map DOA angle to channel using 90° quadrants
   */
  private static mapAngleToChannel(angle: number): number {
    const normalizedAngle = ((angle % 360) + 360) % 360;
    if (normalizedAngle >= 0 && normalizedAngle < 90) return 1;
    if (normalizedAngle >= 90 && normalizedAngle < 180) return 2;
    if (normalizedAngle >= 180 && normalizedAngle < 270) return 3;
    if (normalizedAngle >= 270 && normalizedAngle < 360) return 4;
    return 1;
  }

  /**
   * Calculate accuracy based on distance from quadrant center
   * Handles angle wrapping correctly (e.g., 350° to 45° = 55° distance, not 305°)
   */
  private static calculateAccuracy(angle: number, channel: number): number {
    const normalizedAngle = ((angle % 360) + 360) % 360;
    const centers: { [key: number]: number } = {
      1: 45,
      2: 135,
      3: 225,
      4: 315,
    };

    const center = centers[channel];
    const maxDistance = 45;

    // Calculate circular distance (handles wrapping)
    let distance = Math.abs(normalizedAngle - center);
    if (distance > 180) {
      distance = 360 - distance; // Wrap around the circle
    }

    const accuracy = 100 * (1 - distance / maxDistance);

    return Math.round(Math.max(0, Math.min(100, accuracy)) * 10) / 10;
  }

  /**
   * Merge consecutive segments with same channel
   */
  private static mergeConsecutiveSegments(
    segments: DOASegment[],
    minSegmentDuration: number = 200
  ): DOASegment[] {
    if (segments.length === 0) return [];

    // Increased accuracy threshold from 30% to 50% for better speaker identification
    const filtered = segments.filter((seg) => seg.accuracy >= 50);
    if (filtered.length === 0) return [];

    const merged: DOASegment[] = [];
    let currentSegment = { ...filtered[0] };

    for (let i = 1; i < filtered.length; i++) {
      const nextSegment = filtered[i];

      if (
        nextSegment.channel === currentSegment.channel &&
        Math.abs(nextSegment.start - currentSegment.end) < 150
      ) {
        currentSegment.end = nextSegment.end;
        const currentDuration = currentSegment.end - currentSegment.start;
        const nextDuration = nextSegment.end - nextSegment.start;
        const totalDuration = currentDuration + nextDuration;
        currentSegment.angle =
          (currentSegment.angle * currentDuration +
            nextSegment.angle * nextDuration) /
          totalDuration;
        currentSegment.accuracy =
          (currentSegment.accuracy * currentDuration +
            nextSegment.accuracy * nextDuration) /
          totalDuration;
      } else {
        const duration = currentSegment.end - currentSegment.start;
        if (duration >= minSegmentDuration) {
          merged.push(currentSegment);
        }
        currentSegment = { ...nextSegment };
      }
    }

    const duration = currentSegment.end - currentSegment.start;
    if (duration >= minSegmentDuration) {
      merged.push(currentSegment);
    }

    return merged;
  }

  /**
   * Generate DOA JSON file in pyannote-compatible format
   */
  static generateDOAJsonFile(
    segments: DOASegment[],
    recordingId: string,
    recordingDir: string
  ): string {
    // Merge consecutive segments
    const merged = this.mergeConsecutiveSegments(segments);

    // Convert to pyannote-compatible format
    const jsonData = {
      recordingId,
      timestamp: new Date().toISOString(),
      format: "pyannote-compatible",
      segments: merged.map((seg) => ({
        start: seg.start / 1000, // Convert to seconds
        end: seg.end / 1000, // Convert to seconds
        speaker: `Channel ${seg.channel}`,
      })),
      metadata: {
        totalSegments: segments.length,
        mergedSegments: merged.length,
        source: "hardware-doa",
      },
    };

    const jsonFilePath = join(recordingDir, `${recordingId}.json`);
    writeFileSync(jsonFilePath, JSON.stringify(jsonData, null, 2));

    logger.info(`📄 Generated DOA JSON file: ${jsonFilePath}`);
    return jsonFilePath;
  }
}

