import os from "os";
import osu from "os-utils";
import si from "systeminformation";
import dotenv from "dotenv";
import simpleGit from "simple-git";
import { exec } from "child_process";
import logger from "../utils/winston/logger";

const git = simpleGit();

dotenv.config();

interface SystemUsage {
  cpuUsage: string;
  memoryUsage: string;
  totalMemory: string;
  usedMemory: string;
}

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
      const gpuTemp = await si.graphics();

      return {
        cpuTemp: `${cpuTemp.main || "N/A"}°C`,
        gpuTemp: `${gpuTemp?.controllers[0]?.temperatureGpu || "N/A"}°C`,
      };
    } catch (error) {
      throw new Error("Error retrieiving CPU & GPU temperature");
    }
  }

  // Function to check and update the app from Github
  static async checkForUpdates() {
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
        const changedFiles = await git.diffSummary(["HEAD~1"]);
        const needsNpmInstall = changedFiles.files.some((file) =>
          file.file.includes("package.json"),
        );

        if (needsNpmInstall) {
          logger.info("📦 Installing dependencies...");
          exec("npm install", (err, stdout, stderr) => {
            if (err) {
              logger.error("❌ Failed to install dependencies:", stderr);
              return;
            }
            logger.info("✅ Dependencies updated:", stdout);
          });
        }

        // Restart the app using PM2
        logger.info("♻️ Restarting the app...");
        exec("pm2 restart ai-voice-app", (err, stdout, stderr) => {
          if (err) {
            logger.error("❌ Failed to restart app:", stderr);
            return;
          }
          logger.info("✅ App restarted successfully:", stdout);
        });
      } else {
        logger.info("✅ No updates found. The app is up to date.");
      }
    } catch (error) {
      logger.error("❌ Error checking for updates:", error);
    }
  }
}
