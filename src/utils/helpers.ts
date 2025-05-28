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
  limit: number,
) => {
  const logEntries = logs
    .split("\n")
    .filter((line) => line.trim() !== "")
    .reverse()
    .map((line) => {
      const match = line.match(
        /(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}.\d{3}Z) \[(\w+)\]: (.*)/,
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
