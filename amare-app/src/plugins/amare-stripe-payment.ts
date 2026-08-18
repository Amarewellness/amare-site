import { Capacitor, registerPlugin } from "@capacitor/core";

export type PaymentSheetNativeResult = {
  status: "completed" | "canceled" | "failed" | "ignored";
  message?: string;
};

type AmareStripePaymentPlugin = {
  presentPaymentSheet: (options: {
    publishableKey: string;
    clientSecret: string;
    merchantDisplayName: string;
  }) => Promise<PaymentSheetNativeResult>;
};

const AmareStripePayment = registerPlugin<AmareStripePaymentPlugin>("AmareStripePayment");

export function nativePaymentSheetAvailable(): boolean {
  return Capacitor.isNativePlatform() && Capacitor.getPlatform() === "android";
}

export async function presentNativePaymentSheet(options: {
  publishableKey: string;
  clientSecret: string;
  merchantDisplayName: string;
}): Promise<PaymentSheetNativeResult> {
  if (!nativePaymentSheetAvailable()) {
    throw new Error("payment_sheet_android_only");
  }
  return AmareStripePayment.presentPaymentSheet(options);
}
