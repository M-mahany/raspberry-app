import dayjs from "dayjs";
import { serverAPI } from "../utils/config/voiceApiConfig";
import logger from "../utils/winston/logger";

interface lastActivity {
  DEVICE_SYSTEM_MIC_OFF: null | number;
  DEVICE_HARDWARE_MIC_OFF: null | number;
  DEVICE_CPU_ALARM: null | number;
}

export enum NotificationEvent {
  DEVICE_SYSTEM_MIC_OFF = "DEVICE_SYSTEM_MIC_OFF",
  DEVICE_HARDWARE_MIC_OFF = "DEVICE_HARDWARE_MIC_OFF",
  DEVICE_CPU_ALARM = "DEVICE_CPU_ALARM",
}

let lastActivity = <lastActivity>{
  DEVICE_SYSTEM_MIC_OFF: null,
  DEVICE_HARDWARE_MIC_OFF: null,
  DEVICE_CPU_ALARM: null,
};

interface MetaDATA {
  key: string;
  value: string | number;
}

export class NotificationSevrice {
  static async sendHeartBeatToServer(
    event: NotificationEvent,
    meta_data?: MetaDATA,
  ) {
    const lastActivityDate = lastActivity[event];

    const now = Date.now();

    const lastActivityDuration = dayjs(now).diff(
      lastActivityDate ?? now,
      "hour",
    );

    if (lastActivityDate && lastActivityDuration < 2) {
      logger.info(
        `Skipping sending notification! notified user about "${event}" ${lastActivityDuration} seconds ago `,
      );
      return;
    }
    logger.info(`Sending notification! notifying admins about ${event}`);

    lastActivity[event] = Date.now();
    try {
      let apiBody = {
        event,
        meta_data: [] as MetaDATA[],
      };

      if (meta_data) {
        apiBody.meta_data.push(meta_data);
      }

      await serverAPI.post("/notification/device", apiBody);
    } catch (error: any) {
      logger.error(`Error Sending HeartBeat ${error?.message || error}`);
    }
  }
}
