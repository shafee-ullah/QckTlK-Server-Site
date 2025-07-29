const express = require('express');
const router = express.Router();
const { ObjectId } = require('mongodb');
const admin = require('firebase-admin');

// Middleware to verify admin role
const verifyAdmin = async (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) {
    return res.status(401).send({ message: "Unauthorized access" });
  }
  
  const token = authHeader.split(" ")[1];
  if (!token) {
    return res.status(401).send({ message: "Unauthorized access" });
  }

  try {
    const decoded = await admin.auth().verifyIdToken(token);
    // Check if user is admin
    const user = await req.app.locals.db.collection('users').findOne({ email: decoded.email });
    if (!user || user.role !== 'admin') {
      return res.status(403).send({ message: "Forbidden: Admin access required" });
    }
    req.user = user;
    next();
  } catch (error) {
    console.error("Admin verification error:", error);
    return res.status(403).send({ message: "Forbidden access" });
  }
};

// Apply admin verification to all routes
router.use(verifyAdmin);

// Get admin dashboard stats
router.get('/stats', async (req, res) => {
  try {
    const db = req.app.locals.db;
    const [postsCount, commentsCount, usersCount] = await Promise.all([
      db.collection('posts').countDocuments({ status: { $ne: 'deleted' } }),
      db.collection('comments').countDocuments({}),
      db.collection('users').countDocuments({})
    ]);

    res.json({
      stats: {
        posts: postsCount,
        comments: commentsCount,
        users: usersCount
      }
    });
  } catch (error) {
    console.error('Error fetching admin stats:', error);
    res.status(500).json({ error: 'Failed to fetch dashboard stats' });
  }
});

// Get all users with pagination and search
router.get('/users', async (req, res) => {
  try {
    const { page = 1, limit = 10, search = '' } = req.query;
    const skip = (parseInt(page) - 1) * parseInt(limit);
    
    const query = {};
    if (search) {
      query.$or = [
        { displayName: { $regex: search, $options: 'i' } },
        { email: { $regex: search, $options: 'i' } }
      ];
    }

    const db = req.app.locals.db;
    const [users, total] = await Promise.all([
      db.collection('users')
        .find(query)
        .skip(skip)
        .limit(parseInt(limit))
        .toArray(),
      db.collection('users').countDocuments(query)
    ]);

    res.json({
      users: users.map(user => ({
        ...user,
        _id: user._id.toString(),
        id: user._id.toString()
      })),
      total,
      page: parseInt(page),
      totalPages: Math.ceil(total / parseInt(limit))
    });
  } catch (error) {
    console.error('Error fetching users:', error);
    res.status(500).json({ error: 'Failed to fetch users' });
  }
});

// Update user role
router.patch('/users/:userId/role', async (req, res) => {
  try {
    const { userId } = req.params;
    const { role } = req.body;
    
    if (!['admin', 'member'].includes(role)) {
      return res.status(400).json({ error: 'Invalid role' });
    }

    const db = req.app.locals.db;
    const result = await db.collection('users').updateOne(
      { _id: new ObjectId(userId) },
      { $set: { role } }
    );

    if (result.matchedCount === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    res.json({ message: 'User role updated successfully' });
  } catch (error) {
    console.error('Error updating user role:', error);
    res.status(500).json({ error: 'Failed to update user role' });
  }
});

// Get all tags
router.get('/tags', async (req, res) => {
  try {
    const db = req.app.locals.db;
    const tags = await db.collection('tags').find().toArray();
    res.json(tags);
  } catch (error) {
    console.error('Error fetching tags:', error);
    res.status(500).json({ error: 'Failed to fetch tags' });
  }
});

// Add new tag
router.post('/tags', async (req, res) => {
  try {
    const { name } = req.body;
    if (!name || typeof name !== 'string' || name.trim() === '') {
      return res.status(400).json({ error: 'Tag name is required' });
    }

    const db = req.app.locals.db;
    const existingTag = await db.collection('tags').findOne({ name: name.trim() });
    if (existingTag) {
      return res.status(400).json({ error: 'Tag already exists' });
    }

    const result = await db.collection('tags').insertOne({
      name: name.trim(),
      createdAt: new Date(),
      createdBy: req.user.email
    });

    res.status(201).json({
      _id: result.insertedId,
      name: name.trim(),
      createdAt: new Date(),
      createdBy: req.user.email
    });
  } catch (error) {
    console.error('Error adding tag:', error);
    res.status(500).json({ error: 'Failed to add tag' });
  }
});

// Get reported comments
router.get('/reports/comments', async (req, res) => {
  try {
    const db = req.app.locals.db;
    const comments = await db.collection('comments')
      .find({ 'reports.0': { $exists: true } })
      .toArray();
    
    res.json(comments);
  } catch (error) {
    console.error('Error fetching reported comments:', error);
    res.status(500).json({ error: 'Failed to fetch reported comments' });
  }
});

// Handle comment report (delete or keep)
router.post('/reports/comments/:commentId/action', async (req, res) => {
  try {
    const { commentId } = req.params;
    const { action } = req.body; // 'delete' or 'dismiss'
    
    const db = req.app.locals.db;
    
    if (action === 'delete') {
      await db.collection('comments').deleteOne({ _id: new ObjectId(commentId) });
      return res.json({ message: 'Comment deleted successfully' });
    } else if (action === 'dismiss') {
      await db.collection('comments').updateOne(
        { _id: new ObjectId(commentId) },
        { $set: { reports: [] } }
      );
      return res.json({ message: 'Report dismissed successfully' });
    } else {
      return res.status(400).json({ error: 'Invalid action' });
    }
  } catch (error) {
    console.error('Error handling comment report:', error);
    res.status(500).json({ error: 'Failed to handle comment report' });
  }
});

// Create announcement
router.post('/announcements', async (req, res) => {
  try {
    const { title, content } = req.body;
    
    if (!title || !content) {
      return res.status(400).json({ error: 'Title and content are required' });
    }

    const db = req.app.locals.db;
    const result = await db.collection('announcements').insertOne({
      title,
      content,
      author: {
        name: req.user.displayName || 'Admin',
        email: req.user.email,
        image: req.user.photoURL || '/default-avatar.png'
      },
      createdAt: new Date(),
      isActive: true
    });

    res.status(201).json({
      _id: result.insertedId,
      title,
      content,
      author: {
        name: req.user.displayName || 'Admin',
        email: req.user.email,
        image: req.user.photoURL || '/default-avatar.png'
      },
      createdAt: new Date(),
      isActive: true
    });
  } catch (error) {
    console.error('Error creating announcement:', error);
    res.status(500).json({ error: 'Failed to create announcement' });
  }
});

// Get all announcements
router.get('/announcements', async (req, res) => {
  try {
    const db = req.app.locals.db;
    const announcements = await db.collection('announcements')
      .find()
      .sort({ createdAt: -1 })
      .toArray();
    
    res.json(announcements);
  } catch (error) {
    console.error('Error fetching announcements:', error);
    res.status(500).json({ error: 'Failed to fetch announcements' });
  }
});

// Toggle announcement status
router.patch('/announcements/:id/status', async (req, res) => {
  try {
    const { id } = req.params;
    const { isActive } = req.body;
    
    if (typeof isActive !== 'boolean') {
      return res.status(400).json({ error: 'isActive must be a boolean' });
    }

    const db = req.app.locals.db;
    const result = await db.collection('announcements').updateOne(
      { _id: new ObjectId(id) },
      { $set: { isActive } }
    );

    if (result.matchedCount === 0) {
      return res.status(404).json({ error: 'Announcement not found' });
    }

    res.json({ message: `Announcement ${isActive ? 'activated' : 'deactivated'} successfully` });
  } catch (error) {
    console.error('Error toggling announcement status:', error);
    res.status(500).json({ error: 'Failed to update announcement status' });
  }
});

module.exports = router;
