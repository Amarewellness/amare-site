import { withMobileCorsHandler } from "./mobile-api-cors.mjs";
import { handleNotificationInstallation } from "./amare-notification-http.mjs";

export const handler = withMobileCorsHandler(handleNotificationInstallation);
