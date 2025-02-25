import axios from "axios";
import dotenv from "dotenv";

dotenv.config();

export const serverAPI = axios.create({
  baseURL: process.env.MAIN_SERVER_URL,
  headers: { Authorization: `Bearer ${process.env.DEVICE_TOKEN}` },
});
