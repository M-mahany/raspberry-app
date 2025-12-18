import dayjs from "dayjs";
import path from "path";
import utc from "dayjs/plugin/utc";
import timezone from "dayjs/plugin/timezone";

dayjs.extend(utc);
dayjs.extend(timezone);

export const getFileName = (filePath: string) => {
  return path.basename(filePath);
};

export const convertLogsToJson = (
  logs: string,
  page: number,
  limit: number
) => {
  const logEntries = logs
    .split("\n")
    .filter((line) => line.trim() !== "")
    .reverse()
    .map((line) => {
      const match = line.match(
        /(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}.\d{3}Z) \[(\w+)\]: (.*)/
      );
      if (match) {
        return { timestamp: match[1], level: match[2], message: match[3] };
      }
      return { raw: line };
    });

  const totalLogs = logEntries?.length ?? 0;
  const startIndex = (page - 1) * limit;
  const paginatedLogs = logEntries.slice(startIndex, startIndex + limit);

  return { logs: paginatedLogs, total: totalLogs, page, limit };
};

export const getFileDuration = (fileName: string) => {
  const fileTimestamp = Number(fileName.split(".")[0]);
  const fileDuration = dayjs(Date.now()).diff(fileTimestamp, "second");
  return fileDuration;
};

export const getTimeZone = () => {
  return dayjs.tz.guess();
};

export const waitForMs = (ms: number) =>
  new Promise((resolve) => setTimeout(resolve, ms));

export function formatTime(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const remainingSecondsAfterHours = seconds % 3600;
  const minutes = Math.floor(remainingSecondsAfterHours / 60);
  const remainingSeconds = remainingSecondsAfterHours % 60;

  // Format the time as HH:MM:SS
  return `${hours.toString().padStart(2, "0")}:${minutes
    .toString()
    .padStart(2, "0")}:${Math.floor(remainingSeconds)
    .toString()
    .padStart(2, "0")}`;
}

export function formatDOASegments(
  segments: Array<{
    start: number;
    end: number;
    channel: number;
    angle: number;
    accuracy?: number; // Optional for backward compatibility
  }>
): string {
  if (!segments || segments.length === 0) {
    return "No segments";
  }

  return segments
    .map((seg, index) => {
      const startSeconds = seg.start / 1000;
      const endSeconds = seg.end / 1000;
      const duration = (seg.end - seg.start) / 1000;
      const accuracyStr =
        seg.accuracy !== undefined ? ` | Accuracy: ${seg.accuracy.toFixed(1)}%` : "";

      return `${index + 1}. Channel ${seg.channel} | ${formatTime(startSeconds)} - ${formatTime(endSeconds)} (${duration.toFixed(1)}s) | DOA: ${seg.angle}°${accuracyStr}`;
    })
    .join("\n");
}
