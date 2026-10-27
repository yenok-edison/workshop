// Edit this file after deploying the Apps Script (see README.md).
window.APP_CONFIG = {
  // The "Web app" URL from Apps Script > Deploy. It ends in /exec.
  API_URL: 'PASTE_YOUR_APPS_SCRIPT_WEB_APP_URL_HERE',

  // Your Razorpay Payment Button IDs (they start with pl_).
  PAYMENT_BUTTON_IDS: {
    individual: 'pl_PASTE_INDIVIDUAL_BUTTON_ID',
    group: 'pl_PASTE_GROUP_BUTTON_ID'
  },

  SLOT_REFRESH_MS: 8000,  // how often available slots are re-checked
  STATUS_POLL_MS: 6000    // how often payment status is re-checked on the payment step
};
