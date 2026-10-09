import axios, { type AxiosInstance } from "axios";

export function createApiClient(baseURL: string = ""): AxiosInstance {
  const instance = axios.create({
    baseURL,
    timeout: 30000,
    headers: {
      "Content-Type": "application/json",
    },
  });

  instance.interceptors.request.use((config) => {
    // Attach client-side correlation ID if not present
    if (!config.headers["X-Correlation-ID"]) {
      config.headers["X-Correlation-ID"] =
        `req_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
    }
    return config;
  });

  return instance;
}

export const apiClient = createApiClient();
