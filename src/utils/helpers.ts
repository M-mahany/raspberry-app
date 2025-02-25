import path from "path";

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
