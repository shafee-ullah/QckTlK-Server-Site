const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");
const { MongoClient, ServerApiVersion } = require("mongodb");
const { ObjectId } = require("mongodb");

// Load environment variables from .env file
dotenv.config();
const stripe = require("stripe")(process.env.PAYMENT_GATEWAY_KEY);
const app = express();
const port = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

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
    await client.connect();
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

// Get all posts with search, filter, sort, and pagination
app.get("/posts", async (req, res) => {
  try {
    const {
      search = "",
      tag = "",
      author = "",
      startDate = "",
      endDate = "",
      sort = "new",
      page = 1,
      limit = 10,
      lastId = null,
    } = req.query;
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

    // For infinite scroll, use cursor-based pagination
    if (lastId) {
      query._id = { $lt: new ObjectId(lastId) };
    }

    let cursor = postsCollection.find(query);
    if (sort === "new") {
      cursor = cursor.sort({ postTime: -1 });
    } else if (sort === "popular") {
      cursor = cursor.sort({ upVote: -1, downVote: 1 });
    }
    const total = await cursor.count();
    const paginatedPosts = await cursor.limit(Number(limit)).toArray();
    res.json({
      data: paginatedPosts,
      total,
      hasMore: paginatedPosts.length === Number(limit),
      lastId:
        paginatedPosts.length > 0
          ? paginatedPosts[paginatedPosts.length - 1]._id
          : null,
    });
  } catch (error) {
    console.error("Error fetching posts:", error);
    res.status(500).json({ error: "Failed to fetch posts" });
  }
});

// Create a new post with post limit logic
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

// Add comment to a post
app.post("/posts/:id/comments", async (req, res) => {
  try {
    const postId = req.params.id;
    const { comment } = req.body;

    if (!comment || !comment.trim()) {
      return res.status(400).json({ error: "Comment is required" });
    }

    const newComment = {
      postId: new ObjectId(postId),
      comment: comment.trim(),
      authorName: "Current User", // In real app, get from auth
      authorEmail: "user@example.com",
      authorImage:
        "https://images.unsplash.com/photo-1472099645785-5658abf4ff4e?w=150&h=150&fit=crop&crop=face",
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
    const postId = req.params.id;
    const { voteType } = req.body; // 'upvote' or 'downvote'

    if (!["upvote", "downvote"].includes(voteType)) {
      return res.status(400).json({ error: "Invalid vote type" });
    }

    const post = await postsCollection.findOne({ _id: new ObjectId(postId) });
    if (!post) {
      return res.status(404).json({ error: "Post not found" });
    }

    // In a real app, you'd check if user already voted
    // For now, just update the vote counts
    if (voteType === "upvote") {
      await postsCollection.updateOne(
        { _id: new ObjectId(postId) },
        { $inc: { upVote: 1 } }
      );
      await postsCollection.updateOne(
        { _id: new ObjectId(postId) },
        { $set: { userVote: "upvote" } }
      );
    } else {
      await postsCollection.updateOne(
        { _id: new ObjectId(postId) },
        { $inc: { downVote: 1 } }
      );
      await postsCollection.updateOne(
        { _id: new ObjectId(postId) },
        { $set: { userVote: "downvote" } }
      );
    }

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
app.post("/create-payment-intent", async (req, res) => {
  try {
    const { amount } = req.body;
    // Mock response for development
    res.send({ clientSecret: "pi_mock_client_secret_for_development" });
  } catch (error) {
    console.error("Error creating payment intent:", error);
    res.status(500).json({ error: "Failed to create payment intent" });
  }
});

// Store a payment record
app.post("/api/payments", async (req, res) => {
  try {
    const { email, amount, status, paymentIntentId, date } = req.body;
    if (!email || !amount || !status || !paymentIntentId) {
      return res.status(400).json({ error: "Missing required payment fields" });
    }
    const payment = {
      email,
      amount,
      status,
      paymentIntentId,
      date: date ? new Date(date) : new Date(),
    };
    await paymentsCollection.insertOne(payment);
    res.json({ message: "Payment recorded" });
  } catch (error) {
    console.error("Error saving payment:", error);
    res.status(500).json({ error: "Failed to save payment" });
  }
});

// Get payment history for a user
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
        badge: null,
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

// Sample route
app.get("/", (req, res) => {
  res.send("QckTlk Forum Server is running with mock data!");
});

// Start the server
app.listen(port, () => {
  console.log(`Server is listening on port ${port}`);
  console.log("Using mock data for development");
});
