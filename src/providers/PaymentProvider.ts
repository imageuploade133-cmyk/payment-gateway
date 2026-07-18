export interface PaymentProvider {
  name: string;
  healthCheck(): Promise<boolean>;
}
