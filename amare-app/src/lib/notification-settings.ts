import { Capacitor, registerPlugin } from "@capacitor/core";

type AmareSettingsPlugin = {
  openNotificationSettings: () => Promise<void>;
};

const AmareSettings = registerPlugin<AmareSettingsPlugin>("AmareSettings");

export async function openAppNotificationSettings() {
  if (!Capacitor.isNativePlatform()) return;
  try {
    await AmareSettings.openNotificationSettings();
  } catch {
    /* settings plugin unavailable */
  }
}
