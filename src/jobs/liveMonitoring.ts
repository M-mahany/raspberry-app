import EventEmitter from "events";
import { SystemService } from "../services/systemService";

interface SystemHealthData {
  uptime: string;
  cpuUsage: string;
  cpuCount: number;
  memoryUsage: string;
  totalMemory: string;
  usedMemory: string;
  totalSpace: string;
  usedSpace: string;
  avaiableSpace: string;
  diskUsage: string;
  cpuTemp: string;
  gpuTemp: string;
}

class SystemMonitor extends EventEmitter {
  private interval: number;
  private timer?: NodeJS.Timeout;

  constructor(interval: number = 2000) {
    super();
    this.interval = interval;
  }

  startMonitoring(): void {
    this.fetchAndEmit();
    this.timer = setInterval(() => this.fetchAndEmit(), this.interval);
  }

  private async fetchAndEmit(): Promise<void> {
    try {
      const healthData: SystemHealthData =
        await SystemService.getSystemHealth();
      this.emit("update", healthData);
    } catch (error) {
      console.error("System monitoring error:", error);
    }
  }

  stopMonitoring(): void {
    if (this.timer) {
      clearInterval(this.timer);
    }
  }
}

// Usage
const systemMonitor = new SystemMonitor();
systemMonitor.startMonitoring();

systemMonitor.on("update", (data: SystemHealthData) => {
  console.clear(); // Optional: Clears the console for real-time effect
  console.log("🔄 Live System Health:", data);
});
