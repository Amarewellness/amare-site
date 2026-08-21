export function isAmarePushClientEnabled(): boolean {
  return import.meta.env.VITE_ENABLE_AMARE_PUSH === "1";
}
