import winston from "winston";
import path from "path";

// Define log file paths
export const logsDir = path.join(__dirname, "../../logs");

const logger = winston.createLogger({
  level: "info", // Default log level
  format: winston.format.combine(
    winston.format.timestamp(),
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
