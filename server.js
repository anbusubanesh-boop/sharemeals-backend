const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const path = require('path');
const http = require('http');
const { Server } = require('socket.io');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const User = require('./models/User');
const Donation = require('./models/Donation');
const webpush = require('web-push');
const Subscription = require('./models/Subscription');

// Configure Web Push VAPID keys
let vapidKeys = {
  publicKey: process.env.VAPID_PUBLIC_KEY,
  privateKey: process.env.VAPID_PRIVATE_KEY
};

if (!vapidKeys.publicKey || !vapidKeys.privateKey) {
  try {
    const generated = webpush.generateVAPIDKeys();
    vapidKeys = generated;
    console.log('\n🔑 [Web Push] Generated VAPID Keys dynamically:');
    console.log('Public Key:', vapidKeys.publicKey);
    console.log('Private Key:', vapidKeys.privateKey);
  } catch (err) {
    console.error('Failed to generate VAPID keys:', err);
  }
}

if (vapidKeys.publicKey && vapidKeys.privateKey) {
  webpush.setVapidDetails(
    'mailto:support@sharemeal.com',
    vapidKeys.publicKey,
    vapidKeys.privateKey
  );
}

const app = express();
const server = http.createServer(app);

const allowedOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',')
  : ["http://localhost:5173", "http://localhost:5174", "http://localhost:3000"];

const io = new Server(server, {
  cors: {
    origin: allowedOrigins,
    methods: ["GET", "POST"]
  }
});

// Socket.io connection
io.on('connection', (socket) => {
  console.log('User connected:', socket.id);

  socket.on('join', (userId) => {
    socket.join(userId);
    console.log(`User ${userId} joined their notification channel`);
  });

  socket.on('locationUpdate', (data) => {
    // data should contain { donationId, lat, lng }
    // Broadcast this to everyone listening for live map updates
    io.emit('riderLocation', data);
  });

  socket.on('disconnect', () => {
    console.log('User disconnected:', socket.id);
  });
});

// Middleware
app.use(express.json());
app.use(cors());
app.use('/uploads', express.static(path.join(__dirname, '..', 'uploads')));

// Helper to send web push notifications
const sendPushNotification = async (payload, targetUserId = null) => {
  try {
    let query = {};
    if (targetUserId) {
      if (Array.isArray(targetUserId)) {
        query = { userId: { $in: targetUserId.map(id => id ? id.toString() : null).filter(Boolean) } };
      } else {
        query = { userId: targetUserId.toString() };
      }
    }
    const subscriptions = await Subscription.find(query);
    console.log(`🌐 [Web Push] Dispatching notifications to ${subscriptions.length} subscribers${targetUserId ? ` (target: ${targetUserId})` : ''}`);
    
    const stringifiedPayload = JSON.stringify(payload);
    
    const notificationPromises = subscriptions.map(sub => {
      return webpush.sendNotification(
        {
          endpoint: sub.endpoint,
          keys: {
            p256dh: sub.keys.p256dh,
            auth: sub.keys.auth
          }
        },
        stringifiedPayload
      ).catch(async (err) => {
        if (err.statusCode === 410 || err.statusCode === 404) {
          console.log(`🗑️ [Web Push] Expired subscription found. Removing endpoint: ${sub.endpoint}`);
          await Subscription.deleteOne({ _id: sub._id });
        } else {
          console.error('Web push error:', err.message);
        }
      });
    });
    
    await Promise.all(notificationPromises);
  } catch (err) {
    console.error('Error sending push notifications:', err);
  }
};

// Web Push Endpoints
app.get('/api/notifications/vapid-public-key', (req, res) => {
  res.json({ publicKey: vapidKeys.publicKey || '' });
});

app.post('/api/notifications/subscribe', async (req, res) => {
  try {
    const { subscription, userId } = req.body;
    if (!subscription || !subscription.endpoint) {
      return res.status(400).json({ error: 'Subscription object required' });
    }
    
    await Subscription.findOneAndUpdate(
      { endpoint: subscription.endpoint },
      { 
        endpoint: subscription.endpoint,
        keys: subscription.keys,
        userId: userId || null
      },
      { upsert: true, new: true }
    );
    
    res.status(201).json({ success: true });
  } catch (err) {
    console.error('Subscribe error:', err);
    res.status(500).json({ error: 'Failed to subscribe' });
  }
});

// Multer Storage Setup
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, path.join(__dirname, '..', 'uploads/'));
  },
  filename: function (req, file, cb) {
    cb(null, Date.now() + path.extname(file.originalname));
  }
});
const upload = multer({ storage: storage });

// Connect to MongoDB
mongoose.connect(process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/sharemeal')
  .then(() => console.log('✅ Connected to MongoDB'))
  .catch(err => console.error('❌ MongoDB Connection Error:', err));

// Register Route
app.post('/api/auth/register', async (req, res) => {
  try {
    const { role, firstName, lastName, email, password, location, foodPreference, phoneNumber } = req.body;

    // Check password strength
    const strongPasswordRegex = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&#])[A-Za-z\d@$!%*?&#]{8,}$/;
    if (!password || !strongPasswordRegex.test(password)) {
      return res.status(400).json({ message: 'Password must be at least 8 characters long, and include uppercase, lowercase, number, and special character' });
    }

    // Check if user exists
    const existingUser = await User.findOne({ email });
    if (existingUser) {
      return res.status(400).json({ message: 'User already exists with this email' });
    }

    // Hash password
    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);

    // Create User
    const user = new User({
      role, firstName, lastName, email, password: hashedPassword, location, foodPreference, phoneNumber
    });

    await user.save();

    // Generate Token
    const token = jwt.sign({ id: user._id }, process.env.JWT_SECRET || 'secret123', { expiresIn: '7d' });

    // Remove password from response
    const userObj = user.toObject();
    delete userObj.password;

    res.status(201).json({ user: userObj, token });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Server error during registration' });
  }
});

// Login Route
app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    // Check if user exists
    const user = await User.findOne({ email });
    if (!user) {
      return res.status(400).json({ message: 'Invalid email or password' });
    }

    // Verify password
    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      return res.status(400).json({ message: 'Invalid email or password' });
    }

    // Generate Token
    const token = jwt.sign({ id: user._id }, process.env.JWT_SECRET || 'secret123', { expiresIn: '7d' });

    // Remove password from response
    const userObj = user.toObject();
    delete userObj.password;

    res.json({ user: userObj, token });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Server error during login' });
  }
});

// Send SMS helper (real Twilio or simulated log)
const sendSMS = async (to, message) => {
  console.log('\n================================================================');
  console.log(`📱 [SMS NOTIFICATION] TO: ${to}`);
  console.log(`✉️ MESSAGE: "${message}"`);
  console.log('================================================================\n');

  const twilioSid = process.env.TWILIO_ACCOUNT_SID;
  const twilioAuthToken = process.env.TWILIO_AUTH_TOKEN;
  const twilioFrom = process.env.TWILIO_FROM_NUMBER;

  if (twilioSid && twilioAuthToken && twilioFrom) {
    try {
      const twilio = require('twilio');
      const client = twilio(twilioSid, twilioAuthToken);
      await client.messages.create({
        body: message,
        from: twilioFrom,
        to: to
      });
      console.log(`✅ [Twilio] SMS successfully sent to ${to}`);
    } catch (err) {
      console.error(`❌ [Twilio] Failed to send SMS to ${to}:`, err.message);
    }
  }
};

// Create a Donation
app.post('/api/donations', upload.single('image'), async (req, res) => {
  try {
    const { foodType, quantity, location, deliveryLocation, pickupTime, description, donorId, latitude, longitude, deliveryLatitude, deliveryLongitude, pickupWindowStart, pickupWindowEnd, preparedBy, preparedTime, spoilTime } = req.body;
    const imageUrl = req.file ? `/uploads/${req.file.filename}` : null;

    const newDonation = new Donation({
      foodType,
      quantity,
      location,
      deliveryLocation,
      pickupTime,
      pickupWindowStart,
      pickupWindowEnd,
      preparedBy,
      preparedTime,
      spoilTime,
      description,
      donor: donorId,
      imageUrl,
      latitude: parseFloat(latitude),
      longitude: parseFloat(longitude),
      deliveryLatitude: deliveryLatitude ? parseFloat(deliveryLatitude) : undefined,
      deliveryLongitude: deliveryLongitude ? parseFloat(deliveryLongitude) : undefined
    });

    await newDonation.save();

    // Notify all connected volunteers and NGOs
    io.emit('newDonation', {
      message: 'New food donation available!',
      donation: newDonation
    });

    sendPushNotification({
      title: '🍱 New surplus food available!',
      body: `${description || 'Surplus food'} (${quantity}) is ready at ${location}.`,
      url: '/request'
    });

    // Send SMS notification to all NGOs/volunteers
    try {
      const recipients = await User.find({ role: 'ngo' });
      recipients.forEach(user => {
        if (user.phoneNumber) {
          sendSMS(
            user.phoneNumber,
            `ShareMeal: New ${foodType} food donation of "${quantity}" is available at ${location}. Login to claim it!`
          );
        }
      });
    } catch (smsErr) {
      console.error('Failed to query users for SMS notification:', smsErr);
    }

    res.status(201).json(newDonation);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Failed to create donation' });
  }
});

// Get all available Donations
app.get('/api/donations', async (req, res) => {
  try {
    const donations = await Donation.find()
      .populate('courier', 'firstName lastName')
      .populate('donor', 'firstName lastName phoneNumber')
      .sort({ createdAt: -1 });
    res.json(donations);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Failed to fetch donations' });
  }
});

// Get a single Donation by ID
app.get('/api/donations/:id', async (req, res) => {
  try {
    const donation = await Donation.findById(req.params.id)
      .populate('donor', 'firstName lastName email phoneNumber')
      .populate('recipient', 'firstName lastName email phoneNumber')
      .populate('courier', 'firstName lastName email phoneNumber');
    if (!donation) {
      return res.status(404).json({ message: 'Donation not found' });
    }
    res.json(donation);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Failed to fetch donation details' });
  }
});

// Delete a Donation
app.delete('/api/donations/:id', async (req, res) => {
  try {
    const donation = await Donation.findByIdAndDelete(req.params.id);
    if (!donation) return res.status(404).json({ message: 'Donation not found' });
    res.json({ message: 'Donation deleted successfully' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Failed to delete donation' });
  }
});

// Cancel/Delete a Request (Return Donation to 'available' state)
app.post('/api/donations/:id/cancel-request', async (req, res) => {
  try {
    const donation = await Donation.findById(req.params.id);
    if (!donation) return res.status(404).json({ message: 'Donation not found' });

    if (donation.status === 'completed' || donation.status === 'delivered') {
      return res.status(400).json({ message: 'Cannot cancel a completed or delivered request' });
    }

    // Reset donation fields to make it available again
    donation.status = 'available';
    donation.recipient = undefined;
    donation.deliveryLocation = undefined;
    donation.contactNumber = undefined;
    donation.courier = undefined;
    donation.deliveryLatitude = undefined;
    donation.deliveryLongitude = undefined;

    await donation.save();

    if (donation.donor) {
      io.to(donation.donor.toString()).emit('notification', {
        message: 'The request for your donation has been cancelled, it is available again.',
        status: 'available'
      });
      sendPushNotification({
        title: '⚠️ Request Cancelled',
        body: `The request for your donation "${donation.foodType || 'food'}" has been cancelled. It is now available again.`,
        url: '/dashboard'
      }, donation.donor);
    }

    res.json({ message: 'Request cancelled successfully', donation });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Failed to cancel request' });
  }
});

// Request Pickup (Assign Volunteer or Mark as Needs Volunteer)
app.post('/api/donations/:id/pickup', async (req, res) => {
  try {
    const { userId, deliveryLocation, contactNumber, needsVolunteer, deliveryLatitude, deliveryLongitude } = req.body;
    console.log(`Processing pickup request for ${req.params.id}. needsVolunteer: ${needsVolunteer}`);
    const donation = await Donation.findById(req.params.id);
    if (!donation) {
      console.log('Donation not found');
      return res.status(404).json({ message: 'Donation not found' });
    }

    const currentStatus = donation.status || 'available';
    if (currentStatus !== 'available') {
      return res.status(400).json({ message: 'Already assigned or claimed' });
    }

    if (needsVolunteer) {
      donation.status = 'needs_volunteer';
      donation.recipient = userId; // Store who requested it
      donation.deliveryLocation = deliveryLocation;
      donation.contactNumber = contactNumber;
      if (deliveryLatitude) donation.deliveryLatitude = deliveryLatitude;
      if (deliveryLongitude) donation.deliveryLongitude = deliveryLongitude;
    } else {
      donation.status = 'assigned';
      donation.courier = userId;
      donation.recipient = userId; // Self-pickup: user is both courier and recipient
      if (deliveryLocation) donation.deliveryLocation = deliveryLocation;
      if (contactNumber) donation.contactNumber = contactNumber;
      if (deliveryLatitude) donation.deliveryLatitude = deliveryLatitude;
      if (deliveryLongitude) donation.deliveryLongitude = deliveryLongitude;
    }

    await donation.save();

    // Notify the donor
    if (donation.donor) {
      io.to(donation.donor.toString()).emit('pickupRequested', {
        message: needsVolunteer ? 'Someone requested your food and needs a volunteer!' : 'A volunteer is on their way to pick up your food!',
        donationId: donation._id
      });
      sendPushNotification({
        title: needsVolunteer ? '📦 Pickup Request: Volunteer Needed!' : '🚚 Volunteer on the way!',
        body: needsVolunteer ? `Someone requested your donation "${donation.foodType || 'food'}" and needs a volunteer!` : `A volunteer is on their way to pick up your donation "${donation.foodType || 'food'}"!`,
        url: '/dashboard'
      }, donation.donor);
      try {
        const donorUser = await User.findById(donation.donor);
        if (donorUser && donorUser.phoneNumber) {
          sendSMS(
            donorUser.phoneNumber,
            needsVolunteer
              ? `ShareMeal: Someone requested your food and needs a volunteer delivery partner!`
              : `ShareMeal: A volunteer is on their way to pick up your food!`
          );
        }
      } catch (smsErr) {
        console.error('Failed to send SMS to donor:', smsErr);
      }
    }

    res.json({ message: 'Request processed successfully', donation });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Server error during request' });
  }
});

// Accept Delivery (Volunteer takes responsibility for a "needs_volunteer" task)
app.post('/api/donations/:id/accept-delivery', async (req, res) => {
  try {
    const { userId } = req.body;
    console.log(`Volunteer ${userId} is accepting delivery for ${req.params.id}`);
    const donation = await Donation.findById(req.params.id);
    if (!donation) {
      console.log('Donation not found');
      return res.status(404).json({ message: 'Donation not found' });
    }

    if (donation.status !== 'needs_volunteer') {
      return res.status(400).json({ message: 'This donation does not require a volunteer or is already taken' });
    }

    donation.status = 'assigned';
    donation.courier = userId;
    await donation.save();

    // Notify donor
    if (donation.donor) {
      io.to(donation.donor.toString()).emit('notification', {
        message: 'A volunteer has accepted the delivery request for your food!',
        status: 'assigned'
      });
      sendPushNotification({
        title: '🚚 Volunteer Assigned!',
        body: `A volunteer has accepted the delivery request for your donation "${donation.foodType || 'food'}"!`,
        url: '/dashboard'
      }, donation.donor);
      try {
        const donorUser = await User.findById(donation.donor);
        if (donorUser && donorUser.phoneNumber) {
          sendSMS(
            donorUser.phoneNumber,
            `ShareMeal: A volunteer has accepted the delivery request for your food donation!`
          );
        }
      } catch (smsErr) {
        console.error('Failed to send SMS to donor:', smsErr);
      }
    }

    res.json({ message: 'Delivery accepted', donation });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Server error' });
  }
});

// Mark as Picked Up (Food in Volunteer's hand)
app.post('/api/donations/:id/pickedup', async (req, res) => {
  try {
    const donation = await Donation.findById(req.params.id);
    donation.status = 'picked_up';
    await donation.save();

    if (donation.donor) {
      io.to(donation.donor.toString()).emit('notification', {
        message: 'Your food has been picked up by the volunteer!',
        status: 'picked_up'
      });
      sendPushNotification({
        title: '📦 Food Picked Up!',
        body: `Your donation "${donation.foodType || 'food'}" has been picked up by the volunteer!`,
        url: '/dashboard'
      }, donation.donor);
      try {
        const donorUser = await User.findById(donation.donor);
        if (donorUser && donorUser.phoneNumber) {
          sendSMS(
            donorUser.phoneNumber,
            `ShareMeal: Your food donation has been picked up by the volunteer!`
          );
        }
      } catch (smsErr) {
        console.error('Failed to send SMS to donor:', smsErr);
      }
    }

    res.json({ message: 'Marked as picked up', donation });
  } catch (err) {
    res.status(500).json({ message: 'Failed to update' });
  }
});

// Mark as Delivered (Food reached destination)
app.post('/api/donations/:id/delivered', async (req, res) => {
  try {
    const { message } = req.body || {};
    const donation = await Donation.findById(req.params.id);
    donation.status = 'delivered';
    if (message) {
      donation.messages.push({ senderRole: 'volunteer', text: message });
    }
    await donation.save();

    if (donation.donor) {
      io.to(donation.donor.toString()).emit('notification', {
        message: message || 'Success! Your food donation has been delivered to the destination.',
        status: 'delivered'
      });
      sendPushNotification({
        title: '🎉 Food Delivered!',
        body: message || `Success! Your donation "${donation.foodType || 'food'}" has been delivered to the destination.`,
        url: '/dashboard'
      }, donation.donor);
      try {
        const donorUser = await User.findById(donation.donor);
        if (donorUser && donorUser.phoneNumber) {
          sendSMS(
            donorUser.phoneNumber,
            message || `ShareMeal: Success! Your food donation has been delivered to the destination.`
          );
        }
      } catch (smsErr) {
        console.error('Failed to send SMS to donor:', smsErr);
      }
    }

    if (donation.recipient) {
      io.to(donation.recipient.toString()).emit('notification', {
        message: 'Your requested food has been delivered to the destination! Please mark it as received.',
        status: 'delivered'
      });
      sendPushNotification({
        title: '🎉 Food Delivered!',
        body: `Your requested food "${donation.foodType || 'food'}" has been delivered. Please mark it as received!`,
        url: '/dashboard'
      }, donation.recipient);
      try {
        const recipientUser = await User.findById(donation.recipient);
        if (recipientUser && recipientUser.phoneNumber) {
          sendSMS(
            recipientUser.phoneNumber,
            `ShareMeal: Your requested food "${donation.foodType || 'food'}" has been delivered. Please mark it as received!`
          );
        }
      } catch (smsErr) {
        console.error('Failed to send SMS to recipient:', smsErr);
      }
    }

    res.json({ message: 'Delivered successfully', donation });
  } catch (err) {
    res.status(500).json({ message: 'Failed to update' });
  }
});

// Mark as Received (Recipient confirms they got the food)
app.post('/api/donations/:id/received', async (req, res) => {
  try {
    const { message } = req.body || {};
    const donation = await Donation.findById(req.params.id);
    if (!donation) return res.status(404).json({ message: 'Donation not found' });

    donation.status = 'completed'; // Final status
    if (message) {
      donation.messages.push({ senderRole: 'recipient', text: message });
    }
    await donation.save();

    // Notify donor and courier
    const participants = [donation.donor, donation.courier].filter(Boolean);
    participants.forEach(pId => {
      io.to(pId.toString()).emit('notification', {
        message: message || 'Great news! The recipient has confirmed receiving the food.',
        status: 'completed'
      });
    });
    sendPushNotification({
      title: '🥗 Donation Completed!',
      body: message || `Great news! The recipient has confirmed receiving your donation "${donation.foodType || 'food'}".`,
      url: '/dashboard'
    }, participants);

    res.json({ message: 'Food received! Thank you for sharing.', donation });
  } catch (err) {
    res.status(500).json({ message: 'Failed to update' });
  }
});

// Get My Active & Completed Requests (For Recipients)
app.get('/api/requests/:userId', async (req, res) => {
  try {
    const requests = await Donation.find({
      recipient: req.params.userId,
      status: { $in: ['needs_volunteer', 'assigned', 'picked_up', 'delivered', 'completed'] }
    })
    .populate('courier', 'firstName lastName')
    .populate('donor', 'firstName lastName phoneNumber')
    .sort({ createdAt: -1 });
    res.json(requests);
  } catch (err) {
    res.status(500).json({ message: 'Failed to fetch requests' });
  }
});

// Get My Donations (For Donors)
app.get('/api/donations/donor/:userId', async (req, res) => {
  try {
    const donations = await Donation.find({
      donor: req.params.userId
    }).sort({ createdAt: -1 });
    res.json(donations);
  } catch (err) {
    res.status(500).json({ message: 'Failed to fetch donor donations' });
  }
});

// Get My Active Tasks (For Volunteers)
app.get('/api/tasks/:userId', async (req, res) => {
  try {
    const tasks = await Donation.find({
      courier: req.params.userId,
      status: { $in: ['assigned', 'picked_up'] }
    })
    .populate('courier', 'firstName lastName')
    .populate('donor', 'firstName lastName phoneNumber')
    .sort({ createdAt: -1 });
    res.json(tasks);
  } catch (err) {
    res.status(500).json({ message: 'Failed to fetch tasks' });
  }
});

// Get general system stats summary
app.get('/api/stats/summary', async (req, res) => {
  try {
    const mealsSaved = await Donation.countDocuments({ status: 'completed' });
    const activeDonors = await User.countDocuments({ role: 'donor' });
    const activeNGOs = await User.countDocuments({ role: 'ngo' });

    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const mealsSharedToday = await Donation.countDocuments({
      createdAt: { $gte: todayStart }
    });

    res.json({
      mealsSaved,
      activeDonors,
      activeNGOs,
      mealsSharedToday
    });
  } catch (err) {
    console.error('Stats query error:', err);
    res.status(500).json({ message: 'Failed to fetch summary stats' });
  }
});

// Get all registered NGOs
app.get('/api/ngos', async (req, res) => {
  try {
    const ngos = await User.find({ role: 'ngo' }).select('firstName lastName email location phoneNumber');
    res.json(ngos);
  } catch (err) {
    console.error('NGO query error:', err);
    res.status(500).json({ message: 'Failed to fetch NGOs' });
  }
});

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
