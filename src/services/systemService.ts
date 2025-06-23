import os from "os";
import osu from "os-utils";
import si from "systeminformation";
import dotenv from "dotenv";
import simpleGit from "simple-git";
import { exec, spawn } from "child_process";
import logger from "../utils/winston/logger";
import util from "util";
import { NotificationEvent, NotificationSevrice } from "./notificationService";
import {
  cancelNextRestart,
  isMicActive,
  restartRecording,
  scheduleNextRestart,
  startMicHealthCheckInterval,
  stopRecording,
} from "../jobs/audioRecording";
import dayjs from "dayjs";
import { usb } from "usb";
import { waitForMs } from "../utils/helpers";
import path from "path";
import { existsSync } from "fs";
import { unlink } from "fs/promises";

const git = simpleGit();
const execPromise = util.promisify(exec);

dotenv.config();

interface SystemUsage {
  cpuUsage: string;
  memoryUsage: string;
  totalMemory: string;
  usedMemory: string;
}

let isCheckingSystemMic = {
  timeStamp: 0,
  isActive: false,
  buffer: 15000,
};

let cpuReportedAT: number | null = null;
const CPU_THRESHOLD = 30;

let lastCycleTime: number | null = null;

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
      const now = Date.now();

      const shouldCheckAndNotify =
        !cpuReportedAT || dayjs(now).diff(cpuReportedAT, "minute") > 60;

      if (!shouldCheckAndNotify) return;

      const cpuUsagePercentage: number = await new Promise((resolve) => {
        osu.cpuUsage((usage) => {
          resolve(usage * 100 || 0);
        });
      });

      if (cpuUsagePercentage > CPU_THRESHOLD) {
        await NotificationSevrice.sendHeartBeatToServer(
          NotificationEvent.DEVICE_CPU_ALARM,
          [
            {
              key: "cpuUsage",
              value: cpuUsagePercentage,
            },
            {
              key: "threshold",
              value: CPU_THRESHOLD,
            },
          ],
        );
        cpuReportedAT = now;
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

  static async checkMicOnStart(isMicActive: boolean) {
    try {
      logger.info(`cheking mic health on start isMicActive:${isMicActive}`);
      if (isMicActive) return;
      const isMicDetected = await this.isMicDetected();
      logger.info(`cheking mic health on start isMicDetected:${isMicDetected}`);

      if (isMicDetected) {
        const isMicAvailable = await this.isMicAvailable();
        if (isMicAvailable) {
          NotificationSevrice.sendHeartBeatToServer(
            NotificationEvent.DEVICE_SYSTEM_MIC_ON,
          );
        }
      }
    } catch (err) {
      logger.error("Error Checking Mic onStart");
    }
  }

  static async handleMicInterruption(
    attempt: "firstAttempt" | "secondAttempt",
  ) {
    try {
      const { isActive, timeStamp, buffer } = isCheckingSystemMic;

      const now = Date.now();

      if (
        (isActive || now - timeStamp < buffer) &&
        attempt === "firstAttempt"
      ) {
        return;
      }

      isCheckingSystemMic.isActive = true;
      isCheckingSystemMic.timeStamp = now;

      const isMicDetected = await this.isMicDetected();

      if (!isMicDetected) {
        if (attempt === "firstAttempt") {
          logger.error("❌ Mic undetected by the system (arecord)");
          await this.cycleAllUsbPorts();
          this.handleMicInterruption("secondAttempt");
        }

        if (attempt === "secondAttempt") {
          logger.error("❌ Mic still not available after USB Power Cycle.");

          const uptimeInSeconds = os.uptime();

          stopRecording();
          cancelNextRestart();

          const isMicConnected = await this.isUsbAudioDeviceConnected();

          if (isMicConnected) {
            await NotificationSevrice.sendHeartBeatToServer(
              NotificationEvent.DEVICE_SYSTEM_MIC_OFF,
            );
          } else {
            await NotificationSevrice.sendHeartBeatToServer(
              NotificationEvent.DEVICE_HARDWARE_MIC_OFF,
            );
            return;
          }

          if (uptimeInSeconds / 60 < 60) {
            logger.warn(
              `⚠️ Device recently booted (${Math.floor(uptimeInSeconds / 60)} minute(s) ago). Skipping reboot.`,
            );
            return;
          }

          logger.warn("⚠️ Rebooting device in 3(seconds)...");

          // wait 3 seconds before rebooting
          await waitForMs(3000);

          await execPromise("sudo reboot");
        }
      } else {
        if (attempt === "firstAttempt") {
          logger.info("✅ Mic available via arecord");
          const isMicAvailable = await this.isMicAvailable();

          if (!isMicAvailable) {
            stopRecording();
            cancelNextRestart();
            startMicHealthCheckInterval();

            await NotificationSevrice.sendHeartBeatToServer(
              NotificationEvent.DEVICE_SYSTEM_MIC_OFF,
            );
            return;
          }
        }
        if (attempt === "secondAttempt") {
          logger.info("✅ Mic became available after USB refresh");
        }
        restartRecording();
        scheduleNextRestart();
      }
      isCheckingSystemMic.isActive = false;
    } catch (error: any) {
      isCheckingSystemMic.isActive = false;
      logger.error(
        `❌ Error handling interrupted mic Error: ${error?.message || error}`,
      );
    } finally {
      isCheckingSystemMic.isActive = false;
    }
  }

  static async isMicDetected() {
    try {
      // if (platform === "win32") {
      //   command = `powershell -Command "Get-PnpDevice -Class 'AudioEndpoint' | Where-Object { $_.FriendlyName -like '*Microphone*' } | Select-Object -ExpandProperty FriendlyName"`;
      // }

      const { stdout, stderr } = await execPromise("arecord -l");

      if (stderr || !stdout.includes("card")) {
        return false;
      }
      return true;
    } catch (err: any) {
      logger.error(
        `Error checking USB devices availabilty using "arecord" Error: ${err?.message || err}`,
      );
      return false;
    }
  }

  static async isMicAvailable(): Promise<boolean> {
    const filePath = path.join(os.tmpdir(), "temp_mic_check.wav");

    return new Promise((resolve) => {
      logger.info("🎙️ Checking mic availability...");

      const arecord = spawn("arecord", [
        "-D",
        "default",
        "-c",
        "1",
        "-r",
        "16000",
        "-f",
        "S16_LE",
        filePath,
        "--duration=1",
      ]);

      arecord.on("error", (err) => {
        logger.error("❌ Mic check process error:", err);
        resolve(false);
      });

      arecord.on("close", async (code) => {
        if (code !== 0) {
          logger.error(`❌ arecord exited with code ${code}`);
          return resolve(false);
        }

        await waitForMs(1100);

        try {
          if (existsSync(filePath)) {
            await unlink(filePath);
          }
          logger.info("✅ Mic is available and responsive.");
          resolve(true);
        } catch (err) {
          logger.error("❌ Failed to clean up mic test file:", err);
          resolve(false);
        }
      });
    });
  }

  // is USB mic device connected and avaiable
  static async isUsbAudioDeviceConnected(): Promise<boolean> {
    try {
      const { stdout } = await execPromise("lsusb");
      const deviceIds = stdout
        .split("\n")
        .map((line) => {
          const match = line.match(/ID\s+([0-9a-f]{4}):([0-9a-f]{4})/i);
          return match ? `${match[1]}:${match[2]}` : null;
        })
        .filter(Boolean);

      for (const id of deviceIds) {
        try {
          const { stdout: desc } = await execPromise(`lsusb -v -d ${id}`);
          if (desc.includes("bInterfaceClass") && desc.includes("Audio")) {
            logger.info("🎤 USB Audio Device Detected:", id);
            return true;
          }
        } catch (err: any) {
          logger.error(
            `Error Checking getting device usb bInterfaceClass Error:${err?.message || err}`,
          );
          return false;
        }
      }

      return false;
    } catch (err: any) {
      logger.error(
        `Error checking USB devices connectivity using "lsusb" Error: ${err.message || err}`,
      );
      return false;
    }
  }

  // power cycle raspberry pi usb ports (hard reset)
  static async cycleAllUsbPorts() {
    try {
      logger.info("🔍 Checking for uhubctl...");

      await execPromise("which uhubctl");

      logger.info("✅ uhubctl is installed.");
    } catch {
      logger.warn("⚠️ uhubctl not found. Installing...");

      try {
        await execPromise("sudo apt update && sudo apt install -y uhubctl");
        logger.info("✅ uhubctl installed successfully.");
      } catch (installErr) {
        logger.error("❌ Failed to install uhubctl:", installErr);
        return;
      }
    }

    try {
      lastCycleTime = Date.now();
      logger.info("🔌 Power cycling all USB ports using uhubctl...");
      const { stdout } = await execPromise("sudo uhubctl -a cycle -p all");
      logger.info("✅ USB ports cycled successfully:\n", stdout);
    } catch (cycleErr) {
      logger.error("❌ Failed to cycle USB ports:", cycleErr);
    }
  }

  static async realTimeUsbEventDetection() {
    usb.on("attach", async () => {
      logger.info("🔌 USB device attached");

      // 1. Filter out events within 3.5 seconds of a power cycle
      const suppressWindowMs = 3500;
      const now = Date.now();
      if (lastCycleTime && now - lastCycleTime < suppressWindowMs) {
        logger.info(
          `⚠️ USB attach ignored due to recent power cycle (${now - lastCycleTime}ms ago)`,
        );
        return;
      }

      // 2. Avoid triggering restart if already active
      if (isMicActive) {
        logger.info("ℹ️ Mic is already active. No action needed.");
        return;
      }

      // 4. Safe to restart
      const isMicDetected = await this.isMicDetected();
      if (isMicDetected) {
        logger.info("✅ Mic detected and restarting recording...");
        restartRecording();
        scheduleNextRestart();
      }
    });
  }
}
