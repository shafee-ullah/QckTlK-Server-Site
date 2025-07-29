const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");
const { MongoClient, ServerApiVersion } = require("mongodb");
const { ObjectId } = require("mongodb");
const admin = require("firebase-admin");
const adminRoutes = require("./routes/admin.routes");
// Load environment variables from .env file
dotenv.config();
const stripe = require("stripe")(process.env.PAYMENT_GATEWAY_KEY);
const app = express();
const port = process.env.PORT || 3000;

// Middleware
const corsOptions = {
  origin: ['http://localhost:5173', 'http://localhost:3000'],
  credentials: true,
  optionsSuccessStatus: 200 // Some legacy browsers (IE11, various SmartTVs) choke on 204
};

app.use(cors(corsOptions));
app.use(express.json());

// Firebase
const serviceAccount = require("./firebase-admin-key.json");
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

// Constants
const FREE_USER_POST_LIMIT = 5;

const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.8puxff9.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0`;

// Create a MongoClient with a MongoClientOptions object to set the Stable API version
const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

async function run() {
  try {
    // Connect the client to the server	(optional starting in v4.7)
    await client.connect()
    // Send a ping to confirm a successful connection
    await client.db("admin").command({ ping: 1 });
    console.log(
      "Pinged your deployment. You successfully connected to MongoDB!"
    );
  } finally {
    // Ensures that the client will close when you finish/error
    // await client.close();
  }
}
run().catch(console.dir);



const verifyFBToken = async (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) {
    return res.status(401).send({ message: "unauthorized access" });
  }
  const token = authHeader.split(" ")[1];
  if (!token) {
    return res.status(401).send({ message: "unauthorized access" });
  }

  // verify the token
  try {
    const decoded = await admin.auth().verifyIdToken(token);
    req.decoded = decoded;
    next();
  } catch (error) {
    return res.status(403).send({ message: "forbidden access" });
  }
};

// Stripe Account

// Requires: stripe npm installed, secret key set
app.post("/create-payment-intent", async (req, res) => {
  const { amount } = req.body;

  const paymentIntent = await stripe.paymentIntents.create({
    amount,
    currency: "usd",
    payment_method_types: ["card"],
  });

  res.send({ clientSecret: paymentIntent.client_secret });
});

// MongoDB collections
const db = client.db("qcktlk_forum");
const postsCollection = db.collection("posts");
const commentsCollection = db.collection("comments");
const tagsCollection = db.collection("tags");
const announcementsCollection = db.collection("announcements");
const usersCollection = db.collection("users");
const paymentsCollection = db.collection("payments");

// Make collections available to routes
app.locals.db = db;

// Get user's post count
app.get("/posts/user/:email/count", async (req, res) => {
  try {
    const { email } = req.params;
    
    if (!email) {
      return res.status(400).json({ error: "Email is required" });
    }

    const count = await postsCollection.countDocuments({ 
      authorEmail: email,
      status: { $ne: 'deleted' } // Don't count deleted posts
    });

    res.json({ count });
  } catch (error) {
    console.error("Error counting user posts:", error);
    res.status(500).json({ error: "Failed to count user posts" });
  }
});

// Check if user can create a post (for free users with post limit)
const canUserCreatePost = async (email) => {
  try {
    // Check if user is premium
    const user = await usersCollection.findOne({ email });
    if (user?.membership === 'premium') {
      return { canPost: true };
    }

    // For free users, check post count
    const postCount = await postsCollection.countDocuments({ 
      authorEmail: email,
      status: { $ne: 'deleted' }
    });

    return {
      canPost: postCount < FREE_USER_POST_LIMIT,
      postCount,
      limit: FREE_USER_POST_LIMIT
    };
  } catch (error) {
    console.error("Error checking post limit:", error);
    throw new Error("Failed to check post limit");
  }
};

// Get total post count
app.get("/posts/count", async (req, res) => {
  try {
    const total = await postsCollection.countDocuments({ status: { $ne: 'deleted' } });
    res.json({ total });
  } catch (error) {
    console.error("Error getting post count:", error);
    res.status(500).json({ error: "Failed to get post count" });
  }
});

// Get popular tags
app.get("/api/tags/popular", async (req, res) => {
  try {
    const popularTags = await postsCollection.aggregate([
      { $unwind: "$tags" },
      { $group: { _id: "$tags", count: { $sum: 1 } } },
      { $sort: { count: -1 } },
      { $limit: 10 },
      { $project: { _id: 0, name: "$_id", count: 1 } }
    ]).toArray();
    
    res.json(popularTags);
  } catch (error) {
    console.error("Error fetching popular tags:", error);
    res.status(500).json({ error: "Failed to fetch popular tags" });
  }
});

// Get all posts with search, filter, sort, and pagination
app.get("/posts", async (req, res) => {
  try {
    console.log('Incoming request query:', req.query);
    const {
      search = "",
      tag = "",
      author = "",
      startDate = "",
      endDate = "",
      sort = "new",
      page = 1,
      limit = 10
    } = req.query;
    
    console.log('Parsed sort parameter:', sort);
    const query = {};

    // Text search (title and description)
    if (search) {
      query.$or = [
        { title: { $regex: search, $options: "i" } },
        { description: { $regex: search, $options: "i" } },
      ];
    }

    // Tag filter
    if (tag) {
      query.tags = tag;
    }

    // Author filter
    if (author) {
      query.authorName = { $regex: author, $options: "i" };
    }

    // Date range filter
    if (startDate || endDate) {
      query.postTime = {};
      if (startDate) {
        query.postTime.$gte = new Date(startDate);
      }
      if (endDate) {
        query.postTime.$lte = new Date(endDate);
      }
    }

    // Use offset-based pagination
    const skip = (Number(page) - 1) * Number(limit);
    
    // First, get the total count
    const total = await postsCollection.countDocuments(query);
    
    // Then get the paginated results with proper sorting
    let cursor = postsCollection.find(query);
    
    // Log the sort parameter and query for debugging
    console.log('Sort parameter:', sort);
    console.log('Query parameters:', { search, tag, author, startDate, endDate, sort, page, limit });
    
    // Apply sorting based on sort parameter
    if (sort === 'popular') {
      console.log('Sorting by popularity (upVote: -1, postTime: -1)');
      
      // Simple sort by upVote (descending) and postTime (descending)
      cursor = cursor.sort({ upVote: -1, postTime: -1 });
      
      // Get all matching posts first
      const allMatchingPosts = await cursor.toArray();
      
      // Apply pagination manually
      const paginatedPosts = allMatchingPosts.slice(skip, skip + Number(limit));
      
      // Log the first few posts to verify sorting
      console.log('First 3 posts after popularity sort:');
      paginatedPosts.slice(0, 3).forEach((post, index) => {
        console.log(`Post ${index + 1}:`, {
          title: post.title,
          upVote: post.upVote || 0,
          downVote: post.downVote || 0,
          netVotes: (post.upVote || 0) - (post.downVote || 0),
          postTime: post.postTime
        });
      });
      
      // Return the paginated results
      return res.status(200).json({
        data: paginatedPosts,
        total: allMatchingPosts.length,
        totalPages: Math.ceil(allMatchingPosts.length / Number(limit)),
        currentPage: Number(page),
        hasMore: skip + paginatedPosts.length < allMatchingPosts.length
      });
    } else {
      // Default: sort by postTime in descending order (newest first)
      cursor = cursor.sort({ postTime: -1 });
      console.log('Sorting by newest (postTime: -1)');
    }
    
    // Apply pagination and get the results
    const paginatedPosts = await cursor
      .skip(skip)
      .limit(Number(limit))
      .toArray();
      
    // Log the first few posts to verify sorting
    console.log('First 3 posts after sorting:');
    paginatedPosts.slice(0, 3).forEach((post, index) => {
      console.log(`Post ${index + 1}:`, {
        title: post.title,
        upVote: post.upVote,
        postTime: post.postTime
      });
    });
      
    // Calculate if there are more pages
    const hasMore = skip + paginatedPosts.length < total;
    const totalPages = Math.ceil(total / Number(limit));
    
    console.log('Pagination Info:', {
      total,
      page: Number(page),
      limit: Number(limit),
      skip,
      hasMore,
      totalPages,
      returnedPosts: paginatedPosts.length
    });
    
    // Return the response in a simpler format that matches client expectations
    res.status(200).json({
      data: paginatedPosts,
      total,
      totalPages,
      currentPage: Number(page),
      hasMore
    });
  } catch (error) {
    console.error("Error fetching posts:", error);
    res.status(500).json({ error: "Failed to fetch posts" });
  }
});


// Create a new post with post limit logics
app.post("/posts", async (req, res) => {
  try {
    const { title, description, tags, authorName, authorImage } = req.body;

    if (!title || !description || !authorName) {
      return res
        .status(400)
        .json({ error: "Title, description, and author name are required" });
    }

    // Check user's membership and post count
    const user = await usersCollection.findOne({ email: authorName });
    const userPostsCount = await postsCollection.countDocuments({
      authorName,
    });

    // Free users can only post 5 times (including new users who don't exist in usersCollection yet)
    if ((!user || user.membership !== "gold") && userPostsCount >= 5) {
      return res.status(403).json({
        error:
          "You have reached your post limit. Upgrade to Gold membership for unlimited posts.",
      });
    }

    const newPost = {
      title,
      description,
      tags: tags || [],
      authorName,
      authorImage: authorImage || "/default-avatar.png",
      postTime: new Date(),
      upVote: 0,
      downVote: 0,
      commentCount: 0,
    };

    const result = await postsCollection.insertOne(newPost);
    res.status(201).json({
      message: "Post created successfully",
      postId: result.insertedId,
    });
  } catch (error) {
    console.error("Error creating post:", error);
    res.status(500).json({ error: "Failed to create post" });
  }
});

// Delete a post (only by the author)
app.delete("/posts/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { authorName } = req.body; // In a real app, this would come from auth token

    if (!authorName) {
      return res.status(400).json({ error: "Author name is required" });
    }

    // Validate ObjectId format
    if (!ObjectId.isValid(id)) {
      return res.status(400).json({ error: "Invalid post ID format" });
    }

    const post = await postsCollection.findOne({ _id: new ObjectId(id) });

    if (!post) {
      return res.status(404).json({ error: "Post not found" });
    }

    if (post.authorName !== authorName) {
      return res
        .status(403)
        .json({ error: "You can only delete your own posts" });
    }

    await postsCollection.deleteOne({ _id: new ObjectId(id) });

    // Also delete associated comments
    await commentsCollection.deleteMany({ postId: id });

    res.json({ message: "Post deleted successfully" });
  } catch (error) {
    console.error("Error deleting post:", error);
    res.status(500).json({ error: "Failed to delete post" });
  }
});

// Get all tags
app.get("/tags", async (req, res) => {
  try {
    const tags = await tagsCollection.find({}).toArray();
    res.json(tags);
  } catch (error) {
    console.error("Error fetching tags:", error);
    res.status(500).json({ error: "Failed to fetch tags" });
  }
});

// Get all announcements
app.get("/announcements", async (req, res) => {
  try {
    const announcements = await announcementsCollection
      .find({})
      .sort({ createdAt: -1 })
      .toArray();
    res.json(announcements);
  } catch (error) {
    console.error("Error fetching announcements:", error);
    res.status(500).json({ error: "Failed to fetch announcements" });
  }
});

// Get single post by ID
app.get("/posts/:id", async (req, res) => {
  try {
    const postId = req.params.id;

    // Validate ObjectId format
    if (!ObjectId.isValid(postId)) {
      return res.status(400).json({ error: "Invalid post ID format" });
    }

    const post = await postsCollection.findOne({ _id: new ObjectId(postId) });
    if (!post) {
      return res.status(404).json({ error: "Post not found" });
    }
    res.json(post);
  } catch (error) {
    console.error("Error fetching post:", error);
    res.status(500).json({ error: "Failed to fetch post" });
  }
});

// Get comments for a post
app.get("/posts/:id/comments", async (req, res) => {
  try {
    const postId = req.params.id;
    const comments = await commentsCollection
      .find({ postId: new ObjectId(postId) })
      .sort({ createdAt: 1 })
      .toArray();
    res.json(comments);
  } catch (error) {
    console.error("Error fetching comments:", error);
    res.status(500).json({ error: "Failed to fetch comments" });
  }
});

// Create a new post
app.post("/posts", async (req, res) => {
  try {
    const post = req.body;
    
    // Check if user can create a new post
    const canPost = await canUserCreatePost(post.authorEmail);
    if (!canPost.canPost) {
      return res.status(403).json({
        error: `Free users are limited to ${FREE_USER_POST_LIMIT} posts. Upgrade to premium for unlimited posts.`,
        limitReached: true,
        postCount: canPost.postCount,
        limit: canPost.limit
      });
    }

    const result = await postsCollection.insertOne({
      ...post,
      createdAt: new Date(),
      updatedAt: new Date(),
      upvotes: 0,
      downvotes: 0,
      views: 0,
      status: 'active',
      tags: Array.isArray(post.tags) ? post.tags : post.tags?.split(',').map(tag => tag.trim()) || []
    });
    
    // Update the post count in the response
    const updatedCount = await postsCollection.countDocuments({ 
      authorEmail: post.authorEmail,
      status: { $ne: 'deleted' }
    });
    
    res.status(201).json({ 
      _id: result.insertedId, 
      ...post,
      postCount: updatedCount,
      limit: FREE_USER_POST_LIMIT
    });
  } catch (error) {
    console.error("Error creating post:", error);
    res.status(500).json({ error: "Failed to create post" });
  }
});

// Add comment to a post
app.post("/posts/:id/comments", async (req, res) => {
  try {
    const postId = req.params.id;
    const { comment, authorName, authorEmail, authorImage } = req.body;

    if (!comment || !comment.trim()) {
      return res.status(400).json({ error: "Comment is required" });
    }

    if (!authorName || !authorEmail) {
      return res.status(400).json({ error: "Author information is required" });
    }

    const newComment = {
      postId: new ObjectId(postId),
      comment: comment.trim(),
      authorName: authorName,
      authorEmail: authorEmail,
      authorImage: authorImage || "/default-avatar.svg",
      createdAt: new Date(),
    };

    const result = await commentsCollection.insertOne(newComment);

    // Update comment count on post
    const post = await postsCollection.findOne({ _id: new ObjectId(postId) });
    if (post) {
      await postsCollection.updateOne(
        { _id: new ObjectId(postId) },
        { $inc: { commentCount: 1 } }
      );
    }

    res.status(201).json({ ...newComment, _id: result.insertedId });
  } catch (error) {
    console.error("Error adding comment:", error);
    res.status(500).json({ error: "Failed to add comment" });
  }
});

// Delete a comment (only by post author or comment author)
app.delete("/posts/:postId/comments/:commentId", async (req, res) => {
  try {
    const { postId, commentId } = req.params;
    const { authorName } = req.body; // In real app, this would come from auth token

    if (!authorName) {
      return res.status(400).json({ error: "Author name is required" });
    }

    // Check if user is the post author
    const post = await postsCollection.findOne({ _id: new ObjectId(postId) });
    if (!post) {
      return res.status(404).json({ error: "Post not found" });
    }

    const comment = await commentsCollection.findOne({
      _id: new ObjectId(commentId),
    });
    if (!comment) {
      return res.status(404).json({ error: "Comment not found" });
    }

    // Allow deletion if user is post author or comment author
    if (post.authorName !== authorName && comment.authorName !== authorName) {
      return res.status(403).json({
        error:
          "You can only delete comments on your posts or your own comments",
      });
    }

    await commentsCollection.deleteOne({ _id: new ObjectId(commentId) });

    // Update comment count on post
    await postsCollection.updateOne(
      { _id: new ObjectId(postId) },
      { $inc: { commentCount: -1 } }
    );

    res.json({ message: "Comment deleted successfully" });
  } catch (error) {
    console.error("Error deleting comment:", error);
    res.status(500).json({ error: "Failed to delete comment" });
  }
});

// Report a comment
app.post("/api/comments/:commentId/report", async (req, res) => {
  try {
    const { commentId } = req.params;
    const { reporterEmail, reason } = req.body;

    if (!reporterEmail || !reason) {
      return res
        .status(400)
        .json({ error: "Reporter email and reason are required" });
    }

    const comment = await commentsCollection.findOne({
      _id: new ObjectId(commentId),
    });
    if (!comment) {
      return res.status(404).json({ error: "Comment not found" });
    }

    // In a real app, you'd store reports in a separate collection
    // For now, we'll just acknowledge the report
    console.log(
      `Comment ${commentId} reported by ${reporterEmail} for: ${reason}`
    );

    res.json({ message: "Comment reported successfully" });
  } catch (error) {
    console.error("Error reporting comment:", error);
    res.status(500).json({ error: "Failed to report comment" });
  }
});

// Vote on a post
app.post("/posts/:id/vote", async (req, res) => {
  try {
    console.log('Vote request received:', {
      params: req.params,
      body: req.body,
      headers: req.headers
    });
    
    const postId = req.params.id;
    const { voteType, userId } = req.body; // 'upvote' or 'downvote'

    if (!["upvote", "downvote"].includes(voteType)) {
      console.log('Invalid vote type:', voteType);
      return res.status(400).json({ error: "Invalid vote type" });
    }

    if (!userId) {
      console.log('No userId provided');
      return res.status(401).json({ error: "User not authenticated" });
    }

    console.log('Finding post:', postId);
    const post = await postsCollection.findOne({ _id: new ObjectId(postId) });
    if (!post) {
      console.log('Post not found:', postId);
      return res.status(404).json({ error: "Post not found" });
    }

    // Initialize votes object if it doesn't exist
    if (!post.votes) {
      await postsCollection.updateOne(
        { _id: new ObjectId(postId) },
        { $set: { votes: {} } }
      );
    }

    const userVote = post.votes?.[userId];
    let update = {};

    if (userVote === voteType) {
      // User is clicking the same vote again, so remove their vote
      update = {
        $inc: { [voteType === 'upvote' ? 'upVote' : 'downVote']: -1 },
        $unset: { [`votes.${userId}`]: "" }
      };
    } else if (userVote) {
      // User is changing their vote
      update = {
        $inc: {
          [voteType === 'upvote' ? 'upVote' : 'downVote']: 1,
          [userVote === 'upvote' ? 'upVote' : 'downVote']: -1
        },
        $set: { [`votes.${userId}`]: voteType }
      };
    } else {
      // User is voting for the first time
      update = {
        $inc: { [voteType === 'upvote' ? 'upVote' : 'downVote']: 1 },
        $set: { [`votes.${userId}`]: voteType }
      };
    }

    await postsCollection.updateOne(
      { _id: new ObjectId(postId) },
      update
    );

    res.json({
      upVote: post.upVote,
      downVote: post.downVote,
      userVote: post.userVote,
    });
  } catch (error) {
    console.error("Error voting on post:", error);
    res.status(500).json({ error: "Failed to vote on post" });
  }
});

// Upgrade user to member and assign Gold badge
app.post("/api/users/upgrade", async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) {
      return res.status(400).json({ error: "Email is required" });
    }
    const update = {
      $set: {
        membership: "gold",
        badge: "Gold",
        membershipUpgradedAt: new Date(),
      },
    };
    const result = await usersCollection.updateOne({ email }, update, {
      upsert: true,
    });
    if (result.modifiedCount === 0 && result.upsertedCount === 0) {
      return res.status(404).json({ error: "User not found or not updated" });
    }
    res.json({ message: "User upgraded to Gold membership" });
  } catch (error) {
    console.error("Error upgrading user:", error);
    res.status(500).json({ error: "Failed to upgrade user" });
  }
});

// Stripe Account (if needed later)
// app.post("/create-payment-intent", async (req, res) => {
//   try {
//     const { amount } = req.body;
//     // Mock response for development
//     res.send({ clientSecret: "pi_mock_client_secret_for_development" });
//   } catch (error) {
//     console.error("Error creating payment intent:", error);
//     res.status(500).json({ error: "Failed to create payment intent" });
//   }
// });





app.post("/create-payment-intent", async (req, res) => {
  try {
    const { amount, email } = req.body;

    if (!amount || isNaN(amount)) {
      return res.status(400).json({ error: "Valid amount is required" });
    }

    const paymentIntent = await stripe.paymentIntents.create({
      amount: Number(amount),
      currency: "usd",
      metadata: {
        email: email || "guest@example.com",
        integration_check: "accept_a_payment"
      }
    });

    res.send({
      clientSecret: paymentIntent.client_secret
    });
  } catch (error) {
    console.error("Error creating payment intent:", error);
    res.status(500).json({ error: "Failed to create payment intent" });
  }
});


// Store a payment record and update user membership
app.post("/api/payments", async (req, res) => {
  const session = client.startSession();
  try {
    await session.withTransaction(async () => {
      const { email, amount, status, paymentIntentId, date, membershipType = 'premium' } = req.body;

      if (!email || !amount || !status || !paymentIntentId) {
        throw new Error("Missing required payment fields");
      }

      // 1. Record the payment
      const payment = {
        email,
        amount,
        status,
        paymentIntentId,
        membershipType,
        date: date ? new Date(date) : new Date(),
      };
      
      await paymentsCollection.insertOne(payment, { session });

      // 2. Update user's membership status if payment is successful
      if (status === 'succeeded') {
        await usersCollection.updateOne(
          { email },
          { 
            $set: { 
              membership: membershipType,
              membershipUpgradedAt: new Date() 
            },
            $setOnInsert: {
              // These fields will only be set if this is a new user
              email,
              role: 'member',
              createdAt: new Date(),
              lastLogin: new Date()
            }
          },
          { 
            upsert: true,
            session
          }
        );
      }

      res.json({ 
        message: "Payment recorded successfully",
        membershipUpdated: status === 'succeeded'
      });
    });
  } catch (error) {
    console.error("Error processing payment:", error);
    res.status(500).json({ 
      error: "Failed to process payment",
      details: error.message 
    });
  } finally {
    await session.endSession();
  }
});

// Get payments by email (compatibility with client)
app.get("/api/payments", async (req, res) => {
  try {
    const { email } = req.query;
    
    if (!email) {
      return res.status(400).json({ error: "Email is required" });
    }

    const payments = await paymentsCollection
      .find({ email })
      .sort({ date: -1 })
      .toArray();

    res.json(payments);
  } catch (error) {
    console.error("Error fetching payments:", error);
    res.status(500).json({ error: "Failed to fetch payments" });
  }
});

// Get payment history for a user (alternative endpoint)
app.get("/api/payments/history", async (req, res) => {
  try {
   
    const { email } = req.query;
    if (!email) {
      return res.status(400).json({ error: "Email is required" });
    }
    const history = await paymentsCollection
      .find({ email })
      .sort({ date: -1 })
      .toArray();
    res.json(history);
  } catch (error) {
    console.error("Error fetching payment history:", error);
    res.status(500).json({ error: "Failed to fetch payment history" });
  }
});

// app.get("/api/payments/history", verifyFBToken, async (req, res) => {
//   try {
//     const { email } = req.query;

//     if (!email) {
//       return res.status(400).json({ error: "Email is required" });
//     }

//     // Only allow access to the user who owns the token
//     if (req.decoded.email !== email) {
//       return res.status(403).json({ error: "Forbidden: Access denied" });
//     }

//     const history = await paymentsCollection
//       .find({ email })
//       .sort({ date: -1 })
//       .toArray();

//     res.json(history);
//   } catch (error) {
//     console.error("Error fetching payment history:", error);
//     res.status(500).json({ error: "Failed to fetch payment history" });
//   }
// });


// Update user role
app.patch("/api/users/:userId/role", async (req, res) => {
  try {
    const { userId } = req.params;
    const { role } = req.body;
    
    if (!['admin', 'member'].includes(role)) {
      return res.status(400).json({ error: "Invalid role" });
    }

    const result = await usersCollection.updateOne(
      { _id: new ObjectId(userId) },
      { $set: { role } }
    );

    if (result.matchedCount === 0) {
      return res.status(404).json({ error: "User not found" });
    }

    res.json({ success: true, message: `User role updated to ${role}` });
  } catch (error) {
    console.error("Error updating user role:", error);
    res.status(500).json({ error: "Failed to update user role" });
  }
});

// Get all users (for admin)
app.get("/api/users", async (req, res) => {
  try {
    let users = await usersCollection.find({}, {
      projection: {
        _id: 1,
        email: 1,
        displayName: 1,
        photoURL: 1,
        membership: 1,
        badge: 1,
        role: 1,
        createdAt: 1,
        lastLogin: 1
      }
    }).sort({ createdAt: -1 }).toArray();
    
    // Ensure all users have a role (default to 'member' if not set)
    users = users.map(user => ({
      ...user,
      role: user.role || 'member'
    }));
    
    // Map the results to include id as a string
    const usersWithId = users.map(user => ({
      ...user,
      id: user._id.toString()
    }));
    
    res.json(usersWithId);
  } catch (error) {
    console.error("Error fetching users:", error);
    res.status(500).json({ error: "Failed to fetch users" });
  }
});

// Get user profile by email
app.get("/api/users/profile", async (req, res) => {
  try {
    const { email } = req.query;
    if (!email) {
      return res.status(400).json({ error: "Email is required" });
    }
    const user = await usersCollection.findOne({ email });
    if (!user) {
      // Create a default user profile if it doesn't exist
      const defaultUser = {
        email,
        displayName: email.split("@")[0], // Use email prefix as display name
        photoURL: "/default-avatar.svg",
        membership: "free",
        badge: "bronze",
        membershipUpgradedAt: null,
        createdAt: new Date(),
      };
      const result = await usersCollection.insertOne(defaultUser);
      defaultUser._id = result.insertedId;
      return res.json(defaultUser);
    }
    res.json(user);
  } catch (error) {
    console.error("Error fetching user profile:", error);
    res.status(500).json({ error: "Failed to fetch user profile" });
  }
});

// Create or update user profile
app.post("/api/users/profile", async (req, res) => {
  try {
    const { email, displayName, photoURL } = req.body;
    if (!email) {
      return res.status(400).json({ error: "Email is required" });
    }

    const updateData = {
      email,
      displayName: displayName || email.split("@")[0],
      photoURL: photoURL || "/default-avatar.svg",
      membership: "free",
      badge: null,
      membershipUpgradedAt: null,
      updatedAt: new Date(),
    };

    // If user doesn't exist, add createdAt
    const existingUser = await usersCollection.findOne({ email });
    if (!existingUser) {
      updateData.createdAt = new Date();
    }

    const result = await usersCollection.updateOne(
      { email },
      { $set: updateData },
      { upsert: true }
    );

    res.json({
      message: "User profile updated successfully",
      user: updateData,
    });
  } catch (error) {
    console.error("Error updating user profile:", error);
    res.status(500).json({ error: "Failed to update user profile" });
  }
});

// Test endpoint
app.get("/test", (req, res) => {
  res.send("Server is running");
});

// Test MongoDB connection
app.get("/test-mongo", async (req, res) => {
  try {
    const count = await postsCollection.countDocuments({});
    res.json({
      success: true,
      postCount: count,
      message: `Successfully connected to MongoDB. Found ${count} posts.`
    });
  } catch (error) {
    console.error('MongoDB test error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to connect to MongoDB',
      details: error.message
    });
  }
});

// Sample route
app.get("/", (req, res) => {
  res.send("QckTlk Forum Server is running with mock data!");
});

// Admin routes
app.use('/api/admin', adminRoutes);

// Start the server
app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
}) ;
