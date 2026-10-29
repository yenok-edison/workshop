// Edit this file after deploying the Apps Script (see README.md).
window.APP_CONFIG = {
  // The "Web app" URL from Apps Script > Deploy. It ends in /exec.
  // API_URL: 'https://script.google.com/macros/s/AKfycbyIEN1a2ixHV_Cn6GkNSoIJGUKajV7tc_Wew8ggm2naaEkPF1qnms7_9oJbh5GNFvVy/exec',
  API_URL: 'https://script.google.com/macros/s/AKfycbyIEN1a2ixHV_Cn6GkNSoIJGUKajV7tc_Wew8ggm2naaEkPF1qnms7_9oJbh5GNFvVy/exec',

  // Your Razorpay Payment Button IDs (they start with pl_).
  PAYMENT_BUTTON_IDS: {
    individual: 'pl_TaF6NBsPi45JJ4',
    group: 'pl_TtJ2nkb0JpJkqR'
  },

  SLOT_REFRESH_MS: 8000,  // how often available slots are re-checked
  STATUS_POLL_MS: 6000    // how often payment status is re-checked on the payment step
};
