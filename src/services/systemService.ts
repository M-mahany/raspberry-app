import os from "os";
import osu from "os-utils";
import si from "systeminformation";

interface SystemUsage {
  cpuUsage: string;
  memoryUsage: string;
  totalMemory: string;
}

export class SystemService {
  static async getSystemHealth() {
    try {
      const { cpuUsage, memoryUsage, totalMemory } =
        await this.getSystemUsage();
      const { totalDisk, usedSpace, avaiableSpace, diskUsage } =
        await this.getDiskInfo();
      return {
        uptime: `${(os.uptime() / 3600).toFixed(2)} hours`,
        cpuUsage,
        cpuCount: os.cpus().length,
        memoryUsage,
        totalMemory,
        totalDisk,
        usedSpace,
        avaiableSpace,
        diskUsage,
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
          totalMemory: `${(os.totalmem() / 1024 ** 3).toFixed(2)}GB`,
        });
      });
    });
  }
  static async getDiskInfo() {
    try {
      const diskInfo = await si.fsSize();
      const disk = diskInfo[0];
      return {
        totalDisk: `${(disk.size / 1024 ** 3).toFixed(2)} GB`,
        usedSpace: `${(disk.used / 1024 ** 3).toFixed(2)} GB`,
        avaiableSpace: `${(disk.available / 1024 ** 3).toFixed(2)} GB`,
        diskUsage: `${disk.use}%`,
      };
    } catch (error) {
      throw new Error(`Error retriving disk info ${error}`);
    }
  }
}
