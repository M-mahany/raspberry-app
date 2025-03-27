import os from "os";
import osu from "os-utils";
import si from "systeminformation";
import dotenv from "dotenv";
import simpleGit from "simple-git";
import { exec } from "child_process";
import logger from "../utils/winston/logger";
import util from "util";

const git = simpleGit();
const execPromise = util.promisify(exec);

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
        const changedFiles = await git.diffSummary(["HEAD~1"]);
        const needsNpmInstall = changedFiles.files.some((file) =>
          file.file.includes("package.json"),
        );

        if (needsNpmInstall) {
          logger.info("📦 Installing dependencies...");
          try {
            const { stdout } = await execPromise("npm install");
            logger.info(`✅ Dependencies updated:\n${stdout}`);
          } catch (err) {
            logger.error(`❌ Failed to install dependencies: ${err}`);
            return { code: 500, message: "Failed to install dependencies" };
          }
        }

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
}
