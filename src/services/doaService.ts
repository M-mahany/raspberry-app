import { usb } from "usb";
import logger from "../utils/winston/logger";
import { exec } from "child_process";
import { promisify } from "util";

const execPromise = promisify(exec);

// ReSpeaker USB Mic Array USB Vendor and Product IDs
// These may need to be adjusted based on actual device
const RESPEAKER_VENDOR_ID = 0x2886; // Seeed Studio vendor ID
const RESPEAKER_PRODUCT_ID = 0x0018; // ReSpeaker USB Mic Array product ID

// USB Control Transfer Parameters for DOA
// Based on respeaker/usb_4_mic_array tuning.py implementation
const CONTROL_REQUEST_TYPE = 0x40; // Vendor request, host to device
const CONTROL_REQUEST = 0x00; // Custom request code
const CONTROL_VALUE = 0x0200; // Parameter ID for DOAANGLE
const CONTROL_INDEX = 0x0000;

interface DOAReading {
  angle: number;
  timestamp: number;
}

export class DOAService {
  private static doaReadings: DOAReading[] = [];
  private static doaMonitoringInterval: NodeJS.Timeout | null = null;
  private static isMonitoring = false;

  /**
   * Read DOA angle from ReSpeaker USB Mic Array
   * Uses Python script (more reliable) with Node.js USB as fallback
   */
  static async readDOAAngle(): Promise<number | null> {
    try {
      // Try Python script first (more reliable, based on respeaker tools)
      const pythonResult = await this.readDOAViaPython();
      if (pythonResult !== null) {
        return pythonResult;
      }

      // Fallback to Node.js USB approach
      return await this.readDOAViaNodeUSB();
    } catch (error: any) {
      logger.error(
        `❌ Error reading DOA angle: ${error?.message || error}`,
      );
      return null;
    }
  }

  /**
   * Read DOA angle using Node.js USB library (fallback method)
   */
  private static async readDOAViaNodeUSB(): Promise<number | null> {
    try {
      const devices = usb.getDeviceList();
      const device = devices.find(
        (d) =>
          d.deviceDescriptor.idVendor === RESPEAKER_VENDOR_ID &&
          d.deviceDescriptor.idProduct === RESPEAKER_PRODUCT_ID,
      );

      if (!device) {
        logger.debug("📡 ReSpeaker USB Mic Array not found via USB");
        return null;
      }

      device.open();
      const interfaceNumber = 0; // Usually interface 0
      const iface = device.interface(interfaceNumber);

      if (iface.isKernelDriverActive()) {
        iface.detachKernelDriver();
      }

      iface.claim();

      // Read DOAANGLE parameter
      // Control transfer: bmRequestType, bRequest, wValue, wIndex, data_or_length
      const result = device.controlTransfer(
        CONTROL_REQUEST_TYPE,
        CONTROL_REQUEST,
        CONTROL_VALUE,
        CONTROL_INDEX,
        4, // 4 bytes for int32
      );

      iface.release(true);
      device.close();

      if (result && result.length >= 4) {
        // Parse 32-bit signed integer (little-endian)
        const angle = result.readInt32LE(0);
        logger.debug(`📡 DOA Angle read via Node USB: ${angle}°`);
        return angle;
      }

      return null;
    } catch (usbError: any) {
      logger.debug(
        `⚠️ Node.js USB control transfer failed: ${usbError?.message || usbError}`,
      );
      return null;
    }
  }

  /**
   * Read DOA angle using Python script (fallback method)
   * Requires pyusb and respeaker tools to be installed
   */
  private static async readDOAViaPython(): Promise<number | null> {
    try {
      // Python script to read DOAANGLE
      const pythonScript = `
import usb.core
import usb.util
import struct

# Find ReSpeaker USB Mic Array
dev = usb.core.find(idVendor=0x2886, idProduct=0x0018)
if dev is None:
    exit(1)

try:
    dev.set_configuration()
    # Read DOAANGLE parameter (parameter ID 0x0200)
    result = dev.ctrl_transfer(0x40, 0x00, 0x0200, 0x0000, 4)
    if len(result) == 4:
        angle = struct.unpack('<i', result)[0]
        print(angle)
    else:
        exit(1)
except Exception as e:
    exit(1)
`;

      const { stdout } = await execPromise(`python3 -c "${pythonScript}"`);
      const angle = parseInt(stdout.trim(), 10);

      if (!isNaN(angle)) {
        logger.debug(`📡 DOA Angle read via Python: ${angle}°`);
        return angle;
      }
    } catch (error: any) {
      logger.warn(
        `⚠️ Python DOA reading failed: ${error?.message || error}. DOA data will not be available.`,
      );
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
    logger.info(`📡 Starting DOA monitoring (sampling every ${samplingIntervalMs}ms)`);

    this.doaMonitoringInterval = setInterval(async () => {
      const angle = await this.readDOAAngle();
      if (angle !== null) {
        this.doaReadings.push({
          angle,
          timestamp: Date.now(),
        });
        logger.debug(`📡 DOA reading: ${angle}° at ${new Date().toISOString()}`);
      }
    }, samplingIntervalMs);
  }

  /**
   * Stop DOA monitoring and return collected readings
   */
  static stopDOAMonitoring(): DOAReading[] {
    if (this.doaMonitoringInterval) {
      clearInterval(this.doaMonitoringInterval);
      this.doaMonitoringInterval = null;
    }

    this.isMonitoring = false;
    const readings = [...this.doaReadings];
    this.doaReadings = [];

    logger.info(`📡 DOA monitoring stopped. Collected ${readings.length} readings`);
    return readings;
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

