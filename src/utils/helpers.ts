import dayjs from "dayjs";
import path from "path";
import utc from "dayjs/plugin/utc";
import timezone from "dayjs/plugin/timezone";

dayjs.extend(utc);
dayjs.extend(timezone);

export const getFileName = (filePath: string) => {
  return path.basename(filePath);
};

export const convertLogsToJson = (logs: string) => {
  const logEntries = logs
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => {
      const match = line.match(
        /(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}.\d{3}Z) \[(\w+)\]: (.*)/,
      );
      if (match) {
        return { timestamp: match[1], level: match[2], message: match[3] };
      }
      return { raw: line };
    });

  return logEntries;
};

export const getTimeZone = () => {
  return dayjs.tz.guess();
};
