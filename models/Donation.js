const mongoose = require('mongoose');

const donationSchema = new mongoose.Schema({
  foodType: { type: String, required: true }, // 'veg' or 'non-veg'
  quantity: { type: String, required: true },
  location: { type: String, required: true }, // Pickup Location
  deliveryLocation: { type: String, default: '' }, // Where it needs to go
  pickupTime: { type: String },
  pickupWindowStart: { type: String }, // Optional, for time range
  pickupWindowEnd: { type: String },   // Optional, for time range
  preparedBy: { type: String },        // Who prepared the food
  preparedTime: { type: String },      // When it was prepared
  spoilTime: { type: String },         // When it will spoil
  description: { type: String },
  imageUrl: { type: String }, 
  latitude: { type: Number },
  longitude: { type: Number },
  deliveryLatitude: { type: Number },
  deliveryLongitude: { type: Number },
  status: { type: String, default: 'available' }, // 'available', 'assigned', 'picked_up', 'delivered'
  donor: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  courier: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }, // The Volunteer/NGO picking it up
  recipient: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }, // The person receiving the food
  contactNumber: { type: String, default: '' }, // Courier or pickup contact number
  messages: [{
    senderRole: String, // 'volunteer', 'recipient'
    text: String,
    timestamp: { type: Date, default: Date.now }
  }],
  createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('Donation', donationSchema);
