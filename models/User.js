const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
  role: { type: String, required: true, default: 'donor' },
  firstName: { type: String, required: true },
  lastName: { type: String, required: true },
  email: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  location: { type: String, default: '' },
  foodPreference: { type: String, default: 'all' },
  phoneNumber: { type: String, default: '' },
}, { timestamps: true });

module.exports = mongoose.model('User', userSchema);
