import os from "os";
import osu from "os-utils";
import si from "systeminformation";
import dotenv from "dotenv";
import simpleGit from "simple-git";
import { exec } from "child_process";
import logger from "../utils/winston/logger";
import util from "util";
import { usb, getDeviceList } from "usb";
import { NotificationEvent, NotificationSevrice } from "./notificationService";
import {
  cancelNextRestart,
  recordingSession,
  restartRecording,
  scheduleNextRestart,
  startRecording,
  stopRecording,
} from "../jobs/audioRecording";

const git = simpleGit();
const execPromise = util.promisify(exec);

dotenv.config();

interface SystemUsage {
  cpuUsage: string;
  memoryUsage: string;
  totalMemory: string;
  usedMemory: string;
}

let isCheckingUSBMic = {
  timeStamp: 0,
  isActive: false,
  buffer: 30000,
};

let isCheckingSystemMic = {
  timeStamp: 0,
  isActive: false,
  buffer: 30000,
};

let isRefreshingUsbPorts = false;

export class SystemService {
  static async getSystemHealth() {
    try {
      const { cpuUsage, memoryUsage, totalMemory, usedMemory } =
        await this.getSystemUsage();
      const { totalSpace, usedSpace, avaiableSpace, diskUsage } =
        await this.getDiskInfo();
      const { cpuTemp, gpuTemp } = await this.getTemperatures();
      return {
        uptime: `${(os.uptime() / 3600).toFixed(2)} hours`,
        cpuUsage,
        cpuCount: os.cpus().length,
        memoryUsage,
        totalMemory,
        usedMemory,
        totalSpace,
        usedSpace,
        avaiableSpace,
        diskUsage,
        cpuTemp,
        gpuTemp,
      };
    } catch (error) {
      throw new Error(`System Healt Error: ${error}`);
    }
  }
  static getSystemUsage(): Promise<SystemUsage> {
    return new Promise((resolve) => {
      osu.cpuUsage((cpuUsage) => {
        const totalMemory = os.totalmem();
        const freeMemory = os.freemem();
        const usedMemory = totalMemory - freeMemory;
        const memoryUsage = ((usedMemory / totalMemory) * 100).toFixed(2); // Convert to %

        resolve({
          cpuUsage: `${(cpuUsage * 100).toFixed(2) || 0}%`, // Convert to percentage
          memoryUsage: `${memoryUsage || 0}%`, // RAM usage in percentage
          totalMemory: `${(totalMemory / 1024 ** 3).toFixed(2)}GB`,
          usedMemory: `${(usedMemory / 1024 ** 3).toFixed(2)}GB`,
        });
      });
    });
  }
  static async getDiskInfo() {
    try {
      const diskInfo = await si.fsSize();
      const disk = diskInfo[0];
      return {
        totalSpace: `${(disk.size / 1024 ** 3).toFixed(2)} GB`,
        usedSpace: `${(disk.used / 1024 ** 3).toFixed(2)} GB`,
        avaiableSpace: `${(disk.available / 1024 ** 3).toFixed(2)} GB`,
        diskUsage: `${disk.use}%`,
      };
    } catch (error) {
      throw new Error(`Error retriving disk info ${error}`);
    }
  }
  static async getTemperatures() {
    try {
      const cpuTemp = await si.cpuTemperature();

      let gpuTemp = "N/A";
      try {
        const { stdout } = await execPromise("vcgencmd measure_temp");
        const match = stdout.match(/temp=([\d.]+)'C/);
        gpuTemp = match ? `${match[1]}°C` : "N/A";
      } catch (gpuError: any) {
        logger.warn(
          "Failed to retrieve GPU temperature:",
          gpuError?.message || gpuError,
        );
      }

      return {
        cpuTemp: `${cpuTemp?.main || "N/A"}°C`,
        gpuTemp,
      };
    } catch (error: any) {
      throw new Error(
        `Error retrieving CPU & GPU temperature: ${error?.message || error}`,
      );
    }
  }

  static async CPUHealthUsage() {
    try {
      const cpuUsagePercentage: number = await new Promise((resolve) => {
        osu.cpuUsage((usage) => {
          resolve(usage * 100 || 0);
        });
      });

      if (cpuUsagePercentage > 70) {
        await NotificationSevrice.sendHeartBeatToServer(
          NotificationEvent.DEVICE_CPU_ALARM,
          {
            key: "cpuUsage",
            value: cpuUsagePercentage,
          },
        );
      }
    } catch (error: any) {
      logger.error(
        `Error retrieving CPU temperature: ${error?.message || error}`,
      );
    }
  }

  static async restartApp() {
    // Restart the app using PM2
    logger.info("♻️ Restarting the app...");
    try {
      const { stdout } = await execPromise("pm2 restart ai-voice-app");
      logger.info(`✅ App restarted successfully:\n${stdout}`);
    } catch (err) {
      logger.error(`❌ Failed to restart app: ${err}`);
    }
  }

  static async checkForUpdates(): Promise<{ code: number; message: string }> {
    try {
      logger.info("🔍 Checking for updates...");

      // Fetch latest changes
      await git.fetch();

      // Get local and remote commit hashes
      const localCommit = await git.revparse(["HEAD"]);
      const remoteCommit = await git.revparse(["origin/main"]);

      if (localCommit !== remoteCommit) {
        logger.info("🚀 New updates found! Pulling latest changes...");

        // Pull latest code
        await git.pull("origin", "main");

        // Check if package.json changed (to reinstall dependencies)
        // const changedFiles = await git.diffSummary(["HEAD~1"]);
        // const needsNpmInstall = changedFiles.files.some((file) =>
        //   file.file.includes("package.json"),
        // );

        // if (needsNpmInstall) {
        logger.info("📦 Installing dependencies...");
        try {
          const { stdout } = await execPromise("npm install");
          logger.info(`✅ Dependencies updated:\n${stdout}`);
        } catch (err) {
          logger.error(`❌ Failed to install dependencies: ${err}`);
          return { code: 500, message: "Failed to install dependencies" };
        }
        // }

        //Building app before restarting
        logger.info("📦 Building app in process...");
        try {
          const { stdout } = await execPromise("npm run build");
          logger.info(`✅ App successfully Built:\n${stdout}`);
        } catch (err) {
          logger.error(`❌ Failed to building application ${err}`);
          return { code: 500, message: "Failed to building application" };
        }

        this.restartApp();

        return { code: 200, message: "✅ App updated successfully" };
      } else {
        logger.info("✅ No updates found. The app is up to date.");
        return {
          code: 200,
          message: "No updates found. The app is up to date.",
        };
      }
    } catch (error) {
      logger.error(`❌ Error checking for updates: ${error}`);
      return { code: 500, message: `Error checking for updates: ${error}` };
    }
  }

  static updateSystem(): Promise<{ code: number; message: string }> {
    logger.info("Starting system update...");

    return new Promise((resolve) => {
      exec(
        "sudo apt update && sudo apt upgrade -y",
        (error, stdout, stderr) => {
          if (error) {
            logger.error(`❌ Error updating system: ${error.message}`);
            return resolve({
              code: 500,
              message: `Error updating system: ${error.message}`,
            });
          }
          if (stderr) {
            logger.error(`⚠️ Warnings: ${stderr}`);
          }
          logger.info(`✅ System update completed:\n${stdout}`);
          resolve({ code: 200, message: "✅ Update completed" });
        },
      );
    });
  }

  static isLikelyMic(device: usb.Device): boolean {
    const deviceDescriptor = device.deviceDescriptor;
    return (
      deviceDescriptor.bDeviceClass === 0 || // will get the devie model number or vendor to get accurate mic tracking
      deviceDescriptor.bDeviceSubClass === 0
    );
  }

  static async refreshUsbPorts() {
    try {
      isRefreshingUsbPorts = true;
      logger.warn("🧼 Attempting to refresh USB ports...");
      // Trigger USB subsystem remove events
      await execPromise(
        "sudo udevadm trigger --subsystem-match=usb --action=remove",
      );
      // Wait a bit before re-adding devices
      await new Promise((res) => setTimeout(res, 2000));
      // Trigger USB subsystem add events
      await execPromise(
        "sudo udevadm trigger --subsystem-match=usb --action=add",
      );

      logger.info("🔁 USB ports refreshed via udevadm");
      isRefreshingUsbPorts = false;
      this.checkMicAvailable("secondAttempt");
    } catch (error) {
      isRefreshingUsbPorts = false;
      logger.error("❌ Failed to refresh USB ports:", error);
    }
  }

  static async checkMicAvailable(attempt: "firstAttempt" | "secondAttempt") {
    try {
      const { isActive, timeStamp, buffer } = isCheckingSystemMic;

      const capturedTimestamp = timeStamp;
      const now = Date.now();

      if (
        (isActive || now - timeStamp < buffer) &&
        attempt !== "secondAttempt"
      ) {
        return;
      }

      isCheckingSystemMic.isActive = true;
      isCheckingSystemMic.timeStamp = now;

      const { stdout, stderr } = await execPromise("arecord -l");
      if (stderr || !stdout.includes("card")) {
        //Skipping either refresh usb ports or reboot device on hardware issue.
        const isHardwareIssue = await this.checkUSBMicDevice();
        if (isHardwareIssue) return;

        if (attempt === "firstAttempt") {
          logger.error("❌ Mic unusable by system (arecord)");
          await this.refreshUsbPorts();
        }
        if (attempt === "secondAttempt") {
          logger.error("❌ Mic still not available after USB refresh.");

          const uptimeInSeconds = os.uptime();

          stopRecording();
          cancelNextRestart();

          if (uptimeInSeconds / 60 < 60) {
            logger.warn(
              `⚠️ Recently rebooted device since ${uptimeInSeconds / 60} minute(s), skipping another reboot.`,
            );
            return;
          }

          await NotificationSevrice.sendHeartBeatToServer(
            NotificationEvent.DEVICE_SYSTEM_MIC_OFF,
          );

          logger.warn("⚠️ Rebooting device...");
          await execPromise("sudo reboot");
        }
      } else {
        if (attempt === "firstAttempt") {
          if (capturedTimestamp === 0) {
            logger.info("✅ Mic available via arecord");
          }
        }
        if (attempt === "secondAttempt") {
          logger.info("✅ Mic became available after USB refresh.");
          restartRecording();
        }
      }
      isCheckingSystemMic.isActive = false;
    } catch (error) {
      isCheckingSystemMic.isActive = false;
      logger.error("❌ Error checking mic availability:", error);
    }
  }

  static realTimeUsbEventDetection() {
    // 🔌 When a device is plugged in
    usb.on("attach", (device) => {
      if (isRefreshingUsbPorts) return;
      if (this.isLikelyMic(device)) {
        logger.info("🔌 USB mic attached:", device.deviceDescriptor);
        if (!recordingSession) {
          logger.info("USB Mic Plugged!, starting recording...");
          startRecording();
          scheduleNextRestart();
        }
      }
    });

    // 🔌 When a device is removed
    usb.on("detach", (device) => {
      if (isRefreshingUsbPorts) return;
      if (this.isLikelyMic(device)) {
        logger.error("❌ USB mic detached:", device);
        this.checkUSBMicDevice();
      }
    });
  }

  static async checkUSBMicDevice() {
    const { isActive, timeStamp, buffer } = isCheckingUSBMic;
    const now = Date.now();

    const micFound = this.listCurrentUSBDevices();

    if (micFound?.length === 0) {
      if (isActive || now - timeStamp < buffer) {
        return true;
      }
      isCheckingUSBMic.isActive = true;
      isCheckingUSBMic.timeStamp = now;

      logger.warn("No USB mic is connected, stopping recording...");

      stopRecording();
      cancelNextRestart();

      await NotificationSevrice.sendHeartBeatToServer(
        NotificationEvent.DEVICE_HARDWARE_MIC_OFF,
      );
      isCheckingUSBMic.isActive = false;
      return true;
    }
    return false;
  }

  static listCurrentUSBDevices() {
    const devices = getDeviceList();
    console.log("list devices", devices);
    const micDevices = devices.filter(this.isLikelyMic);
    console.log("list mic devices", devices);
    if (micDevices.length > 0) {
      logger.info("🔍 Mic(s) already connected");
    } else {
      logger.info("🔍 No USB mic found initially");
    }
    return micDevices;
  }
}
