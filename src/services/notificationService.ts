import dayjs from "dayjs";
import { serverAPI } from "../utils/config/voiceApiConfig";
import logger from "../utils/winston/logger";
import { isOnline } from "../utils/socket/socketClient";
import { waitForMs } from "../utils/helpers";

interface lastActivity {
  DEVICE_SYSTEM_MIC_OFF: null | number;
  DEVICE_SYSTEM_MIC_ON: null | number;
  DEVICE_HARDWARE_MIC_OFF: null | number;
  DEVICE_HARDWARE_MIC_ON: null | number;
  DEVICE_CPU_ALARM: null | number;
}

export enum NotificationEvent {
  DEVICE_SYSTEM_MIC_OFF = "DEVICE_SYSTEM_MIC_OFF",
  DEVICE_SYSTEM_MIC_ON = "DEVICE_SYSTEM_MIC_ON",
  DEVICE_HARDWARE_MIC_OFF = "DEVICE_HARDWARE_MIC_OFF",
  DEVICE_CPU_ALARM = "DEVICE_CPU_ALARM",
  DEVICE_HARDWARE_MIC_ON = "DEVICE_HARDWARE_MIC_ON",
}

let lastActivity = <lastActivity>{
  DEVICE_SYSTEM_MIC_OFF: null,
  DEVICE_SYSTEM_MIC_ON: null,
  DEVICE_HARDWARE_MIC_OFF: null,
  DEVICE_HARDWARE_MIC_ON: null,
  DEVICE_CPU_ALARM: null,
};

interface METADATA {
  key: string;
  value: string | number;
}

interface APIBODY {
  event: NotificationEvent;
  meta_data?: METADATA[];
}

let retryQueue: APIBODY[] = [];

const addToRetryQueue = async (body: APIBODY) => {
  const isMicEvent = (event: NotificationEvent) =>
    event.includes("MIC_ON") || event.includes("MIC_OFF");

  const isMicOff =
    body.event === NotificationEvent.DEVICE_HARDWARE_MIC_OFF ||
    body.event === NotificationEvent.DEVICE_SYSTEM_MIC_OFF;

  if (isMicOff) {
    retryQueue = retryQueue.filter((queueBody) => !isMicEvent(queueBody.event));
  } else {
    retryQueue = retryQueue.filter(
      (queueBody) => queueBody.event !== body.event,
    );
  }

  retryQueue.push(body);
};

export const flushQueueLoop = async () => {
  while (true) {
    if (!isOnline || retryQueue.length === 0) {
      await waitForMs(5000);
      continue;
    }

    const body = retryQueue.shift()!;

    try {
      await serverAPI.post("/notification/device", body);
      logger.info(`✅ Flushed event: ${body.event}`);
    } catch (error: any) {
      logger.error(`Retry failed: ${error?.message || error}`);
      retryQueue.unshift(body);
      await waitForMs(2000);
    }
  }
};

export class NotificationService {
  static async sendHeartBeatToServer(
    event: NotificationEvent,
    meta_data?: METADATA[],
  ) {
    const lastActivityDate = lastActivity[event];

    const now = Date.now();

    const lastActivityDuration = dayjs(now).diff(
      lastActivityDate ?? now,
      "second",
    );
    const bufferDuration =
      event === NotificationEvent.DEVICE_CPU_ALARM ? 3600 : 10;

    if (lastActivityDate && lastActivityDuration < bufferDuration) {
      logger.info(
        `Skipping sending notification! notified server about "${event}" ${lastActivityDuration} seconds(s) ago `,
      );
      return;
    }
    logger.info(`Sending notification! notifying server about ${event}`);

    lastActivity[event] = Date.now();
    let apiBody: APIBODY = {
      event,
    };
    try {
      if (meta_data) {
        apiBody.meta_data = meta_data;
      }
      await serverAPI.post("/notification/device", apiBody);
    } catch (error: any) {
      logger.error(`Error Sending HeartBeat ${error?.message || error}`);
      addToRetryQueue(apiBody);
    }
  }
}
