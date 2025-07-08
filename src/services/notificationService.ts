import dayjs from "dayjs";
import { serverAPI } from "../utils/config/voiceApiConfig";
import logger from "../utils/winston/logger";
import { isOnline } from "../utils/socket/socketClient";
import { waitForMs } from "../utils/helpers";

interface LastActivity {
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

let lastActivity = <LastActivity>{
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

const deviceMicStates = new Map<
  string,
  { isSent: boolean; timeout: NodeJS.Timeout | undefined }
>();

const MIC_EVENT_ALERT_DELAY_MS = 5 * 60 * 1000;

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

let flushing = false;

export const flushQueueLoop = async () => {
  if (flushing) return;
  flushing = true;

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
      event === NotificationEvent.DEVICE_CPU_ALARM ? 3600 : 0; // Buffer 1 hour for CPU otherwise no buffer

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

      // MIC_OFF handling
      if (event.includes("MIC_OFF")) {
        const micState = deviceMicStates.get("MIC_OFF") || {
          isSent: false,
          timeout: undefined,
        };

        if (micState.timeout) {
          logger.info("MIC_OFF event already pending. Skipping new timer.");
          return;
        }

        micState.timeout = setTimeout(async () => {
          try {
            await serverAPI.post("/notification/device", apiBody);
            micState.isSent = true;
            logger.info("✅ MIC_OFF notification sent after delay.");
          } catch (error: any) {
            logger.error(`❌ Failed to send MIC_OFF: ${error.message}`);
            addToRetryQueue(apiBody);
          } finally {
            micState.timeout = undefined;
            deviceMicStates.set("MIC_OFF", micState);
          }
        }, MIC_EVENT_ALERT_DELAY_MS);

        micState.isSent = false;
        deviceMicStates.set("MIC_OFF", micState);
        return;
      }

      // MIC_ON handling
      if (event.includes("MIC_ON")) {
        const micState = deviceMicStates.get("MIC_OFF");

        if (micState?.timeout) {
          clearTimeout(micState.timeout);
          micState.timeout = undefined;
        }

        if (!micState?.isSent) {
          logger.info("Skipping MIC_ON: no prior MIC_OFF alert was sent.");
          return;
        }

        micState.isSent = false;
        deviceMicStates.set("MIC_OFF", micState);
      }

      await serverAPI.post("/notification/device", apiBody);
    } catch (error: any) {
      logger.error(`Error Sending HeartBeat ${error?.message || error}`);
      addToRetryQueue(apiBody);
    }
  }
}
