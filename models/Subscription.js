const mongoose = require('mongoose');

const SubscriptionSchema = new mongoose.Schema({
  endpoint: { type: String, unique: true, required: true },
  keys: {
    p256dh: { type: String, required: true },
    auth: { type: String, required: true }
  },
  userId: { type: String, default: null },
  createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('Subscription', SubscriptionSchema);
