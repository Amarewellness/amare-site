import { withMobileCorsHandler, MOBILE_PREF_CORS } from "./mobile-api-cors.mjs";
import { withLambdaMobileCors } from "./amare-lambda-mobile-cors.mjs";
import { handleNotificationPreferences } from "./amare-notification-http.mjs";

export const lambdaHandler = withMobileCorsHandler(handleNotificationPreferences, MOBILE_PREF_CORS);
export default withLambdaMobileCors(lambdaHandler, MOBILE_PREF_CORS);
