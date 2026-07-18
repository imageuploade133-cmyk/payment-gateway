import "axios";

declare module "axios" {
  export interface AxiosRequestConfig {
    metadata?: {
      retryCount?: number;
    };
  }
  export interface InternalAxiosRequestConfig {
    metadata?: {
      retryCount?: number;
    };
  }
}
