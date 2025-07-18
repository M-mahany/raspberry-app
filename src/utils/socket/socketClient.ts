import { io } from "socket.io-client";
import dotenv from "dotenv";
import logger from "../winston/logger";
import { SystemService } from "../../services/systemService";

dotenv.config();

export let isOnline = false;

const socket = io(process.env.MAIN_SERVER_URL, {
  query: {
    clientType: "device",
    // micStatus: isMicActive ? "active" : "inActive",
    accessToken: process.env.ACCESS_TOKEN,
  },
});

socket.on("connect", () => {
  logger.info(`✅ Successfully connected to WebSocket server: ${socket.id}`);
  isOnline = true;
  SystemService.checkMicOnSocketConnect();
});

socket.on("connect_error", (error) => {
  logger.error(`⚠️ WebSocket Connection Error: ${error.message}`);
});

socket.on("disconnect", (reason) => {
  logger.warn(`❌ Disconnected from server. Reason: ${reason}`);
  isOnline = false;
});
