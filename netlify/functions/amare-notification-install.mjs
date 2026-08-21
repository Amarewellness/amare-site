import { withMobileCorsHandler } from "./mobile-api-cors.mjs";
import { withLambdaMobileCors } from "./amare-lambda-mobile-cors.mjs";
import { handleNotificationInstallation } from "./amare-notification-http.mjs";

export const lambdaHandler = withMobileCorsHandler(handleNotificationInstallation);
export default withLambdaMobileCors(lambdaHandler);
