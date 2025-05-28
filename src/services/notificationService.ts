import dayjs from "dayjs";
import { serverAPI } from "../utils/config/voiceApiConfig";
import logger from "../utils/winston/logger";

interface lastActivity {
  DEVICE_SYSTEM_MIC_OFF: null | number;
  DEVICE_HARDWARE_MIC_OFF: null | number;
}

export enum NotificationEvent {
  DEVICE_SYSTEM_MIC_OFF = "DEVICE_SYSTEM_MIC_OFF",
  DEVICE_HARDWARE_MIC_OFF = "DEVICE_HARDWARE_MIC_OFF",
}

let lastActivity = <lastActivity>{
  DEVICE_SYSTEM_MIC_OFF: null,
  DEVICE_HARDWARE_MIC_OFF: null,
};

export class NotificationSevrice {
  static async sendHeartBeatToServer(event: NotificationEvent) {
    const lastActivityDate = lastActivity[event];

    const lastActivityDuration = dayjs(Date.now()).diff(
      lastActivityDate,
      "second",
    );

    if (lastActivityDate && lastActivityDuration <= 90) {
      logger.info(
        `Skipping sending notification! notified user about "${event}" ${lastActivityDuration} seconds ago `,
      );
      return;
    }
    logger.info(`Sending notification! notifying admins about ${event}`);

    lastActivity[event] = Date.now();
    try {
      await serverAPI.post("/notification/device", {
        event,
      });
    } catch (error: any) {
      logger.error(`Error Sending HeartBeat ${error?.message || error}`);
    }
  }
}
