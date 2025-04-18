import { io } from "socket.io-client";
import dotenv from "dotenv";
import logger from "../winston/logger";

dotenv.config();

const socket = io(process.env.MAIN_SERVER_URL, {
  query: {
    accessToken: process.env.ACCESS_TOKEN,
  },
});

socket.on("connect", () => {
  logger.info(`✅ Successfully connected to WebSocket server: ${socket.id}`);
});

socket.on("connect_error", (error) => {
  logger.error(`⚠️ WebSocket Connection Error: ${error.message}`);
});

socket.on("disconnect", (reason) => {
  logger.warn(`❌ Disconnected from server. Reason: ${reason}`);
});
