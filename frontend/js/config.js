/* =============================================================================
   CloudPaw — frontend settings
   Loaded before js/script.js on every page. This is the only frontend file
   that differs between environments: deploy a different copy of it (e.g. to
   S3) instead of editing script.js.

   API_BASE: where the browser sends API requests.
     "/api"  The API is on the same address as the site: locally (Express
             serves both) and on AWS when CloudFront forwards /api/* to API
             Gateway. No CORS or CSP changes are needed.
     A full URL, e.g. "https://abc123.execute-api.us-east-1.amazonaws.com/prod/api",
             if the site calls API Gateway on its own address instead. Then
             also set ALLOWED_ORIGIN on the backend to the site's address, and
             add the API's address to connect-src in the page's
             Content-Security-Policy (sent by CloudFront on AWS).
   ============================================================================= */

window.CLOUDPAW_CONFIG = {
  API_BASE: "/api",
};
