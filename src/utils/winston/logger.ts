import winston from "winston";
import path from "path";
import dayjs from "dayjs";

// Define log file paths
export const logsDir = "./logs";

const logger = winston.createLogger({
  level: "info", // Default log level
  format: winston.format.combine(
    winston.format.timestamp({
      format: () => dayjs().format("YYYY-MM-DD HH:mm:ss"), // Local time format
    }),
    winston.format.printf(({ timestamp, level, message }) => {
      return `${timestamp} [${level.toUpperCase()}]: ${message}`;
    }),
  ),
  transports: [
    new winston.transports.Console(), // Log to console
    new winston.transports.File({ filename: path.join(logsDir, "app.log") }), // Log to file
  ],
});

export default logger;
