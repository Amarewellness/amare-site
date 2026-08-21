import { Browser } from "@capacitor/browser";
import { Capacitor } from "@capacitor/core";
import { apiJson } from "../api/client";

export const STUDIO_PHONE_DISPLAY = "(954) 258-9238";
export const STUDIO_PHONE_TEL = "+19542589238";
export const STUDIO_WHATSAPP_URL = "https://wa.me/19542589238";
export const STUDIO_INSTAGRAM_URL = "https://www.instagram.com/amare__wellness/";
export const PRIVATE_EVENTS_URL = "https://www.amarewellness.com/privateevents";
export const STUDIO_HOURS =
  "Monday–Thursday & Sunday, 8:00 AM – 10:00 PM · Friday, 8:00 AM – 4:00 PM · Saturday, closed.";

export const CONTACT_TOPICS = [
  { value: "general", label: "General" },
  { value: "first-visit", label: "First visit / what class?" },
  { value: "event", label: "Private event or treatment room" },
  { value: "retail", label: "Product question" },
  { value: "other", label: "Other" },
] as const;

export async function openExternalUrl(url: string): Promise<void> {
  if (Capacitor.isNativePlatform()) {
    await Browser.open({ url });
    return;
  }
  window.open(url, "_blank", "noopener,noreferrer");
}

export async function submitContactMessage(input: {
  name: string;
  email: string;
  topic: string;
  message: string;
}): Promise<void> {
  await apiJson("/api/contact", null, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
}
