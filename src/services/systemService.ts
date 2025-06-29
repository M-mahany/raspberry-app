import os from "os";
import osu from "os-utils";
import si from "systeminformation";
import dotenv from "dotenv";
import simpleGit from "simple-git";
import { exec, spawn } from "child_process";
import logger from "../utils/winston/logger";
import util from "util";
import { NotificationEvent, NotificationService } from "./notificationService";
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
import { RecordingService } from "./recordingsService";
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
const CPU_THRESHOLD = 70;

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
        await NotificationService.sendHeartBeatToServer(
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

  static async getDefaultMicDevice() {
    try {
      const { stdout } = await execPromise("arecord -l");
      const lines = stdout.split("\n");

      for (const line of lines) {
        const match = line.match(/card (\d+): .*device (\d+):/i);
        if (match) {
          const card = match[1];
          const device = match[2];
          return `plughw:${card},${device}`;
        }
      }
      return null; // No mic found
    } catch (err) {
      logger.error("Failed to get audio devices:", err);
      return null;
    }
  }

  static async checkMicOnStart(isMicActive: boolean) {
    try {
      if (isMicActive) return;
      const isMicDetected = await this.isMicDetected();
      if (isMicDetected) {
        logger.info("✅ Mic available via arecord");
        const isMicAvailable = await this.isMicAvailable();
        if (isMicAvailable) {
          NotificationService.sendHeartBeatToServer(
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
        const isMicConnected = await this.isUsbAudioDeviceConnected();

        if (attempt === "firstAttempt") {
          logger.error("❌ Mic undetected by the system (arecord)");
          if (isMicConnected) {
            await NotificationService.sendHeartBeatToServer(
              NotificationEvent.DEVICE_SYSTEM_MIC_OFF,
            );
          } else {
            await NotificationService.sendHeartBeatToServer(
              NotificationEvent.DEVICE_HARDWARE_MIC_OFF,
            );
          }

          await this.cycleAllUsbPorts();
          this.handleMicInterruption("secondAttempt");
        }

        if (attempt === "secondAttempt") {
          logger.error("❌ Mic still not available after USB Power Cycle.");

          stopRecording();
          cancelNextRestart();

          if (!isMicConnected) return;

          const uptimeInSeconds = os.uptime();

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

            await NotificationService.sendHeartBeatToServer(
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
      logger.info(
        "🎙️ Checking if microphone is detected and accessible using arecord...",
      );
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
    await RecordingService.killExistingRecordings();

    await waitForMs(1000);

    const micDevice = await this.getDefaultMicDevice();

    return new Promise((resolve) => {
      logger.info("🎙️ Checking mic availability...");

      const arecord = spawn("arecord", [
        "-c",
        "1",
        "-r",
        "16000",
        "-f",
        "S16_LE",
        "-t",
        "raw",
        "-D",
        micDevice || "plughw:1,0",
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

        logger.info("✅ Mic is available and responsive.");
        resolve(true);
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
      logger.info("✅ uhubctl is already installed.");
    } catch {
      logger.warn("⚠️ uhubctl not found. Installing from source...");

      try {
        await execPromise("sudo apt update");
        await execPromise(
          "sudo apt install -y git build-essential libusb-1.0-0-dev",
        );
        await execPromise("rm -rf /tmp/uhubctl");
        await execPromise(
          "git clone https://github.com/mvp/uhubctl /tmp/uhubctl",
        );
        await execPromise("make -C /tmp/uhubctl");
        await execPromise("sudo make install -C /tmp/uhubctl");

        logger.info("✅ uhubctl installed successfully.");
      } catch (installErr) {
        logger.error("❌ Failed to install uhubctl:", installErr);
        return;
      }
    }

    try {
      lastCycleTime = Date.now();
      logger.info("🔌 Power cycling USB ports on hubs 2 and 4...");

      await execPromise("sudo uhubctl -l 2 -a 0");
      await execPromise("sudo uhubctl -l 4 -a 0");

      await waitForMs(3000); // Required delay for full power off

      await execPromise("sudo uhubctl -l 2 -a 1");
      await execPromise("sudo uhubctl -l 4 -a 1");

      await waitForMs(3000);

      logger.info("✅ USB ports cycled successfully.");
    } catch (cycleErr) {
      logger.error("❌ Failed to cycle USB ports:", cycleErr);
    }
  }

  static async realTimeUsbEventDetection() {
    usb.on("attach", async () => {
      logger.info("🔌 USB device attached");

      // 1. Filter out events within 10 seconds of a power cycle
      const suppressWindowMs = 10000;
      const now = Date.now();
      if (lastCycleTime && now - lastCycleTime < suppressWindowMs) {
        logger.info(
          `⚠️ USB attach ignored due to recent power cycle (${now - lastCycleTime}ms ago)`,
        );
        return;
      }

      if (isCheckingSystemMic.isActive) {
        logger.info(
          `⚠️ USB attach ignored: handled by the central interrupt management function.`,
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
